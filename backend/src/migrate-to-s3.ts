/**
 * One-time migration: copy every blob from the local uploads volume into
 * the configured S3 bucket (task 3.1). Idempotent — objects already present
 * are skipped. The local directory is left untouched as a fallback.
 *
 * Run: docker compose exec app node dist/migrate-to-s3.js
 * Requires STORAGE_DRIVER=s3 (or S3_* envs set — the driver is forced here).
 */
process.env.STORAGE_DRIVER = 's3'

import fs from 'node:fs'
import path from 'node:path'
import { storage, keyOf } from './storage'

const uploadsDir = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads')

async function main(): Promise<void> {
  if ((process.env.STORAGE_DRIVER || '') !== 's3') {
    console.error('S3_* configuration missing — refusing to migrate into the local driver')
    process.exit(1)
  }
  if (!fs.existsSync(uploadsDir)) {
    console.error(`local uploads dir not found: ${uploadsDir}`)
    process.exit(1)
  }

  let copied = 0
  let skipped = 0
  let failed = 0

  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = String(e.name)
      const full = path.join(dir, name)
      const key = prefix ? `${prefix}/${name}` : name
      if (e.isDirectory()) {
        await walk(full, key)
        continue
      }
      try {
        if (await storage().exists(key)) {
          skipped++
          continue
        }
        await storage().put(key, fs.readFileSync(full))
        copied++
      } catch (err) {
        failed++
        console.error(`[migrate] failed: ${key}`, err)
      }
    }
  }

  console.log(`migrating blobs from ${uploadsDir} ...`)
  await walk(uploadsDir, '')
  console.log(`done: ${copied} copied, ${skipped} already present (skipped), ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
