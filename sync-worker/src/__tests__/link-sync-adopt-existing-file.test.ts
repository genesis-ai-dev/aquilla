// AQU-1679: a link that follows INTO a file the project already has.
//
// Linking an established project used to be additive only (AQU-1525): an
// upstream file sharing a name with one of the project's own arrived as a
// second copy, and the team's translations stayed on the unlinked one. A
// Project Lead can now choose to have the link replace the source in the
// existing file instead. auth-worker records that on
// `projects.source_link_adopt` (migration 0137); the mirror sync joins the two
// files line by line and from then on writes the upstream's source onto the
// project's own cells.
//
// These tests drive that through `mirrorSync` and pin:
//
//   1. No second copy arrives, and the target side — translation, validation —
//      is byte-identical afterwards.
//   2. A line whose text was the same keeps its text; one whose text differed
//      takes the upstream's.
//   3. Later upstream edits and deletes land on the project's OWN cell.
//   4. A line only the upstream has is added in place; a line only the project
//      has stays.
//   5. A new link's first sync replays the upstream's whole history, in
//      windows, without re-mirroring the joined lines.
//   6. A file that no longer matches is linked as a separate copy instead.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { headParentFor } from "./helpers/chain-parent"

const UPSTREAM = "proj-upstream-a"
const ESTABLISHED = "proj-established-b"
const OWN_MRK = "file-own-mark"
const UP_MRK = "file-upstream-mark"
const UP_GEN = "file-upstream-genesis"

const MARK = ["The beginning of the gospel", "As it is written in the prophets", "The voice of one crying"]

let seq = 0

async function emit(
  t: TestDb,
  projectId: string,
  kind: EventKind,
  args: { fileId?: string; cellId?: string; parentId?: string | null; author?: string; payload: Record<string, unknown> },
): Promise<string> {
  seq += 1
  const id = `evt-${String(seq).padStart(4, "0")}`
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  const serverSeq = Number(seqRow.rows[0]?.next_seq ?? 1)
  const parentId =
    args.parentId !== undefined
      ? args.parentId
      : await headParentFor(t, projectId, kind, args.fileId, args.cellId, args.payload)
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

/** A file whose lines are chained in order, as an importer writes them. */
async function seedFile(
  t: TestDb,
  projectId: string,
  fileId: string,
  name: string,
  lines: ReadonlyArray<{ cellId: string; value: string }>,
): Promise<Map<string, string>> {
  await emit(t, projectId, "file.create", { fileId, payload: { name, fileType: "codex" } })
  const created = new Map<string, string>()
  let anchor: string | null = null
  for (const line of lines) {
    const id = await emit(t, projectId, "source.cell.create", {
      fileId,
      cellId: line.cellId,
      payload: { cellId: line.cellId, anchorCellId: anchor, value: line.value },
    })
    created.set(line.cellId, id)
    anchor = line.cellId
  }
  return created
}

/** The established project: its own Mark, first line translated and validated. */
async function seedEstablished(t: TestDb, lines: readonly string[] = MARK): Promise<void> {
  const created = await seedFile(
    t, ESTABLISHED, OWN_MRK, "Mark.usfm",
    lines.map((value, i) => ({ cellId: `own-${i + 1}`, value })),
  )
  const src1 = created.get("own-1")!
  const commit = await emit(t, ESTABLISHED, "target.cell.commit", {
    fileId: OWN_MRK,
    cellId: "own-1",
    parentId: src1,
    payload: { value: "Le commencement de l'évangile", sourceEventId: src1 },
  })
  await emit(t, ESTABLISHED, "cell.validate", {
    fileId: OWN_MRK,
    cellId: "own-1",
    author: "reviewer",
    payload: { editEventId: commit },
  })
}

async function seedUpstream(t: TestDb, lines: readonly string[] = MARK): Promise<void> {
  await seedFile(t, UPSTREAM, UP_MRK, "Mark.usfm", lines.map((value, i) => ({ cellId: `up-${i + 1}`, value })))
  await seedFile(t, UPSTREAM, UP_GEN, "Genesis.usfm", [{ cellId: "gen-1", value: "In the beginning" }])
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream English', 1)`, [UPSTREAM])
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Established French', 1)`, [ESTABLISHED])
}

/** What POST /link-source writes when the lead chose to replace Mark's source. */
async function linkReplacingMark(t: TestDb): Promise<void> {
  await t.pg.query(
    `UPDATE projects
        SET source_project_id = $2, source_link_mode = 'live',
            source_link_consumes = 'source', source_link_gate = 'validated',
            source_link_cursor = 0, source_link_adopt = $3
      WHERE id = $1`,
    [ESTABLISHED, UPSTREAM, JSON.stringify({ files: { [UP_MRK]: OWN_MRK }, pending: [UP_MRK] })],
  )
}

async function adoptRecord(t: TestDb): Promise<unknown> {
  const row = await t.pg.query<{ source_link_adopt: string | null }>(
    `SELECT source_link_adopt FROM projects WHERE id = $1`,
    [ESTABLISHED],
  )
  const raw = row.rows[0]?.source_link_adopt
  return raw ? JSON.parse(raw) : null
}

async function fileNames(t: TestDb): Promise<string[]> {
  const rows = await t.pg.query<{ name: string }>(
    `SELECT name FROM files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [ESTABLISHED],
  )
  return rows.rows.map((r) => r.name)
}

async function ownSource(
  t: TestDb,
): Promise<Array<{ cell_id: string; value: string; anchor_cell_id: string | null; upstream_cell_id: string | null; tombstoned: boolean }>> {
  const rows = await t.pg.query<{
    cell_id: string
    value: string
    anchor_cell_id: string | null
    upstream_cell_id: string | null
    tombstoned_at: string | null
  }>(
    `SELECT cell_id, value, anchor_cell_id, upstream_cell_id, tombstoned_at FROM cells
      WHERE project_id = $1 AND file_id = $2 AND side = 'source' ORDER BY cell_id`,
    [ESTABLISHED, OWN_MRK],
  )
  return rows.rows.map((r) => ({
    cell_id: r.cell_id,
    value: r.value,
    anchor_cell_id: r.anchor_cell_id,
    upstream_cell_id: r.upstream_cell_id,
    tombstoned: r.tombstoned_at != null,
  }))
}

async function targetSide(t: TestDb): Promise<{ cells: unknown[]; validators: unknown[] }> {
  const cells = await t.pg.query(
    `SELECT * FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'target' ORDER BY cell_id, target_lang`,
    [ESTABLISHED, OWN_MRK],
  )
  const validators = await t.pg.query(
    `SELECT * FROM cell_validators WHERE project_id = $1 AND file_id = $2 ORDER BY cell_id, username`,
    [ESTABLISHED, OWN_MRK],
  )
  return { cells: cells.rows, validators: validators.rows }
}

async function mirrorEventCount(t: TestDb, fileId: string): Promise<number> {
  const rows = await t.pg.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = $1 AND file_id = $2 AND kind = 'source.cell.mirror'`,
    [ESTABLISHED, fileId],
  )
  return Number(rows.rows[0]?.n ?? 0)
}

describe("mirrorSync — replacing the source of a file the project already has (AQU-1679)", () => {
  it("joins the existing file to its upstream instead of adding a second copy, leaving the translations untouched", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await seedEstablished(t)
      await seedUpstream(t)
      const before = await targetSide(t)
      expect(before.cells).toHaveLength(1)
      expect(before.validators).toHaveLength(1)

      await linkReplacingMark(t)
      const result = await mirrorSync(t.db, ESTABLISHED)
      expect(result.ranSync).toBe(true)
      expect(result.more).toBe(false)

      // One Mark, plus the upstream's other file as an ordinary mirrored copy.
      expect(await fileNames(t)).toEqual(["Genesis.usfm", "Mark.usfm"])
      const copies = await t.pg.query(
        `SELECT 1 FROM cells WHERE project_id = $1 AND file_id = $2`,
        [ESTABLISHED, deterministicDownstreamFileId(ESTABLISHED, UP_MRK)],
      )
      expect(copies.rows).toHaveLength(0)

      // Every line kept its own id and text, and now names its upstream line.
      expect(await ownSource(t)).toEqual([
        { cell_id: "own-1", value: MARK[0], anchor_cell_id: null, upstream_cell_id: "up-1", tombstoned: false },
        { cell_id: "own-2", value: MARK[1], anchor_cell_id: "own-1", upstream_cell_id: "up-2", tombstoned: false },
        { cell_id: "own-3", value: MARK[2], anchor_cell_id: "own-2", upstream_cell_id: "up-3", tombstoned: false },
      ])
      expect(await targetSide(t)).toEqual(before)
      expect(await adoptRecord(t)).toEqual({ files: { [UP_MRK]: OWN_MRK }, pending: [] })

      // Caught up: the next sync has nothing to do.
      const again = await mirrorSync(t.db, ESTABLISHED)
      expect(again.ranSync).toBe(false)
    } finally {
      await t.close()
    }
  })

  it("writes later upstream edits and deletes onto the project's own cells", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await seedEstablished(t)
      await seedUpstream(t)
      await linkReplacingMark(t)
      await mirrorSync(t.db, ESTABLISHED)
      const before = await targetSide(t)

      await emit(t, UPSTREAM, "source.cell.commit", {
        fileId: UP_MRK,
        cellId: "up-2",
        payload: { value: "As it is written in Isaiah the prophet" },
      })
      await emit(t, UPSTREAM, "source.cell.delete", { fileId: UP_MRK, cellId: "up-3", parentId: null, payload: {} })
      const result = await mirrorSync(t.db, ESTABLISHED)
      expect(result.cellsMirrored).toBe(2)

      expect(await ownSource(t)).toEqual([
        { cell_id: "own-1", value: MARK[0], anchor_cell_id: null, upstream_cell_id: "up-1", tombstoned: false },
        {
          cell_id: "own-2",
          value: "As it is written in Isaiah the prophet",
          anchor_cell_id: "own-1",
          upstream_cell_id: "up-2",
          tombstoned: false,
        },
        { cell_id: "own-3", value: MARK[2], anchor_cell_id: "own-2", upstream_cell_id: "up-3", tombstoned: true },
      ])
      // Still one Mark, and still no cell under an upstream id in it.
      expect(await fileNames(t)).toEqual(["Genesis.usfm", "Mark.usfm"])
      expect(await targetSide(t)).toEqual(before)
    } finally {
      await t.close()
    }
  })

  it("replaces a line whose text differs, adds a line only the upstream has, and keeps a line only the project has", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      // The project's copy: line 2 worded differently, and a note of its own at
      // the end. The upstream's: an extra line between 3 and the first note.
      await seedEstablished(t, [MARK[0], "As it is written", MARK[2], "Translator's note", "Second note"])
      await seedFile(t, UPSTREAM, UP_MRK, "Mark.usfm", [
        { cellId: "up-1", value: MARK[0] },
        { cellId: "up-2", value: MARK[1] },
        { cellId: "up-3", value: MARK[2] },
        { cellId: "up-new", value: "A line added upstream" },
        { cellId: "up-4", value: "Translator's note" },
      ])
      const before = await targetSide(t)

      await linkReplacingMark(t)
      await mirrorSync(t.db, ESTABLISHED)

      expect(await ownSource(t)).toEqual([
        { cell_id: "own-1", value: MARK[0], anchor_cell_id: null, upstream_cell_id: "up-1", tombstoned: false },
        // Not the same text, but the one line between two that are: replaced.
        { cell_id: "own-2", value: MARK[1], anchor_cell_id: "own-1", upstream_cell_id: "up-2", tombstoned: false },
        { cell_id: "own-3", value: MARK[2], anchor_cell_id: "own-2", upstream_cell_id: "up-3", tombstoned: false },
        // Now follows the line the upstream has before it.
        { cell_id: "own-4", value: "Translator's note", anchor_cell_id: "up-new", upstream_cell_id: "up-4", tombstoned: false },
        // The project's own line: no counterpart, left exactly as it was.
        { cell_id: "own-5", value: "Second note", anchor_cell_id: "own-4", upstream_cell_id: null, tombstoned: false },
        // The upstream's extra line, added under its own id after own-3.
        { cell_id: "up-new", value: "A line added upstream", anchor_cell_id: "own-3", upstream_cell_id: null, tombstoned: false },
      ])
      expect(await targetSide(t)).toEqual(before)
    } finally {
      await t.close()
    }
  })

  it("does not re-mirror joined lines while the first sync replays the upstream's history in windows", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await seedEstablished(t)
      await seedUpstream(t)
      // History the replay will walk: line 2 was edited away and back, line 3
      // parked and shown again. The upstream's current state is the original.
      await emit(t, UPSTREAM, "source.cell.commit", { fileId: UP_MRK, cellId: "up-2", payload: { value: "A draft wording" } })
      await emit(t, UPSTREAM, "source.cell.visibility.set", { fileId: UP_MRK, cellId: "up-3", payload: { hidden: true } })
      await emit(t, UPSTREAM, "source.cell.commit", { fileId: UP_MRK, cellId: "up-2", payload: { value: MARK[1] } })
      await emit(t, UPSTREAM, "source.cell.visibility.set", { fileId: UP_MRK, cellId: "up-3", payload: { hidden: false } })

      await linkReplacingMark(t)
      const result = await mirrorSync(t.db, ESTABLISHED, { windowEvents: 2 })
      expect(result.windows).toBeGreaterThan(2)

      // Exactly one mirror per joined line — the join itself.
      expect(await mirrorEventCount(t, OWN_MRK)).toBe(3)
      expect((await ownSource(t)).map((r) => [r.cell_id, r.value])).toEqual([
        ["own-1", MARK[0]],
        ["own-2", MARK[1]],
        ["own-3", MARK[2]],
      ])
      const hidden = await t.pg.query(
        `SELECT 1 FROM cells WHERE project_id = $1 AND file_id = $2 AND hidden_at IS NOT NULL`,
        [ESTABLISHED, OWN_MRK],
      )
      expect(hidden.rows).toHaveLength(0)
    } finally {
      await t.close()
    }
  })

  it("links a file that no longer matches as a separate copy, and leaves the project's own file alone", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await seedEstablished(t, ["Something else entirely", "Nothing in common", "With the upstream"])
      await seedUpstream(t)
      const sourceBefore = await ownSource(t)
      const targetBefore = await targetSide(t)

      await linkReplacingMark(t)
      await mirrorSync(t.db, ESTABLISHED)

      expect(await adoptRecord(t)).toBeNull()
      expect(await ownSource(t)).toEqual(sourceBefore)
      expect(await targetSide(t)).toEqual(targetBefore)
      // AQU-1525's behaviour: the upstream's Mark arrives beside the project's.
      expect(await fileNames(t)).toEqual(["Genesis.usfm", "Mark.usfm", "Mark.usfm"])
      const copy = await t.pg.query<{ cell_id: string }>(
        `SELECT cell_id FROM cells WHERE project_id = $1 AND file_id = $2 ORDER BY cell_id`,
        [ESTABLISHED, deterministicDownstreamFileId(ESTABLISHED, UP_MRK)],
      )
      expect(copy.rows.map((r) => r.cell_id)).toEqual(["up-1", "up-2", "up-3"])
    } finally {
      await t.close()
    }
  })

  it("finishes a join that ran out of budget on the next sync", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await seedEstablished(t)
      await seedUpstream(t)
      // A second file of the project's own, to be joined to the upstream's Genesis.
      await seedFile(t, ESTABLISHED, "file-own-genesis", "Genesis.usfm", [{ cellId: "own-gen-1", value: "In the beginning" }])
      await t.pg.query(
        `UPDATE projects
            SET source_project_id = $2, source_link_mode = 'live', source_link_consumes = 'source',
                source_link_cursor = 0, source_link_adopt = $3
          WHERE id = $1`,
        [
          ESTABLISHED,
          UPSTREAM,
          JSON.stringify({
            files: { [UP_MRK]: OWN_MRK, [UP_GEN]: "file-own-genesis" },
            pending: [UP_MRK, UP_GEN],
          }),
        ],
      )

      // No budget at all: one file is joined, then the run stops.
      let clock = 0
      const first = await mirrorSync(t.db, ESTABLISHED, { budgetMs: 0, now: () => clock++ })
      expect(first.more).toBe(true)
      expect(await adoptRecord(t)).toEqual({
        files: { [UP_MRK]: OWN_MRK, [UP_GEN]: "file-own-genesis" },
        pending: [UP_GEN],
      })
      // Nothing has been mirrored in beside the files still waiting.
      expect(await fileNames(t)).toEqual(["Genesis.usfm", "Mark.usfm"])

      const second = await mirrorSync(t.db, ESTABLISHED)
      expect(second.more).toBe(false)
      expect(await adoptRecord(t)).toEqual({
        files: { [UP_MRK]: OWN_MRK, [UP_GEN]: "file-own-genesis" },
        pending: [],
      })
      expect(await fileNames(t)).toEqual(["Genesis.usfm", "Mark.usfm"])
    } finally {
      await t.close()
    }
  })
})
