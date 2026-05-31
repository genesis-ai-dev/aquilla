#!/usr/bin/env tsx
// End-to-end proof of the TARGET import emission against the local dev stack.
//
// Mirrors importParatextAsTarget's emission exactly (the function itself is
// browser-bound via syncWorkerHttpOrigin, so we replicate its wire calls):
//   1. import a real book as a TARGET file: source.cell.create per verse
//      (synthetic reference text), target Paratext bytes as side-car
//   2. target.cell.commit per verse (the real translation, parent = the
//      paired source cell's event id)
//   3. export → must reproduce the original book byte-for-byte (target cell
//      text == the verse text, woven back into the side-car structure)
//   4. spot-check the source side carries the reference text
//
// Run (with `pnpm dev` up): npx tsx scripts/paratext-target-e2e.ts [file.sfm]

import { readFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { parseUsfmLossless } from "../src/lib/parsers/usfm-lossless"

const AUTH = process.env.AUTH_BASE ?? "http://127.0.0.1:8788"
const SYNC = process.env.SYNC_BASE ?? "http://127.0.0.1:8789"
const PROJECT_ID = "dev-project"
const DEFAULT_FILE =
  "/Users/ryderwishart/Library/Mobile Documents/com~apple~CloudDocs/Frontier/Older documents/Koli Kachhi NT_USFM (Testing)/41MATKKI.SFM"

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")

async function devLogin(): Promise<string> {
  const res = await fetch(`${AUTH}/__dev__/login`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  })
  if (!res.ok) throw new Error(`dev login HTTP ${res.status}`)
  return ((await res.json()) as { access_token: string }).access_token
}

async function mintToken(userJwt: string, fileId: string): Promise<string> {
  const res = await fetch(`${AUTH}/api/v2/sync-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${userJwt}` },
    body: JSON.stringify({ projectId: PROJECT_ID, fileId, projectName: "Dev Project" }),
  })
  if (!res.ok) throw new Error(`sync-token HTTP ${res.status}`)
  return ((await res.json()) as { token: string }).token
}

async function main() {
  const file = process.argv[2] ?? DEFAULT_FILE
  const raw = readFileSync(file, "utf8")
  const doc = parseUsfmLossless(raw)
  console.log(`Target book: ${doc.bookId}  (${doc.verses.length} verses, ${raw.length} bytes)`)

  const userJwt = await devLogin()
  const fileId = randomUUID()
  const token = await mintToken(userJwt, fileId)

  // Build paired cells: source = synthetic reference, target = exact verse text.
  const sourceCells: { id: string; cellId: string; anchorCellId: string | null; value: string; type: string; canonicalRef: string }[] = []
  const targetCommits: { id: string; cellId: string; parentId: string; value: string }[] = []
  let prev: string | null = null
  for (const v of doc.verses) {
    const cellId = randomUUID()
    const sourceEventId = randomUUID()
    sourceCells.push({ id: sourceEventId, cellId, anchorCellId: prev, value: `SRC ${v.ref}`, type: "verse", canonicalRef: v.ref })
    targetCommits.push({ id: randomUUID(), cellId, parentId: sourceEventId, value: v.text })
    prev = cellId
  }
  console.log(`Paired cells: ${sourceCells.length} source + ${targetCommits.length} target`)

  // 1. import source cells + target side-car
  const importRes = await fetch(`${SYNC}/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      projectId: PROJECT_ID, fileId,
      file: { id: randomUUID(), name: doc.bookId, fileType: "usfm", role: "target", kind: "usfm", importFormat: "usfm", bookCode: doc.bookId },
      cells: sourceCells, clientTs: Date.now(), rawSource: raw, rawSourceFormat: "usfm",
    }),
  })
  if (!importRes.ok) throw new Error(`import HTTP ${importRes.status}: ${await importRes.text()}`)
  console.log("→ source cells + side-car imported")

  // 2. target.cell.commit per verse, chunked
  const CHUNK = 200
  let stale = 0
  for (let i = 0; i < targetCommits.length; i += CHUNK) {
    const events = targetCommits.slice(i, i + CHUNK).map((c) => ({
      id: c.id, schemaVersion: 1, kind: "target.cell.commit", projectId: PROJECT_ID, fileId,
      cellId: c.cellId, parentId: c.parentId, author: "dev",
      payload: { value: c.value, sourceEventId: c.parentId }, clientTs: Date.now(),
    }))
    const res = await fetch(`${SYNC}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ events }),
    })
    if (!res.ok) throw new Error(`events HTTP ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { stale?: unknown[] }
    stale += body.stale?.length ?? 0
  }
  console.log(`→ ${targetCommits.length} target commits applied${stale ? ` (${stale} stale!)` : ""}`)

  // 3. export → must equal the original book byte-for-byte
  const expRes = await fetch(`${SYNC}/api/v1/projects/${PROJECT_ID}/files/${fileId}/source`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!expRes.ok) throw new Error(`export HTTP ${expRes.status}: ${await expRes.text()}`)
  const out = await expRes.text()

  let ok = true
  if (sha(out) === sha(raw)) {
    console.log(`✓ export round-trip byte-identical (${out.length} bytes) — target woven back into structure`)
  } else {
    ok = false
    let i = 0
    while (i < Math.min(raw.length, out.length) && raw[i] === out[i]) i++
    console.error(`✗ export mismatch at byte ${i}: orig=${JSON.stringify(raw.slice(i - 20, i + 20))} out=${JSON.stringify(out.slice(i - 20, i + 20))}`)
  }
  if (stale > 0) { ok = false; console.error(`✗ ${stale} target commits landed STALE (not projected)`) }

  console.log(ok ? "\nAll checks passed." : "\nFAILED.")
  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
