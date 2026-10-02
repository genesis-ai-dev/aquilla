// AQU-1567 — a cell the upstream deleted keeps the right tombstone state
// downstream: across a chain of links, through a restore, and never for a cell
// the downstream did not hold.
//
// A live link never deletes a downstream row when the upstream deletes the cell:
// `source.cell.mirror { deleted: true }` stamps `tombstoned_at` on the row and
// keeps its last text (AQU-476 §5). Three ways that state went wrong:
//
//   1. A chain lost it. In A → B → C, B tombstoned the cell, but C's fold read
//      B's mirror as content with value '' — C's row was blanked and stayed
//      live. Same for a C that consumes B's translations, and (once the delete
//      did arrive) a hide or a new translation in B made C's row live again.
//   2. A restore never cleared it. The tombstone write keeps the row's old
//      content hash, so an upstream re-creating the cell with its original text
//      was hash-suppressed and the downstream stayed tombstoned forever.
//   3. A cell the downstream never held arrived as an empty tombstoned row
//      whenever its create and delete folded into one window — on a new link's
//      first sync, that is every cell the upstream ever deleted.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

/** A → B → C: B links live to A; C links live to B. */
const A = "proj-a-tomb"
const B = "proj-b-tomb"
const C = "proj-c-tomb"
/** A second downstream of B that consumes B's TRANSLATIONS (gate head). */
const CT = "proj-ct-tomb"

const A_FILE = "file-a-tomb"
const B_FILE = deterministicDownstreamFileId(B, A_FILE)
const C_FILE = deterministicDownstreamFileId(C, B_FILE)
const CT_FILE = deterministicDownstreamFileId(CT, B_FILE)

type Kind =
  | "file.create"
  | "source.cell.create"
  | "source.cell.delete"
  | "source.cell.visibility.set"
  | "source.cell.mirror"
  | "target.cell.commit"

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'A', 1)`, [A])
  const link = `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_gate, source_link_cursor)
                VALUES ($1, $2, 1, $3, 'live', $4, 'head', 0)`
  await t.pg.query(link, [B, "B", A, "source"])
  await t.pg.query(link, [C, "C", B, "source"])
  await t.pg.query(link, [CT, "CT", B, "target"])
}

let _id = 0

/** One event in `projectId` through the front-door projection, with a real
 *  server_seq so a downstream's freshness probe and delta fold both see it. */
async function emit(
  t: TestDb,
  projectId: string,
  kind: Kind,
  args: { fileId: string; cellId?: string; payload: Record<string, unknown> },
): Promise<void> {
  _id += 1
  const id = `evt-tchain-${_id}`
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  const seq = Number(seqRow.rows[0]?.next_seq ?? 1)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, 'lead', $6, $7, $7, $7)`,
    [id, projectId, args.fileId, args.cellId ?? null, kind, JSON.stringify(args.payload), seq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId,
    fileId: args.fileId,
    cellId: args.cellId ?? null,
    parentId: null,
    kind,
    author: "lead",
    payload: args.payload,
    clientTs: seq,
    // A hide stamps `hidden_at` with serverTs, so it must be truthy.
    serverTs: seq,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
}

const text = (n: number): string => `In the beginning ${n}`

async function createInA(t: TestDb, n: number): Promise<void> {
  await emit(t, A, "source.cell.create", {
    fileId: A_FILE,
    cellId: `c${n}`,
    payload: { cellId: `c${n}`, value: text(n), canonicalRef: `GEN 1:${n}`, anchorCellId: n === 1 ? null : `c${n - 1}` },
  })
}

async function deleteInA(t: TestDb, n: number): Promise<void> {
  await emit(t, A, "source.cell.delete", { fileId: A_FILE, cellId: `c${n}`, payload: {} })
}

/** GEN 1:1–3 in A, one source cell per verse. */
async function seedA(t: TestDb): Promise<void> {
  await emit(t, A, "file.create", { fileId: A_FILE, payload: { name: "Genesis", fileType: "codex" } })
  for (const n of [1, 2, 3]) await createInA(t, n)
}

interface SourceRow {
  value: string
  tombstoned: boolean
}

async function sourceRow(t: TestDb, projectId: string, fileId: string, cellId: string): Promise<SourceRow | undefined> {
  const r = await t.pg.query<{ value: string; tombstoned_at: string | null }>(
    `SELECT value, tombstoned_at FROM cells
      WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source' AND target_lang = ''`,
    [projectId, fileId, cellId],
  )
  const row = r.rows[0]
  return row ? { value: row.value, tombstoned: row.tombstoned_at != null } : undefined
}

async function sourceCellIds(t: TestDb, projectId: string, fileId: string): Promise<string[]> {
  const r = await t.pg.query<{ cell_id: string }>(
    `SELECT cell_id FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'source' ORDER BY cell_id`,
    [projectId, fileId],
  )
  return r.rows.map((row) => row.cell_id)
}

describe("mirrorSync — an upstream delete travels down a chain of links (AQU-1567 bug 1)", () => {
  it("a cell deleted in A is tombstoned in B AND in C, keeping its text", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, C)
      expect(await sourceRow(t, C, C_FILE, "c2")).toEqual({ value: text(2), tombstoned: false })

      await deleteInA(t, 2)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, C)

      expect(await sourceRow(t, B, B_FILE, "c2")).toEqual({ value: text(2), tombstoned: true })
      // C's only evidence of the delete is B's `source.cell.mirror { deleted }`.
      // Read as content, it blanked the row and left it live.
      expect(await sourceRow(t, C, C_FILE, "c2")).toEqual({ value: text(2), tombstoned: true })
      expect(await sourceRow(t, C, C_FILE, "c1")).toEqual({ value: text(1), tombstoned: false })
    } finally {
      await t.close()
    }
  })

  it("a downstream consuming B's translations tombstones a cell A deleted", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      for (const n of [1, 2]) {
        await emit(t, B, "target.cell.commit", { fileId: B_FILE, cellId: `c${n}`, payload: { value: `Au commencement ${n}` } })
      }
      await mirrorSync(t.db, CT)
      expect(await sourceRow(t, CT, CT_FILE, "c2")).toEqual({ value: "Au commencement 2", tombstoned: false })

      await deleteInA(t, 2)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, CT)

      // B's translation of the deleted line survives in B for review — and it
      // is exactly the text CT already holds, so a fold that missed the delete
      // hash-skipped the cell and left it live.
      expect(await sourceRow(t, CT, CT_FILE, "c2")).toEqual({ value: "Au commencement 2", tombstoned: true })
      expect(await sourceRow(t, CT, CT_FILE, "c1")).toEqual({ value: "Au commencement 1", tombstoned: false })
    } finally {
      await t.close()
    }
  })

  it("hiding the deleted cell in B does not make it live again in C", async () => {
    // B's tombstoned row is still on B's screen, so B's lead can park it. C's
    // fold resolves a visibility-only change against B's live row — which, for
    // a cell A deleted, is a tombstone, not content.
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, C)
      await deleteInA(t, 2)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, C)

      await emit(t, B, "source.cell.visibility.set", { fileId: B_FILE, cellId: "c2", payload: { hidden: true } })
      await mirrorSync(t.db, C)

      expect((await sourceRow(t, C, C_FILE, "c2"))?.tombstoned).toBe(true)
    } finally {
      await t.close()
    }
  })

  it("a new translation of the deleted cell in B does not make it live again downstream", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await emit(t, B, "target.cell.commit", { fileId: B_FILE, cellId: "c2", payload: { value: "Au commencement 2" } })
      await mirrorSync(t.db, CT)
      await deleteInA(t, 2)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, CT)

      // B's row is a tombstone; editing its orphaned translation does not
      // bring the line back upstream, so it must not bring it back in CT.
      await emit(t, B, "target.cell.commit", { fileId: B_FILE, cellId: "c2", payload: { value: "Au tout début" } })
      await mirrorSync(t.db, CT)

      expect((await sourceRow(t, CT, CT_FILE, "c2"))?.tombstoned).toBe(true)
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — a restored upstream cell is live again downstream (AQU-1567 bug 2)", () => {
  it("re-creating a deleted cell with its ORIGINAL text clears the tombstone", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await deleteInA(t, 2)
      await mirrorSync(t.db, B)
      expect((await sourceRow(t, B, B_FILE, "c2"))?.tombstoned).toBe(true)

      // A re-import (or DCS delta, or migration re-run) brings the same verse
      // back under the same id. The tombstone kept the old content hash, so
      // the new text hashes equal to it.
      await createInA(t, 2)
      const result = await mirrorSync(t.db, B)

      expect(result.cellsMirrored).toBe(1)
      expect(await sourceRow(t, B, B_FILE, "c2")).toEqual({ value: text(2), tombstoned: false })
    } finally {
      await t.close()
    }
  })

  it("a delete and a re-create inside ONE window leave the row live", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await deleteInA(t, 2)
      await mirrorSync(t.db, B)

      // Deleted again and restored again before B's next sync — the fold sees
      // only the restore, against a row that is already a tombstone.
      await deleteInA(t, 2)
      await createInA(t, 2)
      await mirrorSync(t.db, B)

      expect(await sourceRow(t, B, B_FILE, "c2")).toEqual({ value: text(2), tombstoned: false })
    } finally {
      await t.close()
    }
  })

  it("the restore reaches the end of a chain", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, C)
      await deleteInA(t, 2)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, C)

      await createInA(t, 2)
      await mirrorSync(t.db, B)
      await mirrorSync(t.db, C)

      expect(await sourceRow(t, B, B_FILE, "c2")).toEqual({ value: text(2), tombstoned: false })
      expect(await sourceRow(t, C, C_FILE, "c2")).toEqual({ value: text(2), tombstoned: false })
    } finally {
      await t.close()
    }
  })

  it("an unchanged cell that is not tombstoned is still hash-skipped", async () => {
    // The guard for the fix: only a tombstone opts out of the no-op skip.
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)

      await createInA(t, 3)
      const result = await mirrorSync(t.db, B)

      expect(result.cellsMirrored).toBe(0)
      expect(result.skippedHashEqual).toBe(1)
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — no tombstone for a cell the downstream never held (AQU-1567 bug 3)", () => {
  it("a create and a delete folded into the first sync leave no downstream row", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await createInA(t, 4)
      await deleteInA(t, 4)

      const result = await mirrorSync(t.db, B)

      expect(await sourceCellIds(t, B, B_FILE)).toEqual(["c1", "c2", "c3"])
      expect(result.cellsMirrored).toBe(3)
    } finally {
      await t.close()
    }
  })

  it("holds when the create and the delete fall in different windows of one run", async () => {
    // One event per window: without a look ahead the create's window would
    // mirror the cell and the delete's window would tombstone it — a row that
    // exists only because of where a window boundary fell (AQU-1563 windows
    // must not change what a downstream ends up with).
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await createInA(t, 4)
      await deleteInA(t, 4)

      await mirrorSync(t.db, B, { windowEvents: 1 })

      expect(await sourceCellIds(t, B, B_FILE)).toEqual(["c1", "c2", "c3"])
    } finally {
      await t.close()
    }
  })

  it("a cell held BEFORE the run is still tombstoned when one window edits and a later one deletes it", async () => {
    // The look ahead only skips cells new to the downstream; an ordinary
    // delete of a held cell is untouched by where the windows fall.
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await emit(t, A, "source.cell.visibility.set", { fileId: A_FILE, cellId: "c2", payload: { hidden: true } })
      await deleteInA(t, 2)

      await mirrorSync(t.db, B, { windowEvents: 1 })

      expect(await sourceRow(t, B, B_FILE, "c2")).toEqual({ value: text(2), tombstoned: true })
    } finally {
      await t.close()
    }
  })

  it("a chain's first sync skips a cell B mirrored and later tombstoned, in any windowing", async () => {
    // C's look ahead reads B's log, where the delete is a `source.cell.mirror
    // { deleted: true }` rather than a `source.cell.delete`.
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await deleteInA(t, 2)
      await mirrorSync(t.db, B)

      await mirrorSync(t.db, C, { windowEvents: 1 })

      expect(await sourceCellIds(t, C, C_FILE)).toEqual(["c1", "c3"])
    } finally {
      await t.close()
    }
  })

  it("a later window re-creating the id brings it across as a normal cell", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await createInA(t, 4)
      await deleteInA(t, 4)
      await mirrorSync(t.db, B)

      await createInA(t, 4)
      const result = await mirrorSync(t.db, B)

      expect(result.cellsMirrored).toBe(1)
      expect(await sourceRow(t, B, B_FILE, "c4")).toEqual({ value: text(4), tombstoned: false })
    } finally {
      await t.close()
    }
  })

  it("re-running a sync over the same window mirrors nothing", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await createInA(t, 4)
      await deleteInA(t, 4)
      await mirrorSync(t.db, B)

      // Rewind the cursor: the same window again, as after a crash before the
      // cursor write. Deterministic ids dedupe the events; nothing is new.
      await t.pg.query(`UPDATE projects SET source_link_cursor = 0 WHERE id = $1`, [B])
      const result = await mirrorSync(t.db, B)

      expect(result.cellsMirrored).toBe(0)
      expect(await sourceCellIds(t, B, B_FILE)).toEqual(["c1", "c2", "c3"])
    } finally {
      await t.close()
    }
  })

  it("an empty tombstone B already holds does not spread to C", async () => {
    // B rows written before this fix: B's log carries a `source.cell.mirror
    // { deleted }` for a cell it never held. C replays B's whole log on its
    // first sync and must not copy that row either.
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedA(t)
      await mirrorSync(t.db, B)
      await emit(t, B, "source.cell.mirror", {
        fileId: B_FILE,
        cellId: "c9",
        payload: {
          value: "",
          deleted: true,
          upstream: { projectId: A, cellId: "c9", eventId: "evt-a-gone", seq: 99, side: "source", contentHash: "" },
        },
      })
      expect((await sourceRow(t, B, B_FILE, "c9"))?.tombstoned).toBe(true)

      await mirrorSync(t.db, C)

      expect(await sourceCellIds(t, C, C_FILE)).toEqual(["c1", "c2", "c3"])
    } finally {
      await t.close()
    }
  })
})
