// AQU-1603: a file the upstream moved to Recently deleted BEFORE the link
// existed is never brought into the linked project.
//
// The report: creating a project as a Linked Target with every listed file left
// checked — the default, which writes the whole-project link (`null` selection)
// — brought in a file the upstream had deleted. It arrived as an ordinary live
// file with its source text, so the new project held three files when the
// dialog had listed and counted two. The first sync of a whole-project link
// folds the upstream's WHOLE history, and that history still carries the
// deleted file's `file.create`; `file.delete` is deliberately not a
// lane-relevant kind, so nothing countered it downstream. A subset link escaped
// only because the picked list could not name a file the dialog never offered.
//
// These tests pin the rule and its edges:
//
//   1. A whole-project link leaves the upstream's deleted file out — no file
//      row, no cells, and not in the downstream's own Recently deleted either.
//   2. The downstream's file count equals what the dialog counts (the
//      upstream's live files).
//   3. A file ADDED upstream after a whole-project link still arrives — the
//      guard must not turn a whole-project link into a frozen subset.
//   4. An upstream with an empty Recently deleted links exactly as before.
//   5. A file deleted and then restored upstream BEFORE the link is made does
//      arrive — the guard reads the upstream's state at sync time, it does not
//      blacklist an id that ever carried a `file.delete`.
//   6. A file deleted upstream AFTER it was already mirrored keeps its
//      downstream copy: what an upstream deletes once a link exists is an open
//      product question and explicitly out of this ticket's scope.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import type { AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const UPSTREAM = "proj-upstream-pentateuch"
const DOWNSTREAM = "proj-downstream-linked"
const GEN = "file-up-gen"
const EXO = "file-up-exo"
const LEV = "file-up-lev"

let seq = 0

async function emit(
  t: TestDb,
  projectId: string,
  kind: EventKind,
  args: { fileId?: string; cellId?: string; payload: Record<string, unknown> },
): Promise<void> {
  seq += 1
  const id = `evt-${seq}`
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  const serverSeq = Number(seqRow.rows[0]?.next_seq ?? 1)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, NULL, $5, 'lead', $6, $7, $8, $9)`,
    [id, projectId, args.fileId ?? null, args.cellId ?? null, kind, JSON.stringify(args.payload), serverSeq, serverSeq, serverSeq],
  )
  const event: PersistedEvent = {
    id,
    schemaVersion: 1,
    projectId,
    fileId: args.fileId ?? null,
    cellId: args.cellId ?? null,
    parentId: null,
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

/** What the file list's "Move to Recently deleted" emits. */
async function deleteUpstreamFile(t: TestDb, fileId: string): Promise<void> {
  await emit(t, UPSTREAM, "file.delete", { fileId, payload: { fileId } })
}

async function restoreUpstreamFile(t: TestDb, fileId: string): Promise<void> {
  await emit(t, UPSTREAM, "file.restore", { fileId, payload: { fileId } })
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Upstream A', 1)`, [UPSTREAM])
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Linked Target', 1)`, [DOWNSTREAM])
  await seedUpstreamFile(t, GEN, "GEN.usfm", "In the beginning")
  await seedUpstreamFile(t, EXO, "EXO.usfm", "Now these are the names")
  await seedUpstreamFile(t, LEV, "LEV.usfm", "And the LORD called unto Moses")
}

/** What POST /link-source writes. `fileIds` null = every file checked, i.e. the
 *  whole-project link — the default the report was filed against. */
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

/** Live downstream file names — what the file list shows. */
async function downstreamFileNames(t: TestDb): Promise<string[]> {
  const rows = await t.pg.query<{ name: string }>(
    `SELECT name FROM files WHERE project_id = $1 AND deleted_at IS NULL ORDER BY name`,
    [DOWNSTREAM],
  )
  return rows.rows.map((r) => r.name)
}

/** Every downstream file row, deleted ones included — so a test can tell "never
 *  brought in" from "brought in and then tombstoned". */
async function downstreamFileRowCount(t: TestDb): Promise<number> {
  const row = await t.pg.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM files WHERE project_id = $1`,
    [DOWNSTREAM],
  )
  return Number(row.rows[0]?.n ?? 0)
}

async function downstreamCellCountFor(t: TestDb, upstreamFileId: string): Promise<number> {
  const row = await t.pg.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM cells WHERE project_id = $1 AND file_id = $2`,
    [DOWNSTREAM, deterministicDownstreamFileId(DOWNSTREAM, upstreamFileId)],
  )
  return Number(row.rows[0]?.n ?? 0)
}

describe("mirrorSync — the upstream's Recently deleted does not reach a new link (AQU-1603)", () => {
  // WHY: the report itself. Every file checked (the whole-project link), LEV in
  // the upstream's Recently deleted, so the dialog listed and counted two.
  it("leaves a file deleted upstream before the link out of a whole-project link", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await deleteUpstreamFile(t, LEV)
      await link(t, null)

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.ranSync).toBe(true)
      expect(result.filesMirrored).toBe(2)
      expect(await downstreamFileNames(t)).toEqual(["EXO.usfm", "GEN.usfm"])
      // Never brought in, rather than brought in and then removed: no row at
      // all, so the downstream's own Recently deleted is empty too.
      expect(await downstreamFileRowCount(t)).toBe(2)
      // And none of its source text came through on the cells' own events.
      expect(await downstreamCellCountFor(t, LEV)).toBe(0)
      expect(result.cellsMirrored).toBe(2)
    } finally {
      await t.close()
    }
  })

  // WHY: a subset link is how the report said to avoid the bug. It must keep
  // working, and the deleted file must stay out even if its id is in the list
  // (an id written before the upstream deleted it).
  it("leaves it out of a subset link that still names it", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await deleteUpstreamFile(t, LEV)
      await link(t, [GEN, LEV])

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.filesMirrored).toBe(1)
      expect(await downstreamFileNames(t)).toEqual(["GEN.usfm"])
      expect(await downstreamCellCountFor(t, LEV)).toBe(0)
    } finally {
      await t.close()
    }
  })

  // WHY: the guard must not freeze a whole-project link into a subset. The
  // whole point of leaving every file checked is that later files arrive.
  it("still brings in a file added upstream after the link", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await deleteUpstreamFile(t, LEV)
      await link(t, null)
      await mirrorSync(t.db, DOWNSTREAM)

      await seedUpstreamFile(t, "file-up-num", "NUM.usfm", "And the LORD spake unto Moses")
      const second = await mirrorSync(t.db, DOWNSTREAM)

      expect(second.ranSync).toBe(true)
      expect(await downstreamFileNames(t)).toEqual(["EXO.usfm", "GEN.usfm", "NUM.usfm"])
    } finally {
      await t.close()
    }
  })

  // WHY: the guard costs one read on a healthy upstream and must change nothing
  // there — this is the path every existing link takes.
  it("links an upstream with an empty Recently deleted exactly as before", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await link(t, null)

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.filesMirrored).toBe(3)
      expect(await downstreamFileNames(t)).toEqual(["EXO.usfm", "GEN.usfm", "LEV.usfm"])
    } finally {
      await t.close()
    }
  })

  // WHY: the guard asks what the upstream holds AT SYNC TIME rather than
  // blacklisting any id whose history carries a `file.delete`. An upstream that
  // deleted a file and restored it before the link was made is offering that
  // file in the dialog, so it must arrive.
  //
  // (Deliberately before the link: `file.restore`, like `file.delete`, is not a
  // lane-relevant kind, so a restore AFTER a link exists does not even advance
  // the freshness probe. That is the out-of-scope product question — see the
  // ticket — and this test does not pretend otherwise.)
  it("brings in a file the upstream deleted and restored before the link", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await deleteUpstreamFile(t, LEV)
      await restoreUpstreamFile(t, LEV)
      await link(t, null)

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.filesMirrored).toBe(3)
      expect(await downstreamFileNames(t)).toEqual(["EXO.usfm", "GEN.usfm", "LEV.usfm"])
      expect(await downstreamCellCountFor(t, LEV)).toBe(1)
    } finally {
      await t.close()
    }
  })

  // WHY: explicitly out of scope. What the upstream deletes once a link exists
  // needs a product decision, so a file already mirrored here keeps its copy —
  // the guard only ever withholds a file that was never brought in.
  it("keeps a copy the link had already brought in when the upstream deletes it later", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await link(t, null)
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamFileNames(t)).toEqual(["EXO.usfm", "GEN.usfm", "LEV.usfm"])

      await deleteUpstreamFile(t, LEV)
      await seedUpstreamFile(t, "file-up-num", "NUM.usfm", "And the LORD spake unto Moses")
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamFileNames(t)).toEqual(["EXO.usfm", "GEN.usfm", "LEV.usfm", "NUM.usfm"])
      expect(await downstreamCellCountFor(t, LEV)).toBe(1)
    } finally {
      await t.close()
    }
  })
})
