// AQU-1560: adding more of the upstream's files to an existing link.
//
// AQU-1559 let a link follow a fixed list of upstream files, chosen once. A
// Project Lead can now add files to that list later. The hard part is that a
// file added late cannot arrive from the link's cursor onward: the mirror has
// already folded past most of its history (and dropped it, because the file was
// not followed then). It has to arrive WHOLE.
//
// auth-worker records the addition on `projects.source_link_backfill`
// (migration 0128); the mirror sync replays those files' upstream history up to
// the cursor, then moves them into `source_link_file_ids`. These tests drive
// that through `mirrorSync` and pin:
//
//   1. The file arrives complete — cells last edited long before the link's
//      cursor, hidden cells hidden, section titles, and nothing for a cell the
//      upstream created and then deleted.
//   2. The files already linked, and the team's translations, are untouched:
//      no new rows, no new events.
//   3. Later upstream edits to the added file flow like any other.
//   4. AQU-1559's rule for the result: every upstream file linked = the
//      whole-project link (later upstream files arrive on their own); anything
//      less stays a fixed list.
//   5. An add that stops part-way leaves no half-filled file in the file list
//      and the link following exactly what it followed before; the next sync
//      finishes it.

import { describe, it, expect } from "vitest"
import { mirrorSync, deterministicDownstreamFileId } from "../events/link-sync"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import type { AquillaDb, AquillaStatement } from "../../../db/shim/postgres"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { headParentFor } from "./helpers/chain-parent"

const UPSTREAM = "proj-upstream-gospels"
const DOWNSTREAM = "proj-downstream-c"
const MAT = "file-up-mat"
const MRK = "file-up-mrk"
const LUK = "file-up-luk"
const JHN = "file-up-jhn"

let seq = 0

async function emit(
  t: TestDb,
  projectId: string,
  kind: EventKind,
  args: { fileId?: string; cellId?: string; payload: Record<string, unknown>; author?: string },
): Promise<string> {
  seq += 1
  const id = `evt-${seq}`
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
  const stmts: AquillaStatement[] = []
  buildEventProjectionStmts(t.db, event, stmts)
  await t.db.batch(stmts)
  return id
}

function sectionTitle(label: string): Record<string, unknown> {
  return { aquillaImport: { milestone: { label, key: `section:${label}` } } }
}

/** A one-cell upstream file. */
async function seedSmallFile(t: TestDb, fileId: string, name: string, value: string): Promise<void> {
  await emit(t, UPSTREAM, "file.create", { fileId, payload: { name, fileType: "codex" } })
  await emit(t, UPSTREAM, "source.cell.create", {
    fileId,
    cellId: `${fileId}-1`,
    payload: { cellId: `${fileId}-1`, value },
  })
}

/**
 * LUK, built so that a fold from the link's cursor onward would get it wrong in
 * every way that matters: its cells were created, edited, hidden and deleted
 * BEFORE the downstream ever synced.
 */
async function seedLuke(t: TestDb): Promise<void> {
  await emit(t, UPSTREAM, "file.create", { fileId: LUK, payload: { name: "LUK.usfm", fileType: "codex" } })
  for (const n of [1, 2, 3, 4]) {
    await emit(t, UPSTREAM, "source.cell.create", {
      fileId: LUK,
      cellId: `luk-${n}`,
      payload: {
        cellId: `luk-${n}`,
        value: `Luke 1:${n} first draft`,
        type: "verse",
        canonicalRef: `LUK 1:${n}`,
        metadata: n === 1 ? sectionTitle("Luke 1") : undefined,
      },
    })
  }
  // Edited after creation: the create's text is NOT the text that has to arrive.
  await emit(t, UPSTREAM, "source.cell.commit", {
    fileId: LUK,
    cellId: "luk-1",
    payload: { value: "Forasmuch as many have taken in hand" },
  })
  // Parked by the upstream lead.
  await emit(t, UPSTREAM, "source.cell.visibility.set", { fileId: LUK, cellId: "luk-3", payload: { hidden: true } })
  // Gone upstream: nothing of it may arrive, not even a tombstone.
  await emit(t, UPSTREAM, "source.cell.delete", { fileId: LUK, cellId: "luk-4", payload: {} })
}

async function seedProjects(t: TestDb): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Gospels', 1)`, [UPSTREAM])
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, 'Team C', 1)`, [DOWNSTREAM])
  await seedSmallFile(t, MAT, "MAT.usfm", "The book of the generation")
  await seedLuke(t)
  await seedSmallFile(t, MRK, "MRK.usfm", "The beginning of the gospel")
}

/** What POST /link-source writes. `fileIds` null = the whole-project link. */
async function link(
  t: TestDb,
  fileIds: string[] | null,
  opts: { consumes?: "source" | "target"; gate?: "head" | "validated" } = {},
): Promise<void> {
  await t.pg.query(
    `UPDATE projects
        SET source_project_id = $2, source_link_mode = 'live',
            source_link_consumes = $4, source_link_gate = $5,
            source_link_file_ids = $3, source_link_cursor = 0
      WHERE id = $1`,
    [DOWNSTREAM, UPSTREAM, fileIds ? JSON.stringify(fileIds) : null, opts.consumes ?? "source", opts.gate ?? "validated"],
  )
}

/** What POST /link-source/files writes (auth-worker), before it syncs. */
async function addFiles(t: TestDb, fileIds: string[]): Promise<void> {
  await t.pg.query(`UPDATE projects SET source_link_backfill = $2 WHERE id = $1`, [
    DOWNSTREAM,
    JSON.stringify({ fileIds, doneSeq: 0 }),
  ])
}

async function linkState(t: TestDb): Promise<{ fileIds: string[] | null; backfill: string | null; cursor: number }> {
  const row = await t.pg.query<{ source_link_file_ids: string | null; source_link_backfill: string | null; source_link_cursor: string }>(
    `SELECT source_link_file_ids, source_link_backfill, source_link_cursor FROM projects WHERE id = $1`,
    [DOWNSTREAM],
  )
  const r = row.rows[0]!
  return {
    fileIds: r.source_link_file_ids ? (JSON.parse(r.source_link_file_ids) as string[]).sort() : null,
    backfill: r.source_link_backfill,
    cursor: Number(r.source_link_cursor),
  }
}

async function downstreamFileNames(t: TestDb): Promise<string[]> {
  const rows = await t.pg.query<{ name: string }>(`SELECT name FROM files WHERE project_id = $1 ORDER BY name`, [DOWNSTREAM])
  return rows.rows.map((r) => r.name)
}

interface SourceRow {
  cellId: string
  value: string
  hidden: boolean
  title: string | null
}

async function sourceRows(t: TestDb, projectId: string, fileId: string): Promise<SourceRow[]> {
  const rows = await t.pg.query<{ cell_id: string; value: string; hidden_at: unknown; metadata: unknown }>(
    `SELECT cell_id, value, hidden_at, metadata FROM cells
      WHERE project_id = $1 AND file_id = $2 AND side = 'source' AND tombstoned_at IS NULL
      ORDER BY cell_id`,
    [projectId, fileId],
  )
  return rows.rows.map((r) => {
    const label = (r.metadata as { aquillaImport?: { milestone?: { label?: string } } } | null)?.aquillaImport?.milestone?.label
    return { cellId: r.cell_id, value: r.value, hidden: r.hidden_at != null, title: label ?? null }
  })
}

async function anyRowFor(t: TestDb, fileId: string, cellId: string): Promise<boolean> {
  const rows = await t.pg.query(`SELECT 1 FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = $3`, [
    DOWNSTREAM,
    fileId,
    cellId,
  ])
  return rows.rows.length > 0
}

/** Every downstream event and row belonging to the given downstream files. */
async function footprint(t: TestDb, downstreamFileIds: string[]): Promise<{ events: number; rows: string[] }> {
  const events = await t.pg.query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM events WHERE project_id = $1 AND file_id = ANY($2)`,
    [DOWNSTREAM, downstreamFileIds],
  )
  const rows = await t.pg.query<{ k: string }>(
    `SELECT file_id || '/' || cell_id || '/' || side || '/' || value || '/' || event_id AS k
       FROM cells WHERE project_id = $1 AND file_id = ANY($2) ORDER BY k`,
    [DOWNSTREAM, downstreamFileIds],
  )
  return { events: Number(events.rows[0]?.n ?? 0), rows: rows.rows.map((r) => r.k) }
}

const down = (upstreamFileId: string): string => deterministicDownstreamFileId(DOWNSTREAM, upstreamFileId)

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
  })
}

/** C linked to MAT + MRK, synced, with a translation entered in MAT. */
async function seedLinkedC(t: TestDb): Promise<void> {
  seq = 0
  await seedProjects(t)
  await link(t, [MAT, MRK])
  await mirrorSync(t.db, DOWNSTREAM)
  await emit(t, DOWNSTREAM, "target.cell.commit", {
    fileId: down(MAT),
    cellId: `${MAT}-1`,
    payload: { value: "El libro de la genealogía" },
    author: "translator",
  })
}

describe("mirrorSync — adding a file to an existing link (AQU-1560)", () => {
  // WHY: the slice's core promise. LUK's whole history is below the cursor, so
  // a fold from the cursor would bring nothing at all; the replay has to bring
  // every cell, in its CURRENT state, matching the upstream cell for cell.
  it("brings the added file in whole, matching the upstream cell for cell", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      expect(await downstreamFileNames(t)).toEqual(["MAT.usfm", "MRK.usfm"])

      await addFiles(t, [LUK])
      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.ranSync).toBe(true)
      expect(await downstreamFileNames(t)).toEqual(["LUK.usfm", "MAT.usfm", "MRK.usfm"])
      const upstream = await sourceRows(t, UPSTREAM, LUK)
      expect(await sourceRows(t, DOWNSTREAM, down(LUK))).toEqual(upstream)
      // Spelled out, so a broken comparison above cannot pass vacuously.
      expect(upstream).toEqual([
        { cellId: "luk-1", value: "Forasmuch as many have taken in hand", hidden: false, title: "Luke 1" },
        { cellId: "luk-2", value: "Luke 1:2 first draft", hidden: false, title: null },
        { cellId: "luk-3", value: "Luke 1:3 first draft", hidden: true, title: null },
      ])
      // The cell the upstream deleted before the add left no trace here.
      expect(await anyRowFor(t, down(LUK), "luk-4")).toBe(false)
      // The file's counters were computed once its row landed.
      const counters = await t.pg.query<{ cell_count: number }>(
        `SELECT cell_count FROM files WHERE project_id = $1 AND id = $2`,
        [DOWNSTREAM, down(LUK)],
      )
      expect(Number(counters.rows[0]?.cell_count)).toBe(2)
    } finally {
      await t.close()
    }
  })

  // WHY: "what used to require detaching and re-linking now works in place" —
  // and in place means the files already linked, and the team's work in them,
  // are not touched at all. Not re-mirrored, not re-written: no new events.
  it("leaves the files already linked, and their translations, untouched", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      const before = await footprint(t, [down(MAT), down(MRK)])

      await addFiles(t, [LUK])
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await footprint(t, [down(MAT), down(MRK)])).toEqual(before)
      const translation = await t.pg.query<{ value: string }>(
        `SELECT value FROM cells WHERE project_id = $1 AND file_id = $2 AND side = 'target'`,
        [DOWNSTREAM, down(MAT)],
      )
      expect(translation.rows.map((r) => r.value)).toEqual(["El libro de la genealogía"])
    } finally {
      await t.close()
    }
  })

  // WHY: once in, the file is a linked file like the others — an upstream edit
  // to it reaches this project.
  it("keeps the added file in sync with later upstream edits", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await addFiles(t, [LUK])
      await mirrorSync(t.db, DOWNSTREAM)

      await emit(t, UPSTREAM, "source.cell.commit", {
        fileId: LUK,
        cellId: "luk-2",
        payload: { value: "It seemed good to me also" },
      })
      await mirrorSync(t.db, DOWNSTREAM)

      expect((await sourceRows(t, DOWNSTREAM, down(LUK))).find((r) => r.cellId === "luk-2")?.value).toBe(
        "It seemed good to me also",
      )
    } finally {
      await t.close()
    }
  })

  // WHY: AQU-1559's rule applied to the result. With every upstream file now
  // linked the link IS a whole-project link — the card says so, and the next
  // file the upstream gains arrives with nobody adding it.
  it("becomes a whole-project link once every upstream file is linked", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await addFiles(t, [LUK])
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await linkState(t)).toMatchObject({ fileIds: null, backfill: null })

      await seedSmallFile(t, JHN, "JHN.usfm", "In the beginning was the Word")
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamFileNames(t)).toEqual(["JHN.usfm", "LUK.usfm", "MAT.usfm", "MRK.usfm"])
    } finally {
      await t.close()
    }
  })

  // WHY: the other half of the rule. A file the upstream gained after the link
  // was made can be added on its own; the link stays a fixed list (now one file
  // longer), and a further new upstream file still does not arrive by itself.
  it("stays a fixed list while some upstream files are still unlinked", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await seedSmallFile(t, JHN, "JHN.usfm", "In the beginning was the Word")
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamFileNames(t)).toEqual(["MAT.usfm", "MRK.usfm"])

      await addFiles(t, [JHN])
      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamFileNames(t)).toEqual(["JHN.usfm", "MAT.usfm", "MRK.usfm"])
      expect(await sourceRows(t, DOWNSTREAM, down(JHN))).toEqual(await sourceRows(t, UPSTREAM, JHN))
      expect(await linkState(t)).toMatchObject({ fileIds: [JHN, MAT, MRK].sort(), backfill: null })

      await seedSmallFile(t, "file-up-act", "ACT.usfm", "The former treatise")
      await mirrorSync(t.db, DOWNSTREAM)
      expect(await downstreamFileNames(t)).toEqual(["JHN.usfm", "MAT.usfm", "MRK.usfm"])
    } finally {
      await t.close()
    }
  })

  // WHY: "no file is left half-added". A replay that runs out of budget after
  // its first window has written some of the file's cells, but the file's row
  // is held back, so nothing appears in the file list; the link still follows
  // exactly what it followed; and the next sync picks up where this one left
  // off and finishes the job.
  it("never shows a half-added file, and finishes the add on the next sync", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await addFiles(t, [LUK])

      // One event per window, and a clock that is already out of budget after
      // the first window: the replay stops part-way.
      let clock = 0
      const partial = await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 1, budgetMs: 1, now: () => clock++ })

      expect(partial.more).toBe(true)
      expect(await downstreamFileNames(t)).toEqual(["MAT.usfm", "MRK.usfm"])
      const midway = await linkState(t)
      expect(midway.fileIds).toEqual([MAT, MRK])
      expect(JSON.parse(midway.backfill!)).toMatchObject({ fileIds: [LUK] })
      expect(JSON.parse(midway.backfill!).doneSeq).toBeGreaterThan(0)

      await mirrorSync(t.db, DOWNSTREAM, { windowEvents: 1 })

      expect(await downstreamFileNames(t)).toEqual(["LUK.usfm", "MAT.usfm", "MRK.usfm"])
      expect(await sourceRows(t, DOWNSTREAM, down(LUK))).toEqual(await sourceRows(t, UPSTREAM, LUK))
      expect(await linkState(t)).toMatchObject({ fileIds: null, backfill: null })
    } finally {
      await t.close()
    }
  })

  // WHY: the replay goes through the same bounded windows as a first sync
  // (AQU-1563), and where a window boundary falls must not change what arrives
  // — a cell created in one window and deleted in a later one still leaves no
  // row (AQU-1567's lookahead).
  it("arrives the same however the replay is windowed", async () => {
    const results: SourceRow[][] = []
    for (const windowEvents of [1, 2, 3, 2000]) {
      const t = await makeTestDb()
      try {
        await seedLinkedC(t)
        await addFiles(t, [LUK])
        await mirrorSync(t.db, DOWNSTREAM, { windowEvents })
        results.push(await sourceRows(t, DOWNSTREAM, down(LUK)))
        expect(await anyRowFor(t, down(LUK), "luk-4")).toBe(false)
        // The file's row arrives too, even when none of the replay's last
        // window's events belong to it.
        expect(await downstreamFileNames(t)).toEqual(["LUK.usfm", "MAT.usfm", "MRK.usfm"])
      } finally {
        await t.close()
      }
    }
    for (const r of results) expect(r).toEqual(results[results.length - 1])
  })

  // WHY: a lead adding a second file while the first is still being replayed.
  // auth-worker's write lands between two of the running replay's windows; the
  // replay must notice (its progress write compares against the column as it
  // read it) and stop, leaving the next run to replay both. Overwriting the
  // column with its own progress would silently drop the second file.
  it("does not lose a file added while an earlier add is being replayed", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await seedSmallFile(t, JHN, "JHN.usfm", "In the beginning was the Word")
      await mirrorSync(t.db, DOWNSTREAM)
      await addFiles(t, [LUK])

      // What auth-worker writes when the second add lands — both files, the
      // replay restarted — made to land just before the running replay saves
      // its first window's progress.
      const racing = beforeFirst(t.db, "SET source_link_backfill = ? WHERE", () => addFiles(t, [LUK, JHN]))
      const first = await mirrorSync(racing, DOWNSTREAM, { windowEvents: 1 })
      expect(first.more).toBe(true)
      expect(JSON.parse((await linkState(t)).backfill!)).toEqual({ fileIds: [LUK, JHN], doneSeq: 0 })

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamFileNames(t)).toEqual(["JHN.usfm", "LUK.usfm", "MAT.usfm", "MRK.usfm"])
      expect(await sourceRows(t, DOWNSTREAM, down(LUK))).toEqual(await sourceRows(t, UPSTREAM, LUK))
      expect(await linkState(t)).toMatchObject({ fileIds: null, backfill: null })
    } finally {
      await t.close()
    }
  })

  // WHY: an add on a link whose first sync never ran (cursor 0) has no history
  // below the cursor to replay; the file simply joins the selection and the
  // first sync brings everything.
  it("adds a file to a link that has never synced", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await seedSmallFile(t, JHN, "JHN.usfm", "In the beginning was the Word")
      await link(t, [MAT])
      await addFiles(t, [LUK])

      await mirrorSync(t.db, DOWNSTREAM)

      expect(await downstreamFileNames(t)).toEqual(["LUK.usfm", "MAT.usfm"])
      expect(await linkState(t)).toMatchObject({ fileIds: [LUK, MAT].sort(), backfill: null })
    } finally {
      await t.close()
    }
  })

  // WHY: the chain case. A link that consumes the upstream's TRANSLATIONS takes
  // a late file's validated translations as its source, and only the validated
  // ones — the replay uses the same gated merge as a first sync.
  it("brings in an added file's validated translations on a translations link", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      const commit = await emit(t, UPSTREAM, "target.cell.commit", {
        fileId: LUK,
        cellId: "luk-1",
        payload: { value: "Puisque plusieurs ont entrepris" },
        author: "translator-b",
      })
      await emit(t, UPSTREAM, "cell.validate", {
        fileId: LUK,
        cellId: "luk-1",
        payload: { editEventId: commit },
        author: "reviewer-b",
      })
      await emit(t, UPSTREAM, "target.cell.commit", {
        fileId: LUK,
        cellId: "luk-2",
        payload: { value: "brouillon non relu" },
        author: "translator-b",
      })
      await link(t, [MAT], { consumes: "target", gate: "validated" })
      await mirrorSync(t.db, DOWNSTREAM)

      await addFiles(t, [LUK])
      await mirrorSync(t.db, DOWNSTREAM)

      const rows = await sourceRows(t, DOWNSTREAM, down(LUK))
      expect(rows.map((r) => [r.cellId, r.value])).toEqual([["luk-1", "Puisque plusieurs ont entrepris"]])
    } finally {
      await t.close()
    }
  })

  // WHY: the replay's windows close their own batches in "Upstream changes"
  // (each mirror batch is read as the seq run before a link.cursor.advance), so
  // the added file's cells are grouped by themselves rather than folded into
  // whatever the next forward sync brings.
  it("records the add as its own batch of upstream changes", async () => {
    const t = await makeTestDb()
    try {
      await seedLinkedC(t)
      await addFiles(t, [LUK])
      await mirrorSync(t.db, DOWNSTREAM)

      const advances = await t.pg.query<{ server_seq: string }>(
        `SELECT server_seq FROM events WHERE project_id = $1 AND kind = 'link.cursor.advance' ORDER BY server_seq`,
        [DOWNSTREAM],
      )
      const last = Number(advances.rows[advances.rows.length - 1]!.server_seq)
      const previous = Number(advances.rows[advances.rows.length - 2]?.server_seq ?? 0)
      const batch = await t.pg.query<{ file_id: string }>(
        `SELECT DISTINCT file_id FROM events
          WHERE project_id = $1 AND kind IN ('source.cell.mirror', 'file.mirror')
            AND server_seq > $2 AND server_seq < $3`,
        [DOWNSTREAM, previous, last],
      )
      expect(batch.rows.map((r) => r.file_id)).toEqual([down(LUK)])
    } finally {
      await t.close()
    }
  })
})

describe("mirrorSync — a database without source_link_backfill (AQU-1560)", () => {
  // WHY: this worker is deployed independently of migration 0128 being
  // applied. A database without the column has nothing pending by definition,
  // and every sync must carry on exactly as before — subset links included.
  it("syncs a subset link as before", async () => {
    const t = await makeTestDb()
    try {
      seq = 0
      await seedProjects(t)
      await link(t, [MAT, MRK])
      await t.pg.query(`ALTER TABLE projects DROP COLUMN source_link_backfill`)

      const result = await mirrorSync(t.db, DOWNSTREAM)

      expect(result.ranSync).toBe(true)
      expect(await downstreamFileNames(t)).toEqual(["MAT.usfm", "MRK.usfm"])
    } finally {
      await t.close()
    }
  })
})
