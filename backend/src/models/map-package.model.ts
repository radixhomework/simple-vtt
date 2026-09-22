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
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
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

function floorRef(ref: string | undefined): string | undefined {
  return ref || undefined
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

  const floors = db.prepare('SELECT id, level, name, grid_size, uvt_metadata, map_offset_x, map_offset_y, map_image_path, tiles_path, revealed FROM floors WHERE table_id=? ORDER BY level, rowid').all(tableId) as Array<{
    id: string; level: number; name: string; grid_size: number; uvt_metadata: string
    map_offset_x: number; map_offset_y: number; map_image_path: string; tiles_path: string; revealed: number
  }>
  const tokens = db.prepare('SELECT * FROM tokens WHERE table_id=?').all(tableId) as Array<{
    id: string; name: string; x: number; y: number; icon_path: string; has_vision: number
    vision_radius: number; size: number; color: string; owner: string; hidden: number; floor_id: string
  }>
  const portals = db.prepare('SELECT * FROM portals WHERE table_id=?').all(tableId) as Array<{
    id: string; x1: number; y1: number; x2: number; y2: number; closed: number; kind: string; locked: number; floor_id: string
  }>
  const walls = db.prepare('SELECT * FROM walls WHERE table_id=?').all(tableId) as Array<{
    id: string; ax: number; ay: number; bx: number; by: number; group_id: string; floor_id: string
  }>
  const props = db.prepare('SELECT * FROM props WHERE table_id=?').all(tableId) as Array<{
    id: string; asset_path: string; name: string; x: number; y: number; size: number
    rotation: number; z: number; opacity: number; group_id: string; floor_id: string
  }>
  const stairs = db.prepare('SELECT from_floor, to_floor, from_x, from_y, to_x, to_y, radius FROM stairs WHERE table_id=?').all(tableId) as Array<{
    from_floor: string; to_floor: string; from_x: number; from_y: number; to_x: number; to_y: number; radius: number
  }>
  const members = db.prepare('SELECT username, role FROM map_members WHERE table_id=? ORDER BY role, username').all(tableId) as Array<{
    username: string; role: string
  }>

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
  for (const f of floors) {
    levelIdx++
    const ref = newId()
    floorRefByOld.set(f.id, ref)
    const entry: MapPackageManifest['floors'][number] = {
      ref,
      level: f.level,
      name: f.name,
      grid_size: f.grid_size,
      uvt_metadata: f.uvt_metadata,
      map_offset_x: f.map_offset_x,
      map_offset_y: f.map_offset_y,
      revealed: f.revealed === 1,
    }
    if (f.map_image_path) {
      entry.image = `floors/floor-${levelIdx}.png`
      zip.addFile(entry.image, fs.readFileSync(uploadsFilePath(f.map_image_path)))
    }
    const maskFile = path.join(uploadsDir(), `fog_${f.id}.png`)
    if (fs.existsSync(maskFile)) {
      entry.fogMask = `masks/floor-${levelIdx}.png`
      zip.addFile(entry.fogMask, fs.readFileSync(maskFile))
    }
    floorEntries.push(entry)
  }

  const iconZipByOld = new Map<string, string>()
  for (const t of tokens) {
    if (t.icon_path && !iconZipByOld.has(t.icon_path)) {
      iconZipByOld.set(t.icon_path, addLibraryAsset(t.icon_path))
    }
  }
  for (const pr of props) {
    if (pr.asset_path && !iconZipByOld.has(pr.asset_path)) {
      iconZipByOld.set(pr.asset_path, addLibraryAsset(pr.asset_path))
    }
  }

  const manifest: MapPackageManifest = {
    format: PACKAGE_FORMAT,
    kind: 'map',
    name: table.name,
    floors: floorEntries,
    tokens: tokens.map(t => ({
      ...t,
      floorRef: floorRefByOld.get(t.floor_id) ?? '',
      icon: t.icon_path ? iconZipByOld.get(t.icon_path) : undefined,
    })),
    portals: portals.map(p => ({ ...p, floorRef: floorRefByOld.get(p.floor_id) ?? '' })),
    walls: walls.map(w => ({ ...w, floorRef: floorRefByOld.get(w.floor_id) ?? '' })),
    props: (props as Array<Record<string, unknown>>).map(p => ({
      ...p,
      floorRef: floorRefByOld.get(String(p.floor_id)) ?? '',
      asset: p.asset_path ? iconZipByOld.get(String(p.asset_path)) : undefined,
    })),
    stairs: stairs.map(st => ({
      fromRef: floorRefByOld.get(st.from_floor) ?? '',
      toRef: floorRefByOld.get(st.to_floor) ?? '',
      from_x: Number(st.from_x), from_y: Number(st.from_y),
      to_x: Number(st.to_x), to_y: Number(st.to_y),
      radius: Number(st.radius ?? 1),
    })),
    members,
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

  const zipPathByOld = registerPackageAssets(zip, manifest, counts)
  const rewrite = (zipPath: string | undefined): string | undefined => (zipPath ? zipPathByOld.get(zipPath) : undefined)

  db.prepare('INSERT INTO tables (id, name, owner) VALUES (?,?,?)').run(tableId, tableName, owner)
  db.prepare("INSERT INTO map_members (table_id, username, role) VALUES (?,?,'dm')").run(tableId, owner)

  const floorMap = applyPackageFloors(zip, manifest, tableId, counts)
  applyPackageTokens(zip, manifest, tableId, counts, rewrite)
  applyPackagePortals(zip, manifest, tableId, counts, rewrite)
  applyPackageWalls(zip, manifest, tableId, counts, rewrite)
  applyPackageProps(zip, manifest, tableId, counts, rewrite)
  applyPackageStairs(zip, manifest, tableId, counts)
  applyPackageMembers(manifest.members, tableId, owner)
  void floorMap

  return { tableId, ...counts }
}


interface RawFloor {
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
}

interface RawToken {
  name?: string
  x?: number
  y?: number
  icon?: string
  has_vision?: boolean
  vision_radius?: number
  size?: number
  color?: string
  owner?: string
  hidden?: boolean
  floorRef: string
}

interface RawPortal {
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  closed?: boolean
  kind?: string
  locked?: boolean
  floorRef: string
}

interface RawWall {
  ax?: number
  ay?: number
  bx?: number
  by?: number
  group_id?: string
  floorRef: string
}

interface RawProp {
  asset?: string
  name?: string
  x?: number
  y?: number
  size?: number
  rotation?: number
  z?: number
  opacity?: number
  group_id?: string
  floorRef: string
}

interface RawStair {
  fromRef: string
  toRef: string
  from_x: number
  from_y: number
  to_x: number
  to_y: number
  radius: number
}

function registerPackageAssets(
  zip: AdmZip,
  manifest: MapPackageManifest,
  counts: { assetsAdded: number; assetsReused: number },
): Map<string, string> {
  const zipPathByRef = new Map<string, string>()
  for (const a of manifest.assets) {
    const entry = zip.getEntry(a.zipPath)
    if (!entry) continue
    const existing = db.prepare('SELECT id, path FROM assets WHERE hash=? AND kind=?').get(a.hash, 'image') as
      | { id: string; path: string }
      | undefined
    if (existing) {
      zipPathByRef.set(a.zipPath, existing.path)
      counts.assetsReused++
      continue
    }
    const buf = entry.getData()
    const newId = newPackageId()
    const fileUrl = `/uploads/asset_${newId}${a.ext}`
    fs.writeFileSync(path.join(uploadsDir(), path.basename(fileUrl)), buf)
    db.prepare('INSERT INTO assets (id, kind, name, hash, path, size, folder) VALUES (?,?,?,?,?,?,?)')
      .run(newId, 'image', a.name, a.hash, fileUrl, buf.length, a.folder)
    zipPathByRef.set(a.zipPath, fileUrl)
    counts.assetsAdded++
  }
  return zipPathByRef
}

function applyPackageFloors(
  zip: AdmZip,
  manifest: MapPackageManifest,
  tableId: string,
  counts: { floors: number },
  rewrite: (zipPath: string | undefined) => string | undefined,
): Map<string, string> {
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
        imagePath = `/uploads/map_${newId}${ext}`
        fs.writeFileSync(path.join(uploadsDir(), path.basename(imagePath)), imageBuf)
      }
    }
    db.prepare(
      `INSERT INTO floors (id, table_id, level, name, map_image_path, grid_size, uvt_metadata, map_offset_x, map_offset_y, img_width, img_height, tiles_path, revealed)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,'',?)`
    ).run(newId, tableId, f.level, f.name, imagePath, f.grid_size, f.uvt_metadata, f.map_offset_x, f.map_offset_y, f.revealed ? 1 : 0)
    counts.floors++
    if (imageBuf) {
      // Fire-and-forget: the pyramid appears a few seconds after import
      void buildTilePyramid(newId, imageBuf).catch(() => {})
    }
  }
  return floorMap
}

function applyPackageTokens(
  zip: AdmZip,
  manifest: MapPackageManifest,
  tableId: string,
  counts: { tokens: number },
  rewrite: (zipPath: string | undefined) => string | undefined,
): void {
  for (const t of manifest.tokens) {
    db.prepare(
      `INSERT INTO tokens (id, table_id, name, x, y, icon_path, has_vision, vision_radius, size, color, owner, hidden, floor_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      newPackageId(), tableId, t.name ?? '', Number(t.x ?? 0), Number(t.y ?? 0),
      rewrite(t.icon) ?? '', t.has_vision ? 1 : 0, Number(t.vision_radius ?? 6),
      Number(t.size ?? 0.75), t.color ?? '#4a90d9', t.owner ?? '', t.hidden ? 1 : 0,
      floorRef(t.floorRef),
    )
    counts.tokens++
  }
}

function applyPackagePortals(
  zip: AdmZip,
  manifest: MapPackageManifest,
  tableId: string,
  counts: { portals: number },
  rewrite: (zipPath: string | undefined) => string | undefined,
): void {
  for (const p of manifest.portals) {
    db.prepare(
      'INSERT INTO portals (id, table_id, x1, y1, x2, y2, closed, floor_id, kind, locked) VALUES (?,?,?,?,?,?,?,?,?,0)'
    ).run(
      newPackageId(), tableId, Number(p.x1 ?? 0), Number(p.y1 ?? 0), Number(p.x2 ?? 0), Number(p.y2 ?? 0),
      p.closed === false ? 0 : 1, floorRef(p.floorRef), p.kind === 'window' ? 'window' : 'door',
    )
    counts.portals++
  }
}

function applyPackageWalls(
  zip: AdmZip,
  manifest: MapPackageManifest,
  tableId: string,
  counts: { walls: number },
  rewrite: (zipPath: string | undefined) => string | undefined,
): void {
  for (const w of manifest.walls) {
    db.prepare('INSERT INTO walls (id, table_id, floor_id, ax, ay, bx, by, group_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(newPackageId(), tableId, floorRef(w.floorRef), Number(w.ax ?? 0), Number(w.ay ?? 0), Number(w.bx ?? 0), Number(w.by ?? 0), w.group_id ?? '')
    counts.walls++
  }
}

function applyPackageProps(
  zip: AdmZip,
  manifest: MapPackageManifest,
  tableId: string,
  counts: { props: number },
  rewrite: (zipPath: string | undefined) => string | undefined,
): void {
  for (const pr of manifest.props) {
    db.prepare(
      'INSERT INTO props (id, table_id, floor_id, asset_path, name, x, y, size, rotation, z, opacity, group_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
    ).run(
      newPackageId(), tableId, floorRef(pr.floorRef) ?? '',
      rewrite(pr.asset) ?? '', pr.name ?? '', Number(pr.x ?? 0), Number(pr.y ?? 0),
      Number(pr.size ?? 70), Number(pr.rotation ?? 0), Number(pr.z ?? 0), Number(pr.opacity ?? 1), pr.group_id ?? '',
    )
    counts.props++
  }
}

function applyPackageStairs(
  zip: AdmZip,
  manifest: MapPackageManifest,
  tableId: string,
  counts: { stairs: number },
): void {
  for (const st of manifest.stairs) {
    const from = floorRef(st.fromRef)
    const to = floorRef(st.toRef)
    if (!from || !to) continue
    db.prepare('INSERT INTO stairs (id, table_id, from_floor, from_x, from_y, to_floor, to_x, to_y, radius) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(newPackageId(), tableId, from, Number(st.from_x ?? 0), Number(st.from_y ?? 0), to, Number(st.to_x ?? 0), Number(st.to_y ?? 0), Number(st.radius ?? 1))
    counts.stairs++
  }
}

function applyPackageMembers(
  members: Array<{ username: string; role: string }>,
  tableId: string,
  owner: string,
): void {
  for (const m of members) {
    if (m.username === owner) continue
    if (userExists(m.username)) setMember(tableId, m.username, m.role === 'dm' ? 'dm' : 'player')
  }
}
