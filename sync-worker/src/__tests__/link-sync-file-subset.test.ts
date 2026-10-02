// AQU-1559: a link that follows only SOME of the upstream's files.
//
// Until this slice `source_project_id` meant "mirror everything this upstream
// has, including what it gains later". A team that wanted one book's source out
// of a project holding a whole Bible got all of it and had to delete the rest by
// hand — and because the link is live, the upstream's later files kept arriving.
//
// The selection is a JSON array of UPSTREAM file ids on
// `projects.source_link_file_ids` (migration 0126); NULL is the whole-project
// link every existing row has. These tests pin what the mirror does with each:
//
//   1. A subset link mirrors the picked files and nothing else.
//   2. An upstream edit to an unpicked file is a true no-op — no mirror event,
//      no `link.cursor.advance` (so nothing in "Upstream changes"), and the
//      cursor still moves so it is not re-folded forever.
//   3. A file the upstream gains after a subset link does not appear here; the
//      same file DOES appear under a whole-project link (today's behaviour,
//      which this slice must not change).
//   4. Renaming a picked file upstream still reaches the downstream copy — the
//      selection follows the file's identity, not its name.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-upstream-bible"
const DOWNSTREAM = "proj-downstream-team"
const MAT = "file-up-mat"
const MRK = "file-up-mrk"
const LUK = "file-up-luk"

let seq = 0

async function emit(
  t: TestDb,
  projectId: string,
  kind: EventKind,
  args: { id?: string; fileId?: string; cellId?: string; parentId?: string | null; payload: Record<string, unknown> },
): Promise<string> {
  seq += 1
  const id = args.id ?? `evt-${seq}`
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  const serverSeq = Number(seqRow.rows[0]?.next_seq ?? 1)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $5, $6, 'lead', $7, $8, $9, $10)`,
    [
      id,
      projectId,
      args.fileId ?? null,
      args.cellId ?? null,
      args.parentId ?? null,
      kind,
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
    author: "lead",
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

/** One upstream file with one source cell. */
async function seedUpstreamFile(t: TestDb, fileId: string, name: string, value: string): Promise<void> {
  await emit(t, UPSTREAM, "file.create", { fileId, payload: { name, fileType: "codex" } })
  await emit(t, UPSTREAM, "source.cell.create", {
    fileId,
    cellId: `${fileId}-1`,
    payload: { cellId: `${fileId}-1`, value },
  })
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream Bible', 1)`, [UPSTREAM])
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Downstream Team', 1)`, [DOWNSTREAM])
  await seedUpstreamFile(t, MAT, "MAT.usfm", "The book of the generation")
  await seedUpstreamFile(t, MRK, "MRK.usfm", "The beginning of the gospel")
  await seedUpstreamFile(t, LUK, "LUK.usfm", "Forasmuch as many have taken in hand")
}

/** What POST /link-source writes. `fileIds` null = the whole-project link. */
async function link(t: TestDb, fileIds: string[] | null): Promise<void> {
  await t.pg.query(
    `UPDATE projects
        SET source_project_id = $2, source_link_mode = 'live',
            source_link_consumes = 'source', source_link_gate = 'validated',
            source_link_file_ids = $3, source_link_cursor = 0
      WHERE id = $1`,
    [DOWNSTREAM, UPSTREAM, fileIds ? JSON.stringify(fileIds) : null],
  )
}

async function downstreamFileNames(t: TestDb): Promise<string[]> {
  const rows = await t.pg.query<{ name: string }>(
    `SELECT name FROM files WHERE project_id = $1 ORDER BY name`,
    [DOWNSTREAM],
  )
  return rows.rows.map((r) => r.name)
}

async function cursorOf(t: TestDb): Promise<number> {
  const row = await t.pg.query<{ source_link_cursor: string }>(
    `SELECT source_link_cursor FROM projects WHERE id = $1`,
    [DOWNSTREAM],
  )
  return Number(row.rows[0]?.source_link_cursor ?? 0)
}

async function cursorAdvanceCount(t: TestDb): Promise<number> {
  const row = await t.pg.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = $1 AND kind = 'link.cursor.advance'`,
    [DOWNSTREAM],
  )
  return Number(row.rows[0]?.n ?? 0)
}

describe("mirrorSync — a link that follows a subset of the upstream's files (AQU-1559)", () => {
  // WHY: the slice itself. Two of three files picked means two files and two
  // cells, and the third's content must not be anywhere in this project.
  it("mirrors only the picked files", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await link(t, [MAT, MRK])

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.ranSync).toBe(true)
      expect(result.filesMirrored).toBe(2)
      expect(result.cellsMirrored).toBe(2)
      expect(await downstreamFileNames(t)).toEqual(["MAT.usfm", "MRK.usfm"])

      // Nothing of the unpicked file reached this project — not its file row,
      // not its cell.
      const luk = await t.pg.query(
        `SELECT 1 FROM cells WHERE project_id = $1 AND file_id = $2`,
        [DOWNSTREAM, deterministicDownstreamFileId(DOWNSTREAM, LUK)],
      )
      expect(luk.rows).toHaveLength(0)
    } finally {
      await t.close()
    }
  })

  // WHY: an edit to a file this link does not follow has to be invisible here,
  // and "invisible" includes the audit trail — a `link.cursor.advance` would put
  // a change the team cannot see in their "Upstream changes" list. The cursor
  // must still move, or every later sync would re-fold the same event.
  it("ignores an upstream edit to an unpicked file, with no entry to show for it", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await link(t, [MAT, MRK])
      await mirrorSync(t.db, DOWNSTREAM)
      const advancesAfterSeed = await cursorAdvanceCount(t)

      await emit(t, UPSTREAM, "source.cell.commit", {
        fileId: LUK,
        cellId: `${LUK}-1`,
        payload: { value: "Forasmuch as many have taken it in hand" },
      })
      const result = await mirrorSync(t.db, DOWNSTREAM)

      // The sync ran (the probe cannot tell lanes apart by file) and folded to
      // nothing.
      expect(result.ranSync).toBe(true)
      expect(result.cellsMirrored).toBe(0)
      expect(result.filesMirrored).toBe(0)
      expect(await cursorAdvanceCount(t)).toBe(advancesAfterSeed)
      expect(await downstreamFileNames(t)).toEqual(["MAT.usfm", "MRK.usfm"])
      // …and the window is not left to be re-folded forever.
      expect(await cursorOf(t)).toBe(result.toSeq)
    } finally {
      await t.close()
    }
  })

  // WHY: the half that makes a subset link a different product. A fixed list
  // cannot contain a file that did not exist when it was written, so the
  // upstream's next import stays upstream.
  it("does not bring in a file the upstream gains after a subset link", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await link(t, [MAT, MRK])
      await mirrorSync(t.db, DOWNSTREAM)

      await seedUpstreamFile(t, "file-up-jhn", "JHN.usfm", "In the beginning was the Word")
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamFileNames(t)).toEqual(["MAT.usfm", "MRK.usfm"])
    } finally {
      await t.close()
    }
  })

  // WHY: the regression guard for every link that already exists. A link made
  // with everything checked stores NULL and must keep following the whole
  // project, new files included — the behaviour this slice is explicitly not
  // changing.
  it("still brings in a new upstream file under a whole-project link", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await link(t, null)
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamFileNames(t)).toEqual(["LUK.usfm", "MAT.usfm", "MRK.usfm"])

      await seedUpstreamFile(t, "file-up-jhn", "JHN.usfm", "In the beginning was the Word")
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamFileNames(t)).toEqual([
        "JHN.usfm",
        "LUK.usfm",
        "MAT.usfm",
        "MRK.usfm",
      ])
    } finally {
      await t.close()
    }
  })

  // WHY: the selection follows the FILE, not its name — ids are stable across a
  // rename and names are not. A rename upstream has to reach the downstream copy
  // (AQU-1358's behaviour) and must not drop the file out of the selection.
  it("keeps a picked file linked through an upstream rename", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await link(t, [MAT, MRK])
      await mirrorSync(t.db, DOWNSTREAM)

      await emit(t, UPSTREAM, "file.rename", {
        fileId: MRK,
        payload: { fileId: MRK, name: "Mark (2026 revision).usfm" },
      })
      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.filesMirrored).toBe(1)
      expect(await downstreamFileNames(t)).toEqual(["MAT.usfm", "Mark (2026 revision).usfm"])
    } finally {
      await t.close()
    }
  })
})
