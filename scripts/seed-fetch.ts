#!/usr/bin/env tsx
// Download the seed bundle from R2 into db/seed/.cache, verifying its sha256
// against db/seed/seed.meta.json. Reused by seed-load.ts.
//
//   npx tsx scripts/seed-fetch.ts        # ensure cached bundle is present + valid
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SEED_DIR = path.join(ROOT, "db", "seed")
const CACHE_DIR = path.join(SEED_DIR, ".cache")

export interface SeedMeta {
  generatedAt: string
  r2: { accountId: string; bucket: string; key: string }
  bundleBytes: number
  sha256: string
  schemaHash: string
  projectIds: string[]
  counts: Record<string, number>
}

export function readMeta(): SeedMeta {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, "seed.meta.json"), "utf8"))
}

function sha256File(p: string): string {
  return createHash("sha256").update(fs.readFileSync(p)).digest("hex")
}

/** Ensure the bundle named in meta is present + valid in the cache; return its path. */
export function ensureBundle(meta: SeedMeta = readMeta()): string {
  fs.mkdirSync(CACHE_DIR, { recursive: true })
  const local = path.join(CACHE_DIR, path.basename(meta.r2.key))
  if (fs.existsSync(local) && sha256File(local) === meta.sha256) {
    console.log(`✓ cached bundle valid (${path.basename(local)})`)
    return local
  }
  // Download to a temp path and only promote it once verified — wrangler writes
  // the --file even on a failed get, so writing straight to `local` would poison
  // the cache with a 0-byte file.
  console.log(`Fetching r2://${meta.r2.bucket}/${meta.r2.key} …`)
  const tmp = `${local}.partial`
  fs.rmSync(tmp, { force: true })
  try {
    execFileSync("npx", ["wrangler", "r2", "object", "get", `${meta.r2.bucket}/${meta.r2.key}`, "--file", tmp, "--remote"],
      { stdio: "inherit", env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: meta.r2.accountId } })
    const got = sha256File(tmp)
    if (got !== meta.sha256) throw new Error(`sha256 mismatch after fetch: expected ${meta.sha256}, got ${got} (${fs.statSync(tmp).size} bytes)`)
    fs.renameSync(tmp, local)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  console.log(`✓ fetched + verified (${(meta.bundleBytes / 1e6).toFixed(1)} MB)`)
  return local
}

if (process.argv[1]?.endsWith("seed-fetch.ts")) {
  try { ensureBundle() } catch (e) { console.error(e); process.exit(1) }
}
