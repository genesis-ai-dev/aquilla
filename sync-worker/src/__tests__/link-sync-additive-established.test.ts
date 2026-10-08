// AQU-1525: linking an ESTABLISHED project is additive.
//
// Until now a source link could only be set while a project was being created,
// so the mirror sync had only ever seeded an EMPTY downstream. The new entry
// point in Project Settings points it at a project that already holds imported
// files, translations and standing validations — work a team may have spent
// months on. The one thing that must never happen is for the first sync after
// linking to touch any of it.
//
// These tests seed a downstream the way a real established project looks (its
// own file, source cells, a committed translation, a standing validation),
// link it the way the auth-worker's /link-source route does (source_project_id
// + live/source + cursor 0), run the first mirror sync, and pin that:
//
//   1. The upstream's files/cells arrive ALONGSIDE the existing ones.
//   2. Every pre-existing row — file, source cells, target cell, validator —
//      is byte-identical afterwards.
//   3. An upstream file that shares a NAME with an existing file lands as its
//      own row rather than merging into (or overwriting) it. Per the AQU-1525
//      decision the duplicate is allowed and simply appears twice; the warning
//      for it is a follow-up slice (AQU-1526). What is NOT allowed is the
//      existing file's cells being rewritten by the same-named upstream file.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-upstream-a"
const ESTABLISHED = "proj-established-b"
const OWN_FILE = "file-own-mark"
const UPSTREAM_FILE = "file-upstream-genesis"

let seq = 0

async function emit(
  t: TestDb,
  projectId: string,
  kind: EventKind,
  args: { id?: string; fileId?: string; cellId?: string; parentId?: string | null; author?: string; payload: Record<string, unknown> },
): Promise<string> {
  seq += 1
  const id = args.id ?? `evt-${seq}`
  // Per-project server_seq, as the real log stamps it — the freshness probe and
  // the delta fold both read it.
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  const serverSeq = Number(seqRow.rows[0]?.next_seq ?? 1)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      projectId,
      args.fileId ?? null,
      args.cellId ?? null,
      args.parentId ?? null,
      kind,
      args.author ?? "lead",
      JSON.stringify(args.payload),
      serverSeq,
      serverSeq,
      serverSeq,
    ],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId: args.parentId ?? null,
    kind,
    author: args.author ?? "lead",
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

/** The downstream as a real established project: imported file, two source
 *  cells, one committed translation, one standing validation on it. */
async function seedEstablishedProject(t: TestDb, fileName = "Mark.usfm"): Promise<void> {
  await emit(t, ESTABLISHED, "file.create", {
    fileId: OWN_FILE,
    payload: { name: fileName, fileType: "codex" },
  })
  const src1 = await emit(t, ESTABLISHED, "source.cell.create", {
    fileId: OWN_FILE,
    cellId: "own-1",
    payload: { cellId: "own-1", value: "The beginning of the gospel", canonicalRef: "MRK 1:1" },
  })
  await emit(t, ESTABLISHED, "source.cell.create", {
    fileId: OWN_FILE,
    cellId: "own-2",
    payload: { cellId: "own-2", value: "As it is written", canonicalRef: "MRK 1:2" },
  })
  const commit = await emit(t, ESTABLISHED, "target.cell.commit", {
    id: "evt-own-translation",
    fileId: OWN_FILE,
    cellId: "own-1",
    parentId: src1,
    payload: { value: "Le commencement de l'évangile", sourceEventId: src1 },
  })
  await emit(t, ESTABLISHED, "cell.validate", {
    fileId: OWN_FILE,
    cellId: "own-1",
    author: "reviewer",
    payload: { editEventId: commit },
  })
}

async function seedUpstreamProject(t: TestDb, fileName = "Genesis.usfm"): Promise<void> {
  await emit(t, UPSTREAM, "file.create", {
    fileId: UPSTREAM_FILE,
    payload: { name: fileName, fileType: "codex" },
  })
  await emit(t, UPSTREAM, "source.cell.create", {
    fileId: UPSTREAM_FILE,
    cellId: "up-1",
    payload: { cellId: "up-1", value: "In the beginning", canonicalRef: "GEN 1:1" },
  })
  await emit(t, UPSTREAM, "source.cell.create", {
    fileId: UPSTREAM_FILE,
    cellId: "up-2",
    payload: { cellId: "up-2", value: "And the earth was void", canonicalRef: "GEN 1:2" },
  })
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream English', 1)`, [UPSTREAM])
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Established French', 1)`, [ESTABLISHED])
}

/** Exactly what POST /api/v2/projects/:id/link-source writes for a settings
 *  link: live mode, consuming the upstream's source, cursor reset to 0. */
async function linkFromSettings(t: TestDb): Promise<void> {
  await t.pg.query(
    `UPDATE projects
        SET source_project_id = $2, source_link_mode = 'live',
            source_link_consumes = 'source', source_link_gate = 'validated',
            source_link_cursor = 0
      WHERE id = $1`,
    [ESTABLISHED, UPSTREAM],
  )
}

async function ownRows(t: TestDb): Promise<{ cells: unknown[]; files: unknown[]; validators: unknown[] }> {
  const cells = await t.pg.query(
    `SELECT * FROM cells WHERE project_id = $1 AND file_id = $2 ORDER BY cell_id, side, lane_id`,
    [ESTABLISHED, OWN_FILE],
  )
  const files = await t.pg.query(`SELECT * FROM files WHERE project_id = $1 AND id = $2`, [ESTABLISHED, OWN_FILE])
  const validators = await t.pg.query(
    `SELECT * FROM cell_validators WHERE project_id = $1 AND file_id = $2 ORDER BY cell_id, username`,
    [ESTABLISHED, OWN_FILE],
  )
  return { cells: cells.rows, files: files.rows, validators: validators.rows }
}

describe("mirrorSync — first sync after linking an established project (AQU-1525)", () => {
  it("brings the upstream's files in alongside existing work, leaving every pre-existing row untouched", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await seedEstablishedProject(t)
      await seedUpstreamProject(t)

      const before = await ownRows(t)
      // The project really is established: two source cells, one translated
      // and validated. (If this ever reads 0 the preservation check below
      // would pass vacuously.)
      expect(before.cells).toHaveLength(3)
      expect(before.validators).toHaveLength(1)

      await linkFromSettings(t)
      const result = await mirrorSync(t.db, ESTABLISHED)

      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(2)

      // 1) The upstream's file arrived, as its own row with its own cells.
      const mirroredFileId = deterministicDownstreamFileId(ESTABLISHED, UPSTREAM_FILE)
      const mirrored = await t.pg.query<{ cell_id: string; value: string; side: string }>(
        `SELECT cell_id, value, side FROM cells
          WHERE project_id = $1 AND file_id = $2 ORDER BY cell_id`,
        [ESTABLISHED, mirroredFileId],
      )
      expect(mirrored.rows.map((r) => [r.cell_id, r.side, r.value])).toEqual([
        ["up-1", "source", "In the beginning"],
        ["up-2", "source", "And the earth was void"],
      ])
      // Mirrored source cells arrive with no translation of their own.
      expect(mirrored.rows.every((r) => r.side === "source")).toBe(true)

      const files = await t.pg.query<{ id: string }>(
        `SELECT id FROM files WHERE project_id = $1 ORDER BY id`,
        [ESTABLISHED],
      )
      expect(files.rows.map((r) => r.id).sort()).toEqual([OWN_FILE, mirroredFileId].sort())

      // 2) Nothing of the project's own work moved — rows compared whole, so a
      //    silently rewritten event_id/source_event_id (which would make the
      //    translation read as stale) fails this too.
      expect(await ownRows(t)).toEqual(before)
    } finally {
      await t.close()
    }
  })

  it("an upstream file sharing a name with an existing file lands as its own row and does not rewrite it", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await seedEstablishedProject(t, "Genesis.usfm")
      await seedUpstreamProject(t, "Genesis.usfm")

      const before = await ownRows(t)
      await linkFromSettings(t)
      await mirrorSync(t.db, ESTABLISHED)

      const files = await t.pg.query<{ id: string; name: string }>(
        `SELECT id, name FROM files WHERE project_id = $1`,
        [ESTABLISHED],
      )
      // Two rows, same name — the duplicate is the accepted outcome; a single
      // row would mean the mirror had merged into (and overwritten) the
      // project's own file.
      expect(files.rows).toHaveLength(2)
      expect(files.rows.every((r) => r.name === "Genesis.usfm")).toBe(true)
      expect(await ownRows(t)).toEqual(before)
    } finally {
      await t.close()
    }
  })
})
