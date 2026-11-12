// AQU-1562: stopping this project following ONE of the upstream's files.
//
// AQU-1559/AQU-1560 made the file choice growable; it could not shrink. A team
// that linked a file by mistake, or that wanted to take one book in its own
// direction while the rest kept following the upstream, had to delete the file
// (losing its translations) or detach the whole project.
//
// auth-worker narrows `projects.source_link_file_ids` (source-linking-stop-files
// .test.ts covers that half). This is where the narrowing has to MEAN something:
// the selection is what the mirror filters its fold by, so these tests drive
// `mirrorSync` and pin
//
//   1. A stopped file receives nothing further — not content, not a rename, not
//      a hide/show — while every sibling file keeps syncing exactly as before.
//   2. Resuming re-uses the SAME file: no second copy, the source text catches
//      up to the upstream's current text (including whatever changed while it
//      was stopped), and the team's translations are still on it.
//   3. After resuming, later upstream edits reach it again.
//   4. A backfill that finishes while a lead is stopping a file does not put
//      that file back.
//
// Why resuming needs no code of its own: checking a stopped file again is the
// AQU-1560 ADD path, and it lands in the same file row because the downstream
// id is a pure function of (project, upstream file). The replay runs from the
// start of the upstream's history up to the link's cursor — and the cursor kept
// advancing through the stop, since an unfollowed file's events fold to nothing
// but still move it — so the replay's window is exactly the one that contains
// the edits made while the file was stopped.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import type { AquillaDb } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { headParentFor } from "./helpers/chain-parent"

const UPSTREAM = "proj-upstream-gospels"
const DOWNSTREAM = "proj-downstream-c"
const MAT = "file-up-mat"
const MRK = "file-up-mrk"
const LUK = "file-up-luk"

let seq = 0

async function emit(
  t: TestDb,
  projectId: string,
  kind: EventKind,
  args: { fileId?: string; cellId?: string; payload: Record<string, unknown>; author?: string },
): Promise<void> {
  seq += 1
  const id = `evt-1562-${seq}`
  const seqRow = await t.pg.query<{ next_seq: string }>(
    `SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = $1`,
    [projectId],
  )
  const serverSeq = Number(seqRow.rows[0]?.next_seq ?? 1)
  const author = args.author ?? "lead"
  const parentId = await headParentFor(t, projectId, kind, args.fileId, args.cellId, args.payload)
  await t.pg.query(
    `INSERT INTO events (id, schema_version, project_id, file_id, cell_id, parent_id, kind, author, payload, client_ts, server_ts, server_seq)
     VALUES ($1, 1, $2, $3, $4, $9, $5, $6, $7, $8, $8, $8)`,
    [id, projectId, args.fileId ?? null, args.cellId ?? null, kind, author, JSON.stringify(args.payload), serverSeq, parentId],
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
  const stmts: ReturnType<AquillaDb["prepare"]>[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
}

/** A two-cell upstream file. */
async function seedFile(t: TestDb, fileId: string, name: string, values: [string, string]): Promise<void> {
  await emit(t, UPSTREAM, "file.create", { fileId, payload: { name, fileType: "codex" } })
  for (const [i, value] of values.entries()) {
    const cellId = `${fileId}-${i + 1}`
    await emit(t, UPSTREAM, "source.cell.create", { fileId, cellId, payload: { cellId, value, type: "verse" } })
  }
}

const down = (upstreamFileId: string): string => deterministicDownstreamFileId(DOWNSTREAM, upstreamFileId)

/** What POST /link-source writes. `fileIds` null = the whole-project link. */
async function link(t: TestDb, fileIds: string[] | null): Promise<void> {
  await t.pg.query(
    `UPDATE projects
        SET source_project_id = $2, source_link_mode = 'live', source_link_consumes = 'source',
            source_link_gate = 'validated', source_link_file_ids = $3, source_link_cursor = 0
      WHERE id = $1`,
    [DOWNSTREAM, UPSTREAM, fileIds ? JSON.stringify(fileIds) : null],
  )
}

/** What POST /link-source/files/stop writes (auth-worker): the narrowed list. */
async function stopFollowing(t: TestDb, remaining: string[]): Promise<void> {
  await t.pg.query(`UPDATE projects SET source_link_file_ids = $2 WHERE id = $1`, [
    DOWNSTREAM,
    JSON.stringify(remaining),
  ])
}

/** What POST /link-source/files writes — the add path, which is also resume. */
async function addFiles(t: TestDb, fileIds: string[]): Promise<void> {
  await t.pg.query(`UPDATE projects SET source_link_backfill = $2 WHERE id = $1`, [
    DOWNSTREAM,
    JSON.stringify({ fileIds, doneSeq: 0 }),
  ])
}

async function selection(t: TestDb): Promise<string[] | null> {
  const row = await t.pg.query<{ source_link_file_ids: string | null }>(
    `SELECT source_link_file_ids FROM projects WHERE id = $1`,
    [DOWNSTREAM],
  )
  const raw = row.rows[0]?.source_link_file_ids
  return raw ? (JSON.parse(raw) as string[]).sort() : null
}

interface SourceRow {
  cellId: string
  value: string
  hidden: boolean
}

async function sourceRows(t: TestDb, projectId: string, fileId: string): Promise<SourceRow[]> {
  const rows = await t.pg.query<{ cell_id: string; value: string; hidden_at: unknown }>(
    `SELECT cell_id, value, hidden_at FROM cells
      WHERE project_id = $1 AND file_id = $2 AND side = 'source' AND tombstoned_at IS NULL
      ORDER BY cell_id`,
    [projectId, fileId],
  )
  return rows.rows.map((r) => ({ cellId: r.cell_id, value: r.value, hidden: r.hidden_at != null }))
}

async function fileRows(t: TestDb, downstreamFileId: string): Promise<{ id: string; name: string }[]> {
  const rows = await t.pg.query<{ id: string; name: string }>(
    `SELECT id, name FROM files WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL`,
    [DOWNSTREAM, downstreamFileId],
  )
  return rows.rows
}

/** The mirror events for one downstream file — what the "Upstream changes"
 *  review panel groups its entries from (link-cursor-batches-route.ts). */
async function mirrorEventCount(t: TestDb, downstreamFileId: string): Promise<number> {
  const rows = await t.pg.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM events
      WHERE project_id = $1 AND file_id = $2 AND kind IN ('source.cell.mirror', 'file.mirror')`,
    [DOWNSTREAM, downstreamFileId],
  )
  return Number(rows.rows[0]?.n ?? 0)
}

async function targetValue(t: TestDb, downstreamFileId: string, cellId: string): Promise<string | undefined> {
  const rows = await t.pg.query<{ value: string }>(
    `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3 AND side = 'target'`,
    [DOWNSTREAM, downstreamFileId, cellId],
  )
  return rows.rows[0]?.value
}

/** C linked to MAT + MRK (the upstream also has LUK), synced, with a
 *  translation entered in MRK — the work a stop must never cost. */
async function seedLinkedC(t: TestDb): Promise<void> {
  seq = 0
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Gospels', 1)`, [UPSTREAM])
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Team C', 1)`, [DOWNSTREAM])
  await seedFile(t, MAT, "MAT.usfm", ["The book of the generation", "Abraham begat Isaac"])
  await seedFile(t, MRK, "MRK.usfm", ["The beginning of the gospel", "As it is written"])
  await seedFile(t, LUK, "LUK.usfm", ["Forasmuch as many", "It seemed good to me"])
  await link(t, [MAT, MRK])
  await mirrorSync(t.db, DOWNSTREAM)
  await emit(t, DOWNSTREAM, "target.cell.commit", {
    fileId: down(MRK),
    cellId: `${MRK}-1`,
    payload: { value: "Ang simula ng ebanghelyo" },
    author: "translator",
  })
}

/** Everything the upstream does to MRK while C has stopped following it. */
async function upstreamChangesMrk(t: TestDb): Promise<void> {
  await emit(t, UPSTREAM, "source.cell.commit", {
    fileId: MRK,
    cellId: `${MRK}-1`,
    payload: { value: "The beginning of the gospel of Jesus Christ" },
  })
  await emit(t, UPSTREAM, "file.rename", { fileId: MRK, payload: { name: "MRK-revised.usfm" } })
  await emit(t, UPSTREAM, "source.cell.visibility.set", {
    fileId: MRK,
    cellId: `${MRK}-2`,
    payload: { hidden: true },
  })
}

/**
 * `db`, except that the first statement whose SQL contains `sqlFragment` runs
 * `before` first — another writer landing at exactly that point in a sync.
 */
function beforeFirst(db: AquillaDb, sqlFragment: string, before: () => Promise<void>): AquillaDb {
  let fired = false
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop !== "prepare") return Reflect.get(target, prop, receiver)
      return (sql: string) => {
        const stmt = target.prepare(sql)
        if (fired || !sql.includes(sqlFragment)) return stmt
        return {
          bind: (...values: unknown[]) => {
            const bound = stmt.bind(...values)
            return {
              run: async () => {
                if (!fired) {
                  fired = true
                  await before()
                }
                return bound.run()
              },
            }
          },
        }
      }
    },
  }) as AquillaDb
}

describe("mirrorSync — a stopped file (AQU-1562)", () => {
  // WHY: the slice's core promise, and the reason it is only a narrowing of the
  // selection: an unfollowed file folds to nothing, so none of the three ways
  // an upstream can change a file reaches this project any more. The file is
  // still here, with the text it had and the translation on it.
  it("receives no content, no rename and no hide/show, while its siblings keep syncing", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      const mrkBefore = await sourceRows(t, DOWNSTREAM, down(MRK))
      const mrkMirrorsBefore = await mirrorEventCount(t, down(MRK))

      await stopFollowing(t, [MAT])
      await upstreamChangesMrk(t)
      // A sibling changes in the same window, so "nothing synced" cannot pass
      // for "the stopped file was skipped".
      await emit(t, UPSTREAM, "source.cell.commit", {
        fileId: MAT,
        cellId: `${MAT}-1`,
        payload: { value: "The book of the generation of Jesus Christ" },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      // The stopped file: same text, same name, nothing hidden, still one row.
      expect(await sourceRows(t, DOWNSTREAM, down(MRK))).toEqual(mrkBefore)
      // And no mirror event, which is what keeps it out of "Upstream changes":
      // that panel is built from the mirror events a sync produced, so a file
      // the fold drops cannot show an entry there.
      expect(await mirrorEventCount(t, down(MRK))).toBe(mrkMirrorsBefore)
      expect(await fileRows(t, down(MRK))).toEqual([{ id: down(MRK), name: "MRK.usfm" }])
      expect(await targetValue(t, down(MRK), `${MRK}-1`)).toBe("Ang simula ng ebanghelyo")
      // Spelled out, so a broken comparison above cannot pass vacuously.
      expect(mrkBefore).toEqual([
        { cellId: `${MRK}-1`, value: "The beginning of the gospel", hidden: false },
        { cellId: `${MRK}-2`, value: "As it is written", hidden: false },
      ])
      // The still-followed file is unaffected by any of it.
      expect(await sourceRows(t, DOWNSTREAM, down(MAT))).toEqual([
        { cellId: `${MAT}-1`, value: "The book of the generation of Jesus Christ", hidden: false },
        { cellId: `${MAT}-2`, value: "Abraham begat Isaac", hidden: false },
      ])
    } finally {
      await t.close()
    }
  })

  // WHY: a stopped file must not quietly become a second file when the upstream
  // gains one — the fold is filtered by the selection, so a file the upstream
  // adds after the stop does not arrive either (AQU-1559's rule, which is why
  // stopping a file on a whole-project link warns about exactly this).
  it("does not take in a file the upstream gains afterwards", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await stopFollowing(t, [MAT])

      await seedFile(t, "file-up-jhn", "JHN.usfm", ["In the beginning was the Word", "All things were made"])
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await fileRows(t, down("file-up-jhn"))).toEqual([])
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — resuming a stopped file (AQU-1562)", () => {
  // WHY: "checking it again resumes following in the same file: no duplicate
  // file appears, the source text matches the upstream's current text, the
  // translations are still there". The replay covers the window the stop opened,
  // so the edit, the rename and the hide made while it was stopped all land —
  // in the file that was already here, because its id is derived, not minted.
  it("re-uses the same file and brings it to the upstream's current state", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await stopFollowing(t, [MAT])
      await upstreamChangesMrk(t)
      await mirrorSync(t.db, DOWNSTREAM)

      // The lead checks MRK again: the same request the add path makes.
      await addFiles(t, [MRK])
      await mirrorSync(t.db, DOWNSTREAM)

      // Exactly one MRK, carrying the upstream's new name.
      expect(await fileRows(t, down(MRK))).toEqual([{ id: down(MRK), name: "MRK-revised.usfm" }])
      const allMrkNamed = await t.pg.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM files WHERE project_id = $1 AND name LIKE 'MRK%' AND deleted_at IS NULL`,
        [DOWNSTREAM],
      )
      expect(Number(allMrkNamed.rows[0]?.n)).toBe(1)
      // Its source is the upstream's current source, cell for cell.
      expect(await sourceRows(t, DOWNSTREAM, down(MRK))).toEqual(await sourceRows(t, UPSTREAM, MRK))
      expect(await sourceRows(t, DOWNSTREAM, down(MRK))).toEqual([
        { cellId: `${MRK}-1`, value: "The beginning of the gospel of Jesus Christ", hidden: false },
        { cellId: `${MRK}-2`, value: "As it is written", hidden: true },
      ])
      // The translation entered before the stop survived both halves.
      expect(await targetValue(t, down(MRK), `${MRK}-1`)).toBe("Ang simula ng ebanghelyo")
      expect(await selection(t)).toEqual([MAT, MRK].sort())
    } finally {
      await t.close()
    }
  })

  // WHY: "later upstream edits reach it again" — resuming restores the flow, it
  // does not just take one snapshot.
  it("receives later upstream edits again", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await stopFollowing(t, [MAT])
      await mirrorSync(t.db, DOWNSTREAM)
      await addFiles(t, [MRK])
      await mirrorSync(t.db, DOWNSTREAM)

      await emit(t, UPSTREAM, "source.cell.commit", {
        fileId: MRK,
        cellId: `${MRK}-2`,
        payload: { value: "As it is written in the prophets" },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await sourceRows(t, DOWNSTREAM, down(MRK))).toEqual([
        { cellId: `${MRK}-1`, value: "The beginning of the gospel", hidden: false },
        { cellId: `${MRK}-2`, value: "As it is written in the prophets", hidden: false },
      ])
    } finally {
      await t.close()
    }
  })

  // WHY: the replay's last step writes the selection, and it compares against
  // the PENDING column, not that one — so a lead who stops a file while the
  // replay is running would have it put straight back if the write used the
  // selection this run started with. It reads the selection fresh instead.
  it("does not put back a file stopped while a replay was running", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await addFiles(t, [LUK])

      const racing = beforeFirst(t.db, "SET source_link_backfill = ?", async () => {
        // The lead stopping MRK, just as the replay saves its progress.
        await stopFollowing(t, [MAT])
      })
      await mirrorSync(racing, DOWNSTREAM)

      // LUK joined; MRK stayed stopped rather than being resurrected.
      expect(await selection(t)).toEqual([LUK, MAT].sort())
    } finally {
      await t.close()
    }
  })
})
