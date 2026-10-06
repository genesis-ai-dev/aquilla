// AQU-1683: the inherited ("upstream ancestry changed", purple) badge must not
// fire when nothing this project will receive has changed. Each case below
// was a false positive that could never clear:
//
//   1. A file linked straight to a project with no link of its own has nothing
//      to inherit (Matthew, 2026-10-05). A change in that upstream reaches the
//      file as direct (amber) staleness once the mirror syncs.
//   2. Files that share cell ids — IDML story paths repeat across every IDML
//      file of a project — were compared with each other, because the walk
//      read rows by cell id alone. Covers the plain mirror and a file the link
//      replaced (AQU-1679), which is the reporter's shape.
//   3. An ancestor whose source row moved without its text changing (a
//      metadata-only re-import) made its translations look stale by event id.
//   4. An unvalidated draft upstream counted as a change for a link that only
//      takes validated text.
//   5. A line deleted upstream stayed purple after the delete arrived.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { handleStaleSourceRequest } from "../events/stale-source-route"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { headParentFor } from "./helpers/chain-parent"
import { makeTestToken } from "./helpers/auth"

const SECRET = "test-secret"

let seq = 0

async function emit(
  t: TestDb,
  projectId: string,
  kind: EventKind,
  args: { fileId?: string; cellId?: string; author?: string; payload: Record<string, unknown> },
): Promise<string> {
  seq += 1
  const id = `evt-fp-${String(seq).padStart(4, "0")}`
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  const serverSeq = Number(seqRow.rows[0]?.next_seq ?? 1)
  const parentId = await headParentFor(t, projectId, kind, args.fileId, args.cellId, args.payload)
  const author = args.author ?? "lead"
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9)`,
    [id, projectId, args.fileId ?? null, args.cellId ?? null, parentId, kind, author, JSON.stringify(args.payload), serverSeq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId,
    kind,
    author,
    payload: args.payload,
    clientTs: serverSeq,
    serverTs: serverSeq,
    serverSeq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return id
}

async function project(t: TestDb, id: string): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, $1, 1)`, [id])
}

/** What POST /link-source writes. */
async function link(
  t: TestDb,
  downstream: string,
  upstream: string,
  opts: { consumes: "source" | "target"; fileIds?: string[]; adopt?: Record<string, string> },
): Promise<void> {
  await t.pg.query(
    `UPDATE projects
        SET source_project_id = $2, source_link_mode = 'live', source_link_consumes = $3,
            source_link_gate = 'validated', source_link_cursor = 0,
            source_link_file_ids = $4, source_link_adopt = $5
      WHERE id = $1`,
    [
      downstream,
      upstream,
      opts.consumes,
      opts.fileIds ? JSON.stringify(opts.fileIds) : null,
      opts.adopt ? JSON.stringify({ files: opts.adopt, pending: Object.keys(opts.adopt) }) : null,
    ],
  )
}

/** A file whose lines are chained in order, as an importer writes them. */
async function seedFile(
  t: TestDb,
  projectId: string,
  fileId: string,
  lines: ReadonlyArray<readonly [cellId: string, value: string]>,
): Promise<void> {
  await emit(t, projectId, "file.create", { fileId, payload: { name: fileId, fileType: "idml" } })
  let anchor: string | null = null
  for (const [cellId, value] of lines) {
    await emit(t, projectId, "source.cell.create", { fileId, cellId, payload: { cellId, anchorCellId: anchor, value } })
    anchor = cellId
  }
}

async function sourceEventId(t: TestDb, projectId: string, fileId: string, cellId: string): Promise<string> {
  const row = await t.pg.query<{ event_id: string }>(
    `SELECT event_id FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [projectId, fileId, cellId],
  )
  const id = row.rows[0]?.event_id
  if (!id) throw new Error(`no source row for ${projectId}/${fileId}/${cellId}`)
  return id
}

/** Commit a translation pinned to the line's current source; optionally validate it. */
async function translate(
  t: TestDb,
  projectId: string,
  fileId: string,
  cellId: string,
  value: string,
  opts: { validate?: boolean } = {},
): Promise<void> {
  const pin = await sourceEventId(t, projectId, fileId, cellId)
  const commit = await emit(t, projectId, "target.cell.commit", { fileId, cellId, payload: { value, sourceEventId: pin } })
  if (opts.validate) {
    await emit(t, projectId, "cell.validate", { fileId, cellId, author: "reviewer", payload: { editEventId: commit } })
  }
}

async function fetchStale(
  t: TestDb,
  projectId: string,
  fileId: string,
): Promise<{ staleCellIds: string[]; upstreamStaleCellIds: string[]; tombstonedCellIds: string[] }> {
  const token = await makeTestToken(SECRET, { projectId, fileId, role: 100 })
  const req = new Request(
    `https://sync.test/api/v1/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/stale-source`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const res = await handleStaleSourceRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET })
  expect(res).not.toBeNull()
  return (await (res as Response).json()) as {
    staleCellIds: string[]
    upstreamStaleCellIds: string[]
    tombstonedCellIds: string[]
  }
}

async function withDb(body: (t: TestDb) => Promise<void>): Promise<void> {
  const t = await makeTestDb()
  try {
    await body(t)
  } finally {
    await t.close()
  }
}

describe("AQU-1683: a single link has nothing to inherit", () => {
  it("a source edit in an upstream with no link of its own shows amber after the sync, never purple", () =>
    withDb(async (t) => {
      await project(t, "u")
      await project(t, "d")
      await seedFile(t, "u", "uf", [["l1", "In the beginning"], ["l2", "God created"]])
      await link(t, "d", "u", { consumes: "source" })
      await mirrorSync(t.db, "d")
      const df = deterministicDownstreamFileId("d", "uf")
      await translate(t, "d", df, "l1", "Au commencement")

      await emit(t, "u", "source.cell.commit", { fileId: "uf", cellId: "l1", payload: { value: "In the very beginning" } })
      expect((await fetchStale(t, "d", df)).upstreamStaleCellIds).toEqual([])

      await mirrorSync(t.db, "d")
      const synced = await fetchStale(t, "d", df)
      expect(synced.staleCellIds).toEqual(["l1"])
      expect(synced.upstreamStaleCellIds).toEqual([])
    }))

  it("an upstream translation left behind its own source shows no purple on a link to that translation", () =>
    withDb(async (t) => {
      await project(t, "u")
      await project(t, "d")
      await seedFile(t, "u", "uf", [["l1", "In the beginning"]])
      await translate(t, "u", "uf", "l1", "Au commencement", { validate: true })
      await link(t, "d", "u", { consumes: "target" })
      await mirrorSync(t.db, "d")
      const df = deterministicDownstreamFileId("d", "uf")
      await translate(t, "d", df, "l1", "Pa kuyamba")

      await emit(t, "u", "source.cell.commit", { fileId: "uf", cellId: "l1", payload: { value: "In the very beginning" } })
      expect((await fetchStale(t, "d", df)).upstreamStaleCellIds).toEqual([])
    }))
})

describe("AQU-1683: files that share cell ids are never compared with each other", () => {
  // IDML cell ids are story paths, so every IDML file of a project reuses them.
  const s1 = "Stories/Story_u363.xml#/idPkg:Story[1]/Story[1]/ParagraphStyleRange[8]:part-0"
  const s2 = "Stories/Story_u363.xml#/idPkg:Story[1]/Story[1]/ParagraphStyleRange[9]:part-0"

  /** a (two IDML files) → b (all files) → c1 (file 1), c2 (file 2), and c3,
   *  whose own file replaced its source with b's file 2 (AQU-1679). */
  async function seed(t: TestDb): Promise<{ bf1: string; bf2: string; c1f: string; c2f: string }> {
    for (const id of ["a", "b", "c1", "c2", "c3"]) await project(t, id)
    await seedFile(t, "a", "isa-mal", [[s1, "The books from Isaiah to Malachi"], [s2, "the women will smell bad."]])
    await seedFile(t, "a", "act-rev", [[s1, "What is the book of Acts?"], [s2, "The moon will not shine."]])
    await link(t, "b", "a", { consumes: "source" })
    await mirrorSync(t.db, "b")
    const bf1 = deterministicDownstreamFileId("b", "isa-mal")
    const bf2 = deterministicDownstreamFileId("b", "act-rev")

    await link(t, "c1", "b", { consumes: "source", fileIds: [bf1] })
    await mirrorSync(t.db, "c1")
    const c1f = deterministicDownstreamFileId("c1", bf1)
    await translate(t, "c1", c1f, s1, "Les livres d'Ésaïe à Malachie")

    await link(t, "c2", "b", { consumes: "source", fileIds: [bf2] })
    await mirrorSync(t.db, "c2")
    const c2f = deterministicDownstreamFileId("c2", bf2)
    await translate(t, "c2", c2f, s1, "Qu'est-ce que le livre des Actes ?")

    await seedFile(t, "c3", "own-act-rev", [[s1, "What is the book of Acts?"], [s2, "The moon will not shine."]])
    await translate(t, "c3", "own-act-rev", s1, "Qu'est-ce que le livre des Actes ?")
    await link(t, "c3", "b", { consumes: "source", fileIds: [bf2], adopt: { [bf2]: "own-act-rev" } })
    await mirrorSync(t.db, "c3")

    return { bf1, bf2, c1f, c2f }
  }

  it("nothing is purple when nothing upstream changed", () =>
    withDb(async (t) => {
      const { c1f, c2f } = await seed(t)
      expect((await fetchStale(t, "c1", c1f)).upstreamStaleCellIds).toEqual([])
      expect((await fetchStale(t, "c2", c2f)).upstreamStaleCellIds).toEqual([])
      expect((await fetchStale(t, "c3", "own-act-rev")).upstreamStaleCellIds).toEqual([])
    }))

  it("an edit two links up flags that line in the files that follow it, and nowhere else", () =>
    withDb(async (t) => {
      const { c1f, c2f } = await seed(t)
      // b stays dormant: it never syncs the edit.
      await emit(t, "a", "source.cell.commit", { fileId: "act-rev", cellId: s1, payload: { value: "What is Acts about?" } })

      expect((await fetchStale(t, "c1", c1f)).upstreamStaleCellIds).toEqual([])
      expect((await fetchStale(t, "c2", c2f)).upstreamStaleCellIds).toEqual([s1])
      expect((await fetchStale(t, "c3", "own-act-rev")).upstreamStaleCellIds).toEqual([s1])
    }))
})

describe("AQU-1683: a link to an upstream's translations", () => {
  /** a (root) → b (consumes a's source; translates and validates) → c
   *  (consumes b's validated translations; translates). */
  async function seed(t: TestDb): Promise<{ bf: string; cf: string }> {
    for (const id of ["a", "b", "c"]) await project(t, id)
    await seedFile(t, "a", "af", [["l1", "Peace be with you"]])
    await link(t, "b", "a", { consumes: "source" })
    await mirrorSync(t.db, "b")
    const bf = deterministicDownstreamFileId("b", "af")
    await translate(t, "b", bf, "l1", "La paix soit avec vous", { validate: true })
    await link(t, "c", "b", { consumes: "target" })
    await mirrorSync(t.db, "c")
    const cf = deterministicDownstreamFileId("c", bf)
    await translate(t, "c", cf, "l1", "Mtendere ukhale nanu")
    expect((await fetchStale(t, "c", cf)).upstreamStaleCellIds).toEqual([])
    return { bf, cf }
  }

  it("an upstream source row that moves without its text changing is not a change", () =>
    withDb(async (t) => {
      const { bf, cf } = await seed(t)
      // A metadata-only re-import: a new source event, the same text.
      await emit(t, "b", "source.cell.commit", { fileId: bf, cellId: "l1", payload: { value: "Peace be with you" } })
      expect((await fetchStale(t, "c", cf)).upstreamStaleCellIds).toEqual([])
    }))

  it("an unvalidated draft upstream is not a change until it is validated", () =>
    withDb(async (t) => {
      const { bf, cf } = await seed(t)
      await translate(t, "b", bf, "l1", "Que la paix soit avec vous")
      expect((await fetchStale(t, "c", cf)).upstreamStaleCellIds).toEqual([])

      const head = await t.pg.query<{ event_id: string }>(
        `SELECT event_id FROM cells WHERE project_id = 'b' AND file_id = $1 AND cell_id = 'l1' AND side = 'target'`,
        [bf],
      )
      await emit(t, "b", "cell.validate", {
        fileId: bf,
        cellId: "l1",
        author: "reviewer",
        payload: { editEventId: head.rows[0]?.event_id },
      })
      expect((await fetchStale(t, "c", cf)).upstreamStaleCellIds).toEqual(["l1"])

      await mirrorSync(t.db, "c")
      const synced = await fetchStale(t, "c", cf)
      expect(synced.staleCellIds).toEqual(["l1"])
      expect(synced.upstreamStaleCellIds).toEqual([])
    }))

  it("a line deleted upstream is reported as deleted, not purple", () =>
    withDb(async (t) => {
      const { cf } = await seed(t)
      await emit(t, "a", "source.cell.delete", { fileId: "af", cellId: "l1", payload: {} })
      await mirrorSync(t.db, "b")
      await mirrorSync(t.db, "c")
      const after = await fetchStale(t, "c", cf)
      expect(after.tombstonedCellIds).toEqual(["l1"])
      expect(after.upstreamStaleCellIds).toEqual([])
    }))
})
