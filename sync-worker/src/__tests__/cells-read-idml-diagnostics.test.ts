// AQU-1780: bulk cells reads must not ship `metadata.idmlMigration.diagnostics`.
//
// Legacy IDML migrations copied a file's whole diagnostics list (~200 KB)
// onto every source cell. A 1,389-cell Biblica file's second paired page then
// needed ~340 MB in a 128 MB Worker isolate, so Cloudflare killed it on every
// attempt and the editor showed "Couldn't load this file" under page 1.
//
// Runs against real Postgres (PGlite): the strip is a jsonb expression, and
// `#-` throws on scalar jsonb — production holds double-encoded string
// metadata, so the non-object shapes are pinned here too.

import { describe, it, expect } from "vitest"
import { handleCellsReadRequest, resetChainCacheForTests } from "../events/cells-read-route"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "cells-read-idml-secret"

const DIAGNOSTICS = Array.from({ length: 2_000 }, (_, i) => ({
  code: "UNSUPPORTED_CONSTRUCT",
  message: `Paragraph ${i} contains only protected IDML tokens and cannot be upgraded.`,
}))

function idmlMetadata(cellId: string) {
  return {
    legacyCodex: { idmlStructure: { storyId: "u1", paragraphId: cellId } },
    idmlMigration: { version: 2, readiness: "unsupported-legacy-html", diagnostics: DIAGNOSTICS },
  }
}

function sourceCreate(cellId: string, anchorCellId: string | null, metadata?: unknown): PersistedEvent {
  return {
    id: `ev-${cellId}`,
    schemaVersion: 1,
    projectId: "proj-a",
    fileId: "file-x",
    cellId,
    parentId: null,
    kind: "source.cell.create",
    author: "legacy-import",
    payload: {
      cellId,
      anchorCellId,
      value: `source ${cellId}`,
      ...(metadata !== undefined ? { metadata } : {}),
    },
    clientTs: 1,
    serverTs: 1700000000000,
  } as unknown as PersistedEvent
}

async function seed(cells: Array<{ cellId: string; metadata?: unknown }>) {
  const { db } = await makeTestDb({})
  const stmts: AquillaStatement[] = []
  let prev: string | null = null
  for (const cell of cells) {
    buildEventProjectionStmts(db, sourceCreate(cell.cellId, prev, cell.metadata), stmts)
    prev = cell.cellId
  }
  await db.batch(stmts)
  return db
}

async function read(db: AquillaDb, query: string) {
  resetChainCacheForTests()
  const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
  const res = (await handleCellsReadRequest(
    new Request(`https://w/api/v1/projects/proj-a/files/file-x/cells?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  ))!
  expect(res.status).toBe(200)
  const text = await res.text()
  return {
    bytes: text.length,
    cells: (JSON.parse(text) as { cells: Array<{ cellId: string; side: string; metadata: unknown }> }).cells,
  }
}

const STRIPPED = (cellId: string) => ({
  legacyCodex: { idmlStructure: { storyId: "u1", paragraphId: cellId } },
  idmlMigration: { version: 2, readiness: "unsupported-legacy-html" },
})

describe("AQU-1780: cells reads drop idmlMigration.diagnostics", () => {
  it.each([
    ["the paired editor page", "paired=1&limit=500"],
    ["a side-filtered page", "side=source"],
    ["the cellIds fast path", "cellIds=c1,c2"],
  ])("%s keeps every other metadata key", async (_label, query) => {
    const db = await seed([
      { cellId: "c1", metadata: idmlMetadata("c1") },
      { cellId: "c2", metadata: { ...idmlMetadata("c2"), attachments: [{ type: "image", url: "https://x/1.jpg" }] } },
    ])

    const { cells } = await read(db, query)

    const byId = new Map(cells.map((c) => [c.cellId, c.metadata]))
    expect(byId.get("c1")).toEqual(STRIPPED("c1"))
    expect(byId.get("c2")).toEqual({ ...STRIPPED("c2"), attachments: [{ type: "image", url: "https://x/1.jpg" }] })
  })

  it("passes every non-object shape through unchanged instead of failing the read", async () => {
    // `#-` raises "cannot delete path in scalar" on a jsonb string. Unguarded,
    // one double-encoded row would have failed the whole page.
    const db = await seed([
      { cellId: "plain" },
      { cellId: "obj", metadata: { group: 1 } },
      { cellId: "str" },
      { cellId: "arr" },
      { cellId: "scalar-migration", metadata: { idmlMigration: "legacy" } },
      { cellId: "array-migration", metadata: { idmlMigration: [1, 2] } },
    ])
    await db
      .prepare("UPDATE cells SET metadata = to_jsonb(?::text) WHERE project_id = ? AND cell_id = ?")
      .bind(JSON.stringify({ group: 2, aquillaImport: { kind: "txt" } }), "proj-a", "str")
      .run()
    await db
      .prepare("UPDATE cells SET metadata = ?::jsonb WHERE project_id = ? AND cell_id = ?")
      .bind(JSON.stringify([{ group: 3 }]), "proj-a", "arr")
      .run()

    const { cells } = await read(db, "paired=1&limit=500")

    const byId = new Map(cells.map((c) => [c.cellId, c.metadata]))
    expect(byId.get("plain")).toBeNull()
    expect(byId.get("obj")).toEqual({ group: 1 })
    // The route parses string metadata exactly as it did before.
    expect(byId.get("str")).toEqual({ group: 2, aquillaImport: { kind: "txt" } })
    expect(byId.get("arr")).toEqual([{ group: 3 }])
    expect(byId.get("scalar-migration")).toEqual({ idmlMigration: "legacy" })
    expect(byId.get("array-migration")).toEqual({ idmlMigration: [1, 2] })
  })

  it("keeps a page of migrated rows small", async () => {
    // 40 rows × ~170 KB of diagnostics would be ~7 MB; stripped, each row is
    // a few hundred bytes. The bound is loose on purpose — it fails only if
    // the list comes back.
    const ids = Array.from({ length: 40 }, (_, i) => `m${i}`)
    const db = await seed(ids.map((cellId) => ({ cellId, metadata: idmlMetadata(cellId) })))

    const { cells, bytes } = await read(db, "paired=1&limit=500")

    expect(cells).toHaveLength(40)
    expect(bytes).toBeLessThan(100_000)
  })
})
