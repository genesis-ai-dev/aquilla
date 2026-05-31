#!/usr/bin/env tsx
// Full-pipeline batch round-trip across every .SFM file under a directory.
//
// For every file:
//   1. POST /import (sync-worker) with rawSource + an empty cells array
//   2. GET  /api/v1/projects/<pid>/files/<fid>/source
//   3. sha256(exported) === sha256(original)?
//
// This proves the entire client→worker→D1→worker→client pipeline preserves
// the file byte-for-byte, not just the in-process parser/serializer pair
// (which the unit script already verifies for 276/276).
//
// Run:  npx tsx scripts/usfm-e2e-batch.ts [dir]
// Exit code: 0 if all files round-trip, 1 otherwise.

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"

const AUTH = process.env.AUTH_BASE ?? "http://127.0.0.1:8788"
const SYNC = process.env.SYNC_BASE ?? "http://127.0.0.1:8789"
const PROJECT_ID = "dev-project"
const DEFAULT_DIR =
  "/Users/ryderwishart/Library/Mobile Documents/com~apple~CloudDocs/Frontier/Older documents"
// Sequential by default: the existing /import bulk endpoint reads
// MAX(server_seq) without a lock, so concurrent requests can race on
// the (project_id, server_seq) UNIQUE INDEX and fail with FK-cascade
// errors. That's a pre-existing import-route bug unrelated to USFM
// round-trip — fixing it is out of scope here. Override with
// CONCURRENCY=N for stress testing.
const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? "1", 10)

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile() && /\.(sfm|usfm)$/i.test(entry.name)) out.push(full)
  }
  return out
}

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

async function devLogin(): Promise<string> {
  const res = await fetch(`${AUTH}/__dev__/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) throw new Error(`dev login failed: HTTP ${res.status}`)
  const body = (await res.json()) as { access_token?: string }
  if (!body.access_token) throw new Error(`dev login: no token`)
  return body.access_token
}

async function mintSyncToken(userJwt: string, fileId: string): Promise<string> {
  const res = await fetch(`${AUTH}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userJwt}` },
    body: JSON.stringify({ projectId: PROJECT_ID, fileId, projectName: "Dev Project" }),
  })
  if (!res.ok) throw new Error(`sync-token: HTTP ${res.status}`)
  return ((await res.json()) as { token: string }).token
}

async function importAndExport(
  userJwt: string,
  file: string,
): Promise<{ ok: boolean; reason?: string; bytes: number }> {
  const raw = readFileSync(file, "utf8")
  const fileId = randomUUID()
  const syncJwt = await mintSyncToken(userJwt, fileId)

  const importRes = await fetch(`${SYNC}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${syncJwt}` },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      fileId,
      file: {
        id: randomUUID(),
        name: file.split("/").pop() ?? "x.SFM",
        fileType: "usfm",
        role: "source",
        kind: "usfm",
        importFormat: "usfm",
        parserVersion: "batch-e2e",
      },
      cells: [],
      clientTs: Date.now(),
      rawSource: raw,
      rawSourceFormat: "usfm",
    }),
  })
  if (!importRes.ok) {
    return { ok: false, reason: `import HTTP ${importRes.status}: ${(await importRes.text()).slice(0, 200)}`, bytes: raw.length }
  }

  const expRes = await fetch(
    `${SYNC}/api/v1/projects/${PROJECT_ID}/files/${fileId}/source`,
    { headers: { Authorization: `Bearer ${syncJwt}` } },
  )
  if (!expRes.ok) {
    return { ok: false, reason: `export HTTP ${expRes.status}: ${(await expRes.text()).slice(0, 200)}`, bytes: raw.length }
  }
  const out = await expRes.text()
  if (sha(raw) !== sha(out)) {
    let i = 0
    const lim = Math.min(raw.length, out.length)
    while (i < lim && raw.charCodeAt(i) === out.charCodeAt(i)) i++
    return {
      ok: false,
      reason: `sha mismatch at byte ${i}; lens ${raw.length}→${out.length}`,
      bytes: raw.length,
    }
  }
  return { ok: true, bytes: raw.length }
}

async function main() {
  const dir = process.argv[2] ?? DEFAULT_DIR
  const files = walk(dir).sort()
  console.log(`Files to test: ${files.length}\nConcurrency: ${CONCURRENCY}\n`)

  const userJwt = await devLogin()

  let pass = 0
  let fail = 0
  let totalBytes = 0
  const failures: { file: string; reason: string }[] = []

  // Simple bounded-concurrency worker pool.
  let cursor = 0
  const t0 = Date.now()
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const myIdx = cursor++
        if (myIdx >= files.length) return
        const file = files[myIdx]
        const r = await importAndExport(userJwt, file).catch((e) => ({
          ok: false,
          reason: `exception: ${(e as Error).message}`,
          bytes: 0,
        }))
        totalBytes += r.bytes
        if (r.ok) {
          pass++
          if (pass % 25 === 0) console.log(`  …${pass}/${files.length} passing`)
        } else {
          fail++
          failures.push({ file, reason: r.reason ?? "?" })
          console.log(`  ✗ ${file.split("/").slice(-2).join("/")}: ${r.reason}`)
        }
      }
    }),
  )

  const dt = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`\nDone in ${dt}s. Pass: ${pass}/${files.length}, Fail: ${fail}, throughput: ${(totalBytes / 1e6 / parseFloat(dt)).toFixed(1)} MB/s`)
  if (failures.length > 0) {
    console.log(`\nFailures:`)
    for (const f of failures.slice(0, 20)) console.log(`  ${f.file}\n    ${f.reason}`)
  }
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
