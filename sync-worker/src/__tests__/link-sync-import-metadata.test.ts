// AQU-1520: a live link mirrors the import envelope, so the downstream's
// section navigator shows the upstream's real divisions.
//
// The `consumes='source'` fold carried text and structure — `type`,
// `canonicalRef`, `anchorCellId`, timing — but never `metadata`. That bucket
// holds the import envelope (`aquillaImport.milestone`), which is what
// `deriveMilestoneNavigation()` reads to title the section navigator. Without
// it a mirrored Biblica Study Notes file fell back to the app-invented "Part N"
// pages while its upstream showed "Acts Preface" and the named chapter
// sections. A Scripture file looked fine throughout, because its divisions come
// off `canonicalRef`, which the fold already copied — which is why the loss
// only ever showed on files whose divisions live in the envelope.
//
// The sibling `consumes='target'` fold already merged `metadata` in from the
// upstream's own source row (AQU-477), which is why "One of its Targets" was
// unaffected and "Its Source" was not. Pinned here so the two folds cannot
// drift apart again.
//
// Same family as AQU-1453 (the live link ignored hide/show).

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { headParentFor } from "./helpers/chain-parent"

const UPSTREAM = "proj-meta-upstream"
const DOWNSTREAM = "proj-meta-downstream"
const FILE = "file-act"
const DOWNSTREAM_FILE = deterministicDownstreamFileId(DOWNSTREAM, FILE)

type UpstreamKind =
  | "file.create"
  | "source.cell.create"
  | "source.cell.commit"
  | "source.cell.visibility.set"

let _seq = 0
function nextId(): string {
  _seq += 1
  return `evt-meta-${_seq}`
}

/** The envelope an imported study-notes cell carries. */
function envelope(label: string, key: string): Record<string, unknown> {
  return { aquillaImport: { milestone: { kind: "section", key, label, shortLabel: label } } }
}

/** The milestone label the navigator would derive, read the way it reads it. */
function labelOf(metadata: unknown): string | undefined {
  const envelopeValue = (metadata as { aquillaImport?: unknown } | null | undefined)?.aquillaImport
  const milestone = (envelopeValue as { milestone?: { label?: unknown } } | undefined)?.milestone
  return typeof milestone?.label === "string" ? milestone.label : undefined
}

async function seedProjects(t: TestDb, consumes: "source" | "target" = "source"): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream', 1)`, [UPSTREAM])
  await t.pg.query(
    `INSERT INTO projects (id, name, created_by, source_project_id, source_link_mode, source_link_consumes, source_link_cursor)
     VALUES ($1, 'Downstream', 1, $2, 'live', $3, 0)`,
    [DOWNSTREAM, UPSTREAM, consumes],
  )
}

async function emitUpstream(
  t: TestDb,
  kind: UpstreamKind,
  args: { fileId?: string; cellId?: string; payload: Record<string, unknown> },
): Promise<void> {
  const id = nextId()
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [UPSTREAM],
  )
  const seq = Number(seqRow.rows[0]?.next_seq ?? 1)
  const parentId = await headParentFor(t, UPSTREAM, kind, args.fileId, args.cellId, args.payload)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $9, $5, 'lead', $6, 1, $7, $8)`,
    [id, UPSTREAM, args.fileId ?? null, args.cellId ?? null, kind, JSON.stringify(args.payload), seq, seq, parentId],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId: UPSTREAM,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId,
    kind,
    author: "lead",
    payload: args.payload,
    clientTs: 1,
    serverTs: seq,
    serverSeq: seq,
  }
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
}

/**
 * An upstream study-notes file: two cells titled "Acts Preface", one "Acts 1",
 * and one with no envelope at all (the division-less case that must stay
 * un-titled downstream).
 */
async function seedStudyNotes(t: TestDb): Promise<void> {
  await emitUpstream(t, "file.create", { fileId: FILE, payload: { name: "ACT-REV", fileType: "codex" } })
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId: "cell-1",
    payload: {
      cellId: "cell-1",
      value: "Luke wrote Acts",
      anchorCellId: null,
      metadata: envelope("Acts Preface", "section:acts-preface"),
    },
  })
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId: "cell-2",
    payload: {
      cellId: "cell-2",
      value: "It continues the Gospel",
      anchorCellId: null,
      metadata: envelope("Acts Preface", "section:acts-preface"),
    },
  })
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId: "cell-3",
    payload: {
      cellId: "cell-3",
      value: "Notes on Acts 1",
      anchorCellId: null,
      metadata: envelope("Acts 1", "section:acts-1"),
    },
  })
  await emitUpstream(t, "source.cell.create", {
    fileId: FILE,
    cellId: "cell-4",
    payload: { cellId: "cell-4", value: "An untitled remark", anchorCellId: null },
  })
}

async function downstreamCell(
  t: TestDb,
  cellId: string,
): Promise<{ value: string; metadata: unknown } | undefined> {
  const r = await t.pg.query<{ value: string; metadata: unknown }>(
    `SELECT value, metadata FROM cells
      WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'source'`,
    [DOWNSTREAM, DOWNSTREAM_FILE, cellId],
  )
  return r.rows[0]
}

describe("mirrorSync — the live link carries the import envelope (AQU-1520)", () => {
  it("mirrors each cell's section title, so the navigator shows 'Acts Preface' not 'Part 1'", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedStudyNotes(t)

      const result = await mirrorSync(t.db, DOWNSTREAM)
      expect(result.ranSync).toBe(true)

      expect(labelOf((await downstreamCell(t, "cell-1"))?.metadata)).toBe("Acts Preface")
      expect(labelOf((await downstreamCell(t, "cell-2"))?.metadata)).toBe("Acts Preface")
      expect(labelOf((await downstreamCell(t, "cell-3"))?.metadata)).toBe("Acts 1")
      // The text still arrives as it always did.
      expect((await downstreamCell(t, "cell-1"))?.value).toBe("Luke wrote Acts")
    } finally {
      await t.close()
    }
  })

  it("invents no title for a cell the upstream has none for", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedStudyNotes(t)
      await mirrorSync(t.db, DOWNSTREAM)

      // An upstream file with no divisions of its own still shows "Part N"
      // downstream (acceptance criterion 6) — nothing is manufactured.
      expect((await downstreamCell(t, "cell-4"))?.metadata).toBeNull()
    } finally {
      await t.close()
    }
  })

  it("a later file imported upstream arrives downstream with its titles", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedStudyNotes(t)
      await mirrorSync(t.db, DOWNSTREAM)

      // Acceptance criterion 5: source material added AFTER the link was made
      // travels with its divisions too, not just the initial seed.
      const LATER = "file-isa"
      await emitUpstream(t, "file.create", { fileId: LATER, payload: { name: "ISA-MAL", fileType: "codex" } })
      await emitUpstream(t, "source.cell.create", {
        fileId: LATER,
        cellId: "cell-9",
        payload: {
          cellId: "cell-9",
          value: "Notes on Isaiah",
          anchorCellId: null,
          metadata: envelope("Isaiah Preface", "section:isaiah-preface"),
        },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      const r = await t.pg.query<{ metadata: unknown }>(
        `SELECT metadata FROM cells
          WHERE project_id = $1 AND file_id = $2 AND cell_id = 'cell-9' AND side = 'source'`,
        [DOWNSTREAM, deterministicDownstreamFileId(DOWNSTREAM, LATER)],
      )
      expect(labelOf(r.rows[0]?.metadata)).toBe("Isaiah Preface")
    } finally {
      await t.close()
    }
  })

  it("a text-only edit upstream does not erase the title it carries no copy of", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedStudyNotes(t)
      await mirrorSync(t.db, DOWNSTREAM)

      // A `source.cell.commit` payload is text only. If the mirror sent
      // `metadata: null` for it, every upstream typo fix would strip the
      // downstream cell's section title — a slower version of the same bug.
      await emitUpstream(t, "source.cell.commit", {
        fileId: FILE,
        cellId: "cell-1",
        payload: { value: "Luke wrote the Acts of the Apostles" },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      const mirrored = await downstreamCell(t, "cell-1")
      expect(mirrored?.value).toBe("Luke wrote the Acts of the Apostles")
      expect(labelOf(mirrored?.metadata)).toBe("Acts Preface")
    } finally {
      await t.close()
    }
  })

  it("a park upstream mirrors without stripping the parked cell's title", async () => {
    const t = await makeTestDb()
    try {
      await seedProjects(t)
      await seedStudyNotes(t)
      await mirrorSync(t.db, DOWNSTREAM)

      // AQU-1453's visibility-only path resolves the cell against the
      // upstream's LIVE row, so the envelope has to come off that row too —
      // otherwise parking a cell quietly un-titles it downstream.
      await emitUpstream(t, "source.cell.visibility.set", {
        fileId: FILE,
        cellId: "cell-3",
        payload: { hidden: true },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      const r = await t.pg.query<{ metadata: unknown; hidden_at: string | null }>(
        `SELECT metadata, hidden_at FROM cells
          WHERE project_id = $1 AND file_id = $2 AND cell_id = 'cell-3' AND side = 'source'`,
        [DOWNSTREAM, DOWNSTREAM_FILE],
      )
      expect(r.rows[0]?.hidden_at).not.toBeNull()
      expect(labelOf(r.rows[0]?.metadata)).toBe("Acts 1")
    } finally {
      await t.close()
    }
  })
})
