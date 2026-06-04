// Parity tests for the bulk projection fold (scripts/lib/fold-projection.ts).
//
// The fold must produce the SAME projection rows as the canonical per-event
// replay (buildEventProjectionStmts, the exact code the worker + rebuild.ts
// run). We assert that by replaying events into one PGlite DB the canonical
// way, bulk-inserting the fold's rows into a second PGlite DB, then diffing the
// resulting tables. Same Postgres engine on both sides → byte-for-byte parity.

import { describe, it, expect } from "vitest"
import { buildEventProjectionStmts, CHAIN_MUTATING_KINDS, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { foldProjection, type FoldEvent } from "../../../scripts/lib/fold-projection"

const PROJECT = "proj-1"
const COUNTER_TS = 1_700_000_000_000 // fixed so files.updated_at matches on both sides

let seq = 0
function ev(partial: Partial<PersistedEvent> & { kind: EventKind }): PersistedEvent {
  seq += 1
  return {
    id: partial.id ?? `e${seq}`,
    schemaVersion: 1,
    projectId: PROJECT,
    fileId: null,
    cellId: null,
    parentId: null,
    author: "alice",
    payload: {},
    clientTs: 1000 + seq,
    serverTs: 1000 + seq,
    serverSeq: seq,
    ...partial,
  }
}

const childKey = (e: PersistedEvent) =>
  `${e.projectId}\0${e.fileId ?? ""}\0${e.cellId ?? ""}\0${e.parentId ?? "<null>"}`

// Canonical replay — mirrors the LIVE route (route.ts): the AD-2 winner guard
// applies only to chain-mutating kinds; validates/comments always project.
// (NOT rebuild.ts, which applies the guard to every cell event and so wrongly
// drops cell.validate — the bug this parity suite exists to avoid inheriting.)
async function replayCanonical(db: D1Database, events: PersistedEvent[]): Promise<void> {
  const sorted = [...events].sort(
    (a, b) => a.serverSeq! - b.serverSeq! || a.serverTs - b.serverTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const winning = new Map<string, string>()
  const stmts: D1PreparedStatement[] = []
  for (const e of sorted) {
    if (e.cellId && CHAIN_MUTATING_KINDS.has(e.kind)) {
      const k = childKey(e)
      const w = winning.get(k)
      if (!w) winning.set(k, e.id)
      else if (w !== e.id) continue
    }
    buildEventProjectionStmts(db, e, stmts, { deferFileCounters: true })
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100))
  await applyCounters(db)
}

async function applyCounters(db: D1Database): Promise<void> {
  await db
    .prepare(
      `UPDATE files SET
         cell_count = (SELECT COUNT(DISTINCT cell_id) FROM cells WHERE project_id=files.project_id AND file_id=files.id),
         approved_count = (SELECT COUNT(*) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND validated=1),
         filled_count = (SELECT COUNT(*) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND side='target' AND TRIM(value)!=''),
         word_count = (SELECT COALESCE(SUM(word_count),0) FROM cells WHERE project_id=files.project_id AND file_id=files.id AND side='target'),
         last_edit_at = (SELECT MAX(last_edit_at) FROM cells WHERE project_id=files.project_id AND file_id=files.id),
         updated_at = ?
       WHERE project_id = ?`,
    )
    .bind(COUNTER_TS, PROJECT)
    .run()
}

function toFold(e: PersistedEvent): FoldEvent {
  return {
    id: e.id,
    projectId: e.projectId,
    fileId: e.fileId,
    cellId: e.cellId,
    parentId: e.parentId,
    kind: e.kind,
    author: e.author,
    payload: e.payload as Record<string, unknown>,
    serverTs: e.serverTs,
    serverSeq: e.serverSeq!,
  }
}

// Bulk-insert fold rows into a fresh PGlite, then run the same counter pass.
async function buildFold(db: TestDb, events: PersistedEvent[]): Promise<void> {
  const rows = foldProjection(events.map(toFold))
  for (const [table, list] of Object.entries(rows)) {
    for (const row of list as Array<Record<string, unknown>>) {
      const cols = Object.keys(row)
      const ph = cols.map((_, i) => `$${i + 1}`).join(",")
      await db.pg.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${ph})`, cols.map((c) => row[c]))
    }
  }
  await applyCounters(db.db)
}

const VOLATILE: Record<string, Set<string>> = {
  files: new Set(["created_at", "updated_at"]), // canonical uses now()
}

function normalize(table: string, rows: Array<Record<string, unknown>>): string {
  const drop = VOLATILE[table] ?? new Set<string>()
  const clean = rows.map((r) => {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(r).sort()) if (!drop.has(k) && k !== "value_tsv") o[k] = r[k]
    return o
  })
  clean.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify(clean, null, 2)
}

async function assertParity(events: PersistedEvent[]): Promise<void> {
  const ref = await makeTestDb()
  const fold = await makeTestDb()
  try {
    await replayCanonical(ref.db, events)
    await buildFold(fold, events)
    for (const table of ["cells", "cell_validators", "files", "comments"]) {
      const a = normalize(table, await ref.rows(table))
      const b = normalize(table, await fold.rows(table))
      expect(b, `table ${table} diverged from canonical`).toBe(a)
    }
  } finally {
    await ref.close()
    await fold.close()
  }
}

describe("foldProjection parity with canonical replay", () => {
  it("source create → target commit → validate on one cell", async () => {
    const file = "f1"
    const create = ev({ kind: "source.cell.create", fileId: file, cellId: "c1", payload: { value: "In the beginning" } })
    const fileCreate = ev({ kind: "file.create", fileId: file, payload: { name: "Genesis", fileType: "scripture" } })
    const commit = ev({
      kind: "target.cell.commit",
      fileId: file,
      cellId: "c1",
      parentId: create.id,
      payload: { value: "Au commencement", sourceEventId: create.id },
    })
    const validate = ev({
      kind: "cell.validate",
      fileId: file,
      cellId: "c1",
      payload: { editEventId: commit.id },
    })
    await assertParity([fileCreate, create, commit, validate])
  })

  it("AD-2: two sibling creates at the same slot — first wins", async () => {
    const file = "f1"
    const a = ev({ id: "aaa", kind: "source.cell.create", fileId: file, cellId: "c1", payload: { value: "first" } })
    const b = ev({ id: "bbb", kind: "source.cell.create", fileId: file, cellId: "c1", payload: { value: "loser" } })
    await assertParity([a, b])
  })

  it("chained target commits — final value is the last commit", async () => {
    const file = "f1"
    const create = ev({ kind: "source.cell.create", fileId: file, cellId: "c1", payload: { value: "src" } })
    const c1 = ev({ kind: "target.cell.commit", fileId: file, cellId: "c1", parentId: create.id, payload: { value: "draft" } })
    const c2 = ev({ kind: "target.cell.commit", fileId: file, cellId: "c1", parentId: c1.id, payload: { value: "final" } })
    await assertParity([create, c1, c2])
  })

  it("validation resets when a later commit moves the chain head", async () => {
    const file = "f1"
    const create = ev({ kind: "source.cell.create", fileId: file, cellId: "c1", payload: { value: "src" } })
    const c1 = ev({ kind: "target.cell.commit", fileId: file, cellId: "c1", parentId: create.id, payload: { value: "v1" } })
    const validate = ev({ kind: "cell.validate", fileId: file, cellId: "c1", payload: { editEventId: c1.id } })
    // New commit after the validation — chain head moves, so validated must drop to 0.
    const c2 = ev({ kind: "target.cell.commit", fileId: file, cellId: "c1", parentId: c1.id, payload: { value: "v2" } })
    await assertParity([create, c1, validate, c2])
  })

  it("multiple validators on the current head accumulate endorsement_count", async () => {
    const file = "f1"
    const create = ev({ kind: "source.cell.create", fileId: file, cellId: "c1", payload: { value: "src" } })
    const c1 = ev({ kind: "target.cell.commit", fileId: file, cellId: "c1", parentId: create.id, payload: { value: "v1" } })
    const va = ev({ kind: "cell.validate", author: "alice", fileId: file, cellId: "c1", payload: { editEventId: c1.id } })
    const vb = ev({ kind: "cell.validate", author: "bob", fileId: file, cellId: "c1", payload: { editEventId: c1.id } })
    await assertParity([create, c1, va, vb])
  })

  it("comments: create, duplicate create (no-op), resolve, reply-resolve no-op", async () => {
    const file = "f1"
    const c = ev({ kind: "comment.create", payload: { commentId: "cm1", scope: { kind: "file", fileId: file }, body: "hi", parentCommentId: null } })
    const dup = ev({ kind: "comment.create", payload: { commentId: "cm1", scope: { kind: "file", fileId: file }, body: "OVERWRITE?", parentCommentId: null } })
    const reply = ev({ kind: "comment.create", payload: { commentId: "cm2", scope: { kind: "file", fileId: file }, body: "re", parentCommentId: "cm1" } })
    const resolveTop = ev({ kind: "comment.resolve", payload: { commentId: "cm1", resolved: true } })
    const resolveReply = ev({ kind: "comment.resolve", payload: { commentId: "cm2", resolved: true } })
    await assertParity([c, dup, reply, resolveTop, resolveReply])
  })

  it("multi-file / multi-cell mixture", async () => {
    const events: PersistedEvent[] = []
    for (const f of ["fa", "fb"]) {
      events.push(ev({ kind: "file.create", fileId: f, payload: { name: f, fileType: "scripture", sourceLanguage: "en", targetLanguage: "fr" } }))
      for (const cell of ["c1", "c2", "c3"]) {
        const cr = ev({ kind: "source.cell.create", fileId: f, cellId: cell, payload: { value: `${f}-${cell}-src` } })
        events.push(cr)
        const cm = ev({ kind: "target.cell.commit", fileId: f, cellId: cell, parentId: cr.id, payload: { value: `${f}-${cell}-tgt` } })
        events.push(cm)
        if (cell !== "c3") events.push(ev({ kind: "cell.validate", fileId: f, cellId: cell, payload: { editEventId: cm.id } }))
      }
    }
    await assertParity(events)
  })
})
