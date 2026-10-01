/**
 * Blob-storage abstraction (task 1.1). Two drivers behind one interface,
 * selected by STORAGE_DRIVER (local = filesystem under UPLOADS_DIR, the
 * historical behavior; s3 = any S3-compatible endpoint via aws-sdk).
 *
 * Keys are the DB's URL paths minus the `/uploads/` prefix — e.g.
 * `asset_<id>.webp`, `map_<id>.png`, `fog_<floorId>.png`,
 * `tiles/<floorId>/0/0_0.jpg`. The database never changes format.
 */
import fs from 'node:fs'
import path from 'node:path'
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'

export interface StorageDriver {
  /** Store a blob under the given key. */
  put(key: string, data: Buffer): Promise<void>
  /** Read a whole blob (server-side consumers: ZIP assembly, sharp, hashing). */
  get(key: string): Promise<Buffer>
  /** Read a blob as a stream (serving route — pipes without buffering). */
  getStream(key: string): Promise<NodeJS.ReadableStream>
  /** Delete a blob (missing object is not an error). */
  delete(key: string): Promise<void>
  /** Whether the object exists. */
  exists(key: string): Promise<boolean>
}

// ── Local driver: byte-identical to the pre-abstraction behavior ──────────────
class LocalStorageDriver implements StorageDriver {
  private dir() {
    return process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')
  }
  private filePath(key: string): string {
    return path.join(this.dir(), key)
  }
  async put(key: string, data: Buffer): Promise<void> {
    const p = this.filePath(key)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, data)
  }
  async get(key: string): Promise<Buffer> {
    return fs.readFileSync(this.filePath(key))
  }
  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    return fs.createReadStream(this.filePath(key))
  }
  async delete(key: string): Promise<void> {
    fs.unlink(this.filePath(key), () => {})
  }
  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.filePath(key))
  }
}

// ── S3 driver: MinIO / AWS / any S3-compatible endpoint ───────────────────────
class S3StorageDriver implements StorageDriver {
  private client: S3Client
  private bucket: string

  constructor() {
    this.bucket = process.env.S3_BUCKET || 'simple-vtt'
    this.client = new S3Client({
      endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
      region: process.env.S3_REGION || 'us-east-1',
      forcePathStyle: true, // MinIO-style path addressing
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY || '',
        secretAccessKey: process.env.S3_SECRET_KEY || '',
      },
    })
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data }))
  }
  async get(key: string): Promise<Buffer> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return Buffer.from(await r.Body!.transformToByteArray())
  }
  async getStream(key: string): Promise<NodeJS.ReadableStream> {
    const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return r.Body as unknown as NodeJS.ReadableStream
  }
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (e: unknown) {
      const name = (e as { name?: string }).name
      if (name === 'NotFound' || name === 'NoSuchKey') return false
      throw e
    }
  }
}

let driver: StorageDriver | null = null

/** The active storage driver (process-lifetime singleton). */
export function storage(): StorageDriver {
  if (!driver) {
    driver = (process.env.STORAGE_DRIVER || 'local') === 's3'
      ? new S3StorageDriver()
      : new LocalStorageDriver()
  }
  return driver
}

/** DB URL path (`/uploads/<key>`) → storage key. */
export function keyOf(urlPath: string): string {
  return urlPath.replace(/^\/uploads\//, '')
}
