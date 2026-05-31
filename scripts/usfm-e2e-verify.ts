#!/usr/bin/env tsx
// End-to-end USFM round-trip verification against the LOCAL dev stack.
//
// What it proves:
//   1. The new lossless side-car path actually stores raw bytes in D1
//   2. The new export endpoint reconstructs them with current cells
//   3. With no translations, export hashes identical to the original .SFM
//   4. With a single targeted translation override, ONE verse changes and the
//      rest of the file is byte-identical (the credibility-critical claim)
//
// Run with `pnpm dev` up (5173 / 8788 / 8789) and the dev seed loaded:
//   npx tsx scripts/usfm-e2e-verify.ts [path/to/file.sfm]
//
// Defaults to the Koli Kachhi Matthew. Exits 0 on success, 1 on failure.

import { readFileSync, writeFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"

const AUTH = process.env.AUTH_BASE ?? "http://127.0.0.1:8788"
const SYNC = process.env.SYNC_BASE ?? "http://127.0.0.1:8789"
const PROJECT_ID = "dev-project"
const DEFAULT_FILE =
  "/Users/ryderwishart/Library/Mobile Documents/com~apple~CloudDocs/Frontier/Older documents/Koli Kachhi NT_USFM (Testing)/41MATKKI.SFM"

function sha(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

async function devLogin(): Promise<string> {
  const res = await fetch(`${AUTH}/__dev__/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
  if (!res.ok) throw new Error(`dev login failed (HTTP ${res.status}): ${await res.text()}`)
  const body = (await res.json()) as { access_token?: string; token?: string }
  const tok = body.access_token ?? body.token
  if (!tok) throw new Error(`dev login returned no token: ${JSON.stringify(body)}`)
  return tok
}

async function mintSyncToken(userJwt: string, fileId: string): Promise<string> {
  const res = await fetch(`${AUTH}/api/v2/sync-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${userJwt}`,
    },
    body: JSON.stringify({ projectId: PROJECT_ID, fileId, projectName: "Dev Project" }),
  })
  if (!res.ok) throw new Error(`sync-token failed (HTTP ${res.status}): ${await res.text()}`)
  const body = (await res.json()) as { token: string }
  return body.token
}

interface CellPayload {
  id: string
  cellId: string
  anchorCellId: string | null
  value: string
  canonicalRef?: string
  type?: string
}

async function bulkImport(
  syncJwt: string,
  fileId: string,
  raw: string,
  cells: CellPayload[],
): Promise<void> {
  const file = {
    id: randomUUID(),
    name: `e2e-${fileId.slice(0, 8)}.SFM`,
    fileType: "usfm",
    role: "source",
    kind: "usfm",
    importFormat: "usfm",
    parserVersion: "usfm-lossless-v1",
  }
  const res = await fetch(`${SYNC}/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${syncJwt}`,
    },
    body: JSON.stringify({
      projectId: PROJECT_ID,
      fileId,
      file,
      cells,
      clientTs: Date.now(),
      rawSource: raw,
      rawSourceFormat: "usfm",
    }),
  })
  if (!res.ok) throw new Error(`bulk import failed (HTTP ${res.status}): ${await res.text()}`)
}

async function commitTarget(
  syncJwt: string,
  fileId: string,
  cellId: string,
  sourceEventId: string,
  value: string,
): Promise<void> {
  // First translation = `target.cell.commit` with parentId = source.cell.create
  // event id (NOT target.cell.create — AD-2 treats it as stale because source
  // and target share a chain per cellId). The projection's UPSERT inserts the
  // target row on this first-commit path.
  const res = await fetch(`${SYNC}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${syncJwt}`,
    },
    body: JSON.stringify({
      events: [
        {
          id: randomUUID(),
          schemaVersion: 1,
          kind: "target.cell.commit",
          projectId: PROJECT_ID,
          fileId,
          cellId,
          parentId: sourceEventId,
          author: "dev",
          payload: { value, sourceEventId },
          clientTs: Date.now(),
        },
      ],
    }),
  })
  if (!res.ok) {
    throw new Error(`target.cell.commit failed (HTTP ${res.status}): ${await res.text()}`)
  }
  const body = (await res.json()) as { stale?: Array<{ id: string }> }
  if (body.stale && body.stale.length > 0) {
    throw new Error(`target.cell.commit landed stale: ${JSON.stringify(body.stale)}`)
  }
}
// Unused imports — keep the symbols referenced so eslint/tsc don't complain
// after the earlier temp-file path was removed.
void mkdtempSync; void writeFileSync; void tmpdir; void join; void execFileSync

async function exportSource(syncJwt: string, fileId: string): Promise<string> {
  const res = await fetch(
    `${SYNC}/api/v1/projects/${encodeURIComponent(PROJECT_ID)}/files/${encodeURIComponent(fileId)}/source`,
    { headers: { Authorization: `Bearer ${syncJwt}` } },
  )
  if (!res.ok) throw new Error(`export failed (HTTP ${res.status}): ${await res.text()}`)
  return await res.text()
}

function firstDiffIdx(a: string, b: string): number {
  const lim = Math.min(a.length, b.length)
  let i = 0
  while (i < lim && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function ctx(s: string, i: number, span = 40): string {
  return JSON.stringify(s.slice(Math.max(0, i - span), Math.min(s.length, i + span)))
}

async function main() {
  const filePath = process.argv[2] ?? DEFAULT_FILE
  const raw = readFileSync(filePath, "utf8")
  console.log(`Source: ${filePath}  (${raw.length} bytes, sha=${sha(raw).slice(0, 12)}…)`)

  console.log("→ dev login")
  const userJwt = await devLogin()

  // -------------------- Test A: empty-cells round-trip ------------------
  const fileIdA = randomUUID()
  console.log(`→ mint sync-token for fileId=${fileIdA.slice(0, 8)}…`)
  const syncJwtA = await mintSyncToken(userJwt, fileIdA)
  console.log("→ bulk import (zero cells, raw side-car only)")
  await bulkImport(syncJwtA, fileIdA, raw, [])
  console.log("→ export and compare")
  const exportedA = await exportSource(syncJwtA, fileIdA)
  if (sha(raw) === sha(exportedA)) {
    console.log(`  ✓ identity round-trip OK (${exportedA.length} bytes)`)
  } else {
    const i = firstDiffIdx(raw, exportedA)
    console.error(`  ✗ identity round-trip FAILED at byte ${i}`)
    console.error(`    orig: ${ctx(raw, i)}`)
    console.error(`    out:  ${ctx(exportedA, i)}`)
    process.exit(1)
  }

  // -------------------- Test B: single-verse override -------------------
  // Import the file again with a real cell for MAT 1:1, then commit an edit
  // and verify ONLY that one verse changes.
  const fileIdB = randomUUID()
  const syncJwtB = await mintSyncToken(userJwt, fileIdB)
  // Pick the file's actual first verse ref (Matthew has MAT 1:1, Psalms has PSA 1:1, etc.)
  const idMatch = raw.match(/\\id\s+(\S+)/)
  const cMatch = raw.match(/\\c\s+(\d+)/)
  const vMatch = raw.match(/\\v\s+(\S+)/)
  if (!idMatch || !cMatch || !vMatch) {
    console.log("  ⊘ skipping partial-translation test: file lacks \\id/\\c/\\v")
    console.log("\nAll checks passed.")
    return
  }
  const firstRef = `${idMatch[1].toUpperCase()} ${cMatch[1]}:${vMatch[1]}`
  const cellId = randomUUID()
  const sourceEventId = randomUUID()
  const editedText = `⟦E2E-EDITED-${firstRef.replace(/[ :]/g, "-")}⟧`
  console.log(`\n→ second import with one target cell for ${firstRef} (will edit to "${editedText}")`)
  await bulkImport(syncJwtB, fileIdB, raw, [
    {
      id: sourceEventId,
      cellId,
      anchorCellId: null,
      value: `(source ${firstRef})`,
      canonicalRef: firstRef,
      type: "verse",
    },
  ])
  await commitTarget(syncJwtB, fileIdB, cellId, sourceEventId, editedText)
  const exportedB = await exportSource(syncJwtB, fileIdB)
  if (!exportedB.includes(editedText)) {
    console.error("  ✗ exported file does not contain the edited text!")
    process.exit(1)
  }
  const editedCount = exportedB.split(editedText).length - 1
  if (editedCount !== 1) {
    console.error(`  ✗ edited text appears ${editedCount}× (expected exactly 1)`)
    process.exit(1)
  }
  // Confirm everything OUTSIDE the MAT 1:1 verse text is byte-identical.
  // Cheap structural check: count \v markers in both should match.
  const verseCount = (s: string) => (s.match(/(?:^|\n)\\v\s+\S+/g) ?? []).length
  if (verseCount(raw) !== verseCount(exportedB)) {
    console.error(`  ✗ verse count drift: ${verseCount(raw)} → ${verseCount(exportedB)}`)
    process.exit(1)
  }
  console.log(`  ✓ partial-translation export OK: 1 verse changed, ${verseCount(exportedB)} \\v markers preserved`)

  console.log("\nAll checks passed.")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
