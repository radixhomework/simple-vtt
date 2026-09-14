/**
 * MODEL — map package build/apply: export/import of a single map with all
 * floors, entities, fog masks and the shared-library images it references.
 *
 * A package is a ZIP: manifest.json + floors/ (map images) + masks/ (fog
 * masks) + assets/ (referenced shared images, keyed by content hash).
 * Apply re-registers those assets into the shared library with content-hash
 * dedup (existing hashes are reused, never re-stored).
 */
import AdmZip from 'adm-zip'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { db } from '../db'
import { buildTilePyramid } from '../tiles'

const uploadsDir = () => process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
const userExists = (username: string) => !!db.prepare('SELECT username FROM users WHERE username=?').get(username)
const setMember = (tableId: string, username: string, role: string) =>
  db.prepare('INSERT INTO map_members (table_id, username, role) VALUES (?,?,?) ON CONFLICT(table_id, username) DO UPDATE SET role=excluded.role').run(tableId, username, role)

export interface PackageAsset {
  hash: string
  zipPath: string
  ext: string
  folder: string
  name: string
}

export interface MapPackageManifest {
  format: number
  kind: 'map'
  name: string
  floors: Array<{
    ref: string
    level: number
    name: string
    grid_size: number
    uvt_metadata: string
    map_offset_x: number
    map_offset_y: number
    revealed: boolean
    image?: string
    fogMask?: string
  }>
  tokens: Array<Record<string, unknown> & { floorRef: string; icon?: string }>
  portals: Array<Record<string, unknown> & { floorRef: string }>
  walls: Array<Record<string, unknown> & { floorRef: string }>
  props: Array<Record<string, unknown> & { floorRef: string; asset?: string }>
  stairs: Array<{ fromRef: string; toRef: string; from_x: number; from_y: number; to_x: number; to_y: number; radius: number }>
  members: Array<{ username: string; role: string }>
  assets: PackageAsset[]
}

export const PACKAGE_FORMAT = 1

export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

export function newPackageId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

export interface ApplyMapResult {
  tableId: string
  floors: number
  tokens: number
  portals: number
  walls: number
  props: number
  stairs: number
  assetsAdded: number
  assetsReused: number
}

export function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function uploadsFilePath(urlPath: string): string {
  return path.join(uploadsDir(), path.basename(urlPath))
}

/** Collect every shared-library image referenced by a map (token icons + props). */
export function referencedAssetPaths(tableId: string): string[] {
  const paths = new Set<string>()
  for (const t of db.prepare('SELECT icon_path FROM tokens WHERE table_id=? AND icon_path<>\'\'').all(tableId) as Array<{ icon_path: string }>) {
    paths.add(t.icon_path)
  }
  for (const p of db.prepare('SELECT asset_path FROM props WHERE table_id=? AND asset_path<>\'\'').all(tableId) as Array<{ asset_path: string }>) {
    paths.add(p.asset_path)
  }
  return [...paths]
}

/** Library metadata for an uploads path (fallbacks when not registered). */
export function assetMetaFor(urlPath: string): Omit<PackageAsset, 'zipPath'> {
  const row = db.prepare('SELECT hash, folder, name FROM assets WHERE path=?').get(urlPath) as
    | { hash: string; folder: string; name: string }
    | undefined
  const ext = path.extname(urlPath).toLowerCase()
  const buf = fs.readFileSync(uploadsFilePath(urlPath))
  const base = path.basename(urlPath, path.extname(urlPath))
  return {
    hash: row?.hash && row.hash !== '' ? row.hash : sha256(buf),
    ext,
    folder: row?.folder ?? '',
    name: row?.name ?? base,
  }
}

/** Build the map package ZIP for a table (throws on missing files). */
export function buildMapPackage(tableId: string, tableName: string): Buffer {
  const table = db.prepare('SELECT id, name, owner, default_floor_id FROM tables WHERE id=?').get(tableId) as
    | { id: string; name: string; owner: string; default_floor_id: string }
    | undefined
  if (!table) throw new Error('table not found')

  const floors = db.prepare('SELECT id, level, name, grid_size, uvt_metadata, map_offset_x, map_offset_y, map_image_path, tiles_path, revealed FROM floors WHERE table_id=? ORDER BY level, rowid').all(tableId) as Array<Record<string, unknown>>
  const tokens = db.prepare('SELECT * FROM tokens WHERE table_id=?').all(tableId)
  const portals = db.prepare('SELECT * FROM portals WHERE table_id=?').all(tableId)
  const walls = db.prepare('SELECT * FROM walls WHERE table_id=?').all(tableId)
  const props = db.prepare('SELECT * FROM props WHERE table_id=?').all(tableId)
  const stairs = db.prepare('SELECT from_floor, to_floor, from_x, from_y, to_x, to_y, radius FROM stairs WHERE table_id=?').all(tableId)
  const members = db.prepare('SELECT username, role FROM map_members WHERE table_id=? ORDER BY role, username').all(tableId)

  const zip = new AdmZip()
  const assets: Array<Omit<PackageAsset, 'zipPath'> & { zipPath: string }> = []
  const usedHashes = new Set<string>()

  const addLibraryAsset = (urlPath: string): string => {
    const meta = assetMetaFor(urlPath)
    let zipPath = `assets/${meta.hash}${meta.ext}`
    if (usedHashes.has(meta.hash)) return zipPath
    usedHashes.add(meta.hash)
    const buf = fs.readFileSync(uploadsFilePath(urlPath))
    zip.addFile(zipPath, buf)
    assets.push({ ...meta, zipPath })
    return zipPath
  }

  const floorRefByOld = new Map<string, string>()
  const floorEntries: MapPackageManifest['floors'] = []
  let levelIdx = 0
  for (const f of floors as Array<Record<string, unknown>>) {
    levelIdx++
    const ref = newId()
    floorRefByOld.set(String(f.id), ref)
    const entry: MapPackageManifest['floors'][number] = {
      ref,
      level: Number(f.level),
      name: String(f.name ?? ''),
      grid_size: Number(f.grid_size),
      uvt_metadata: String(f.uvt_metadata ?? '{}'),
      map_offset_x: Number(f.map_offset_x ?? 0),
      map_offset_y: Number(f.map_offset_y ?? 0),
      revealed: Number(f.revealed) === 1,
    }
    if (f.map_image_path) {
      entry.image = `floors/floor-${levelIdx}.png`
      zip.addFile(entry.image, fs.readFileSync(uploadsFilePath(String(f.map_image_path))))
    }
    const maskFile = path.join(uploadsDir(), `fog_${String(f.id)}.png`)
    if (fs.existsSync(maskFile)) {
      entry.fogMask = `masks/floor-${levelIdx}.png`
      zip.addFile(entry.fogMask, fs.readFileSync(maskFile))
    }
    floorEntries.push(entry)
  }

  const iconZipByOld = new Map<string, string>()
  for (const t of tokens as Array<Record<string, unknown>>) {
    if (t.icon_path && !iconZipByOld.has(String(t.icon_path))) {
      iconZipByOld.set(String(t.icon_path), addLibraryAsset(String(t.icon_path)))
    }
  }
  for (const pr of props as Array<Record<string, unknown>>) {
    if (pr.asset_path && !iconZipByOld.has(String(pr.asset_path))) {
      iconZipByOld.set(String(pr.asset_path), addLibraryAsset(String(pr.asset_path)))
    }
  }

  const manifest: MapPackageManifest = {
    format: PACKAGE_FORMAT,
    kind: 'map',
    name: table.name,
    floors: floorEntries,
    tokens: (tokens as Array<Record<string, unknown>>).map(t => ({
      ...t,
      floorRef: floorRefByOld.get(String(t.floor_id)) ?? '',
      icon: t.icon_path ? iconZipByOld.get(String(t.icon_path)) : undefined,
    })),
    portals: (portals as Array<Record<string, unknown>>).map(p => ({ ...p, floorRef: floorRefByOld.get(String(p.floor_id)) ?? '' })),
    walls: (walls as Array<Record<string, unknown>>).map(w => ({ ...w, floorRef: floorRefByOld.get(String(w.floor_id)) ?? '' })),
    props: (props as Array<Record<string, unknown>>).map(p => ({
      ...p,
      floorRef: floorRefByOld.get(String(p.floor_id)) ?? '',
      asset: p.asset_path ? iconZipByOld.get(String(p.asset_path)) : undefined,
    })),
    stairs: (stairs as Array<Record<string, unknown>>).map(st => ({
      fromRef: floorRefByOld.get(String(st.from_floor)) ?? '',
      toRef: floorRefByOld.get(String(st.to_floor)) ?? '',
      from_x: Number(st.from_x), from_y: Number(st.from_y),
      to_x: Number(st.to_x), to_y: Number(st.to_y),
      radius: Number(st.radius ?? 1),
    })),
    members: members as Array<{ username: string; role: string }>,
    assets,
  }
  zip.addFile('manifest.json', JSON.stringify(manifest))
  return zip.toBuffer()
}

/** Apply an uploaded map package: create the table + everything it carries.
 *  Returns the new table id. Only users that exist locally keep membership;
 *  the applying user always becomes dm/owner. */
export function applyMapPackage(
  zip: AdmZip,
  manifest: MapPackageManifest,
  tableName: string,
  owner: string,
): ApplyMapResult {
  const tableId = newPackageId()
  const counts = { floors: 0, tokens: 0, portals: 0, walls: 0, props: 0, stairs: 0, assetsAdded: 0, assetsReused: 0 }

  // Register referenced assets first (content-hash dedup), collect path rewrites
  const zipPathByOld = new Map<string, string>()
  for (const a of manifest.assets) {
    const entry = zip.getEntry(a.zipPath)
    if (!entry) continue
    const buf = entry.getData()
    const existing = db.prepare('SELECT id, path FROM assets WHERE hash=? AND kind=?').get(a.hash, 'image') as
      | { id: string; path: string }
      | undefined
    if (existing) {
      zipPathByOld.set(a.zipPath, existing.path)
      counts.assetsReused++
      continue
    }
    const newId = newPackageId()
    const fileUrl = `/uploads/asset_${newId}${a.ext}`
    fs.writeFileSync(path.join(uploadsDir(), path.basename(fileUrl)), buf)
    db.prepare('INSERT INTO assets (id, kind, name, hash, path, size, folder) VALUES (?,?,?,?,?,?,?)')
      .run(newId, 'image', a.name, a.hash, fileUrl, buf.length, a.folder)
    zipPathByOld.set(a.zipPath, fileUrl)
    counts.assetsAdded++
  }
  const rewrite = (p: unknown): string | undefined => {
    if (typeof p !== 'string' || p === '') return undefined
    return zipPathByOld.get(p)
  }

  db.prepare('INSERT INTO tables (id, name, owner) VALUES (?,?,?)').run(tableId, tableName, owner)
  db.prepare("INSERT INTO map_members (table_id, username, role) VALUES (?,?,'dm')").run(tableId, owner)

  const floorMap = new Map<string, string>()
  for (const f of manifest.floors) {
    const newId = newPackageId()
    floorMap.set(f.ref, newId)
    let imagePath = ''
    let imageBuf: Buffer | null = null
    if (f.image) {
      const entry = zip.getEntry(f.image)
      if (entry) {
        imageBuf = entry.getData()
        const ext = path.extname(f.image) || '.png'
        const fileUrl = `/uploads/map_${newId}${ext}`
        fs.writeFileSync(path.join(uploadsDir(), path.basename(fileUrl)), imageBuf)
        imagePath = fileUrl
      }
    }
    db.prepare(
      `INSERT INTO floors (id, table_id, level, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y, img_width, img_height, tiles_path, revealed)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,'',?)`
    ).run(newId, tableId, f.level, f.name, imagePath, f.grid_size, f.uvt_metadata, f.map_offset_x, f.map_offset_y, f.revealed ? 1 : 0)
    counts.floors++
    if (imageBuf && imagePath) {
      // Fire-and-forget: same pattern as the upload routes — the pyramid
      // appears a few seconds later without blocking the import response
      void buildTilePyramid(newId, imageBuf).catch(() => {})
    }
  }

  for (const t of manifest.tokens) {
    db.prepare(
      `INSERT INTO tokens (id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden, floor_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      newPackageId(), tableId, String(t.name ?? ''), Number(t.x ?? 0), Number(t.y ?? 0),
      rewrite(t.icon) ?? '', t.has_vision ? 1 : 0, Number(t.vision_radius ?? 6),
      Number(t.size ?? 0.75), String(t.color ?? '#4a90d9'), String(t.owner ?? ''), t.hidden ? 1 : 0,
      floorMap.get(String(t.floorRef)) ?? '',
    )
    counts.tokens++
  }

  for (const p of manifest.portals) {
    db.prepare(
      'INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed, floor_id, kind, locked) VALUES (?,?,?,?,?,?,?,?,?,0)'
    ).run(newPackageId(), tableId, Number(p.x1), Number(p.y1), Number(p.x2), Number(p.y2), p.closed ? 1 : 0, floorMap.get(String(p.floorRef)) ?? '', p.kind === 'window' ? 'window' : 'door')
    counts.portals++
  }

  for (const w of manifest.walls) {
    db.prepare('INSERT INTO walls (id, table_id, floor_id, ax, ay, bx, by, group_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(newPackageId(), tableId, floorMap.get(String(w.floorRef)) ?? '', Number(w.ax), Number(w.ay), Number(w.bx), Number(w.by), String(w.group_id ?? ''))
    counts.walls++
  }

  for (const pr of manifest.props) {
    db.prepare(
      'INSERT INTO props (id, table_id, floor_id, asset_path, name, x, y, size, rotation, z, opacity, group_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      newPackageId(), tableId, floorMap.get(String(pr.floorRef)) ?? '',
      rewrite(pr.asset) ?? '', String(pr.name ?? ''), Number(pr.x ?? 0), Number(pr.y ?? 0),
      Number(pr.size ?? 70), Number(pr.rotation ?? 0), Number(pr.z ?? 0), Number(pr.opacity ?? 1), String(pr.group_id ?? ''),
    )
    counts.props++
  }

  for (const st of manifest.stairs) {
    if (!floorMap.get(st.fromRef) || !floorMap.get(st.toRef)) continue
    db.prepare('INSERT INTO stairs (id, table_id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newPackageId(), tableId, floorMap.get(st.fromRef) ?? '', st.from_x, st.from_y, floorMap.get(st.toRef) ?? '', st.to_x, st.to_y, st.radius)
    counts.stairs++
  }

  for (const m of manifest.members) {
    if (m.username === owner) continue
    if (userExists(m.username)) setMember(tableId, m.username, m.role === 'dm' ? 'dm' : 'player')
  }

  return { tableId, ...counts }
}
