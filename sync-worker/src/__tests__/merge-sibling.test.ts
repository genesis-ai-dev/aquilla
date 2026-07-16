// AQU-538 slice 4: sibling-merge fold tests (merge-sibling-route.ts).
//
// Runs the exact prod projection path on a real Postgres engine (PGlite + the
// prod shim). Pins the fold invariants (design decision 7 — FINAL):
//   - matched donor default-lane cells land on the HOST lane, chained on the
//     host source head, with the AD-9 source_event_id pin set;
//   - donor cells with no matching host source cell_id are reported as skipped;
//   - a re-run is idempotent (no duplicate events, cells state unchanged);
//   - the donor's rows and the host's default lane are never touched.

import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { mergeSibling, deterministicMergeEventId } from "../events/merge-sibling-route"
import { buildEventProjectionStmts, type PersistedEvent } from "../events/event-projection"
import type { EventKind } from "../events/types"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const HOST = "host-proj"
const DONOR = "donor-proj"
const HOST_FILE = "host-file"
const DONOR_FILE = "donor-file"

let seq = 0
function ev(partial: Partial<PersistedEvent> & { kind: EventKind; projectId: string; fileId: string }): PersistedEvent {
  seq += 1
  return {
    id: partial.id ?? `e${seq}`,
    schemaVersion: 1,
    cellId: partial.cellId ?? null,
    parentId: partial.parentId ?? null,
    author: partial.author ?? "seed",
    payload: partial.payload ?? {},
    clientTs: 1000 + seq,
    serverTs: 1000 + seq,
    serverSeq: seq,
    ...partial,
  }
}

async function applyEvents(db: AquillaDb, events: PersistedEvent[]): Promise<void> {
  const stmts: AquillaStatement[] = []
  for (const e of events) buildEventProjectionStmts(db, e, stmts, { deferFileCounters: true })
  for (const s of stmts) await s.run()
}

async function seedProject(t: TestDb, id: string, name: string): Promise<void> {
  await t.pg.query(`INSERT INTO projects (id, name, created_by) VALUES ($1, $2, 1)`, [id, name])
}

async function seedFile(t: TestDb, projectId: string, fileId: string): Promise<void> {
  await t.pg.query(
    `INSERT INTO files (id, project_id, name, event_id) VALUES ($1, $2, $3, $4)`,
    [fileId, projectId, `${fileId}-name`, `${fileId}-evt`],
  )
}

interface CellRow {
  project_id: string
  file_id: string
  cell_id: string
  side: string
  target_lang: string
  value: string
  event_id: string
  source_event_id: string | null
}

async function cellsFor(t: TestDb, projectId: string): Promise<CellRow[]> {
  const rows = await t.pg.query<CellRow>(
    `SELECT project_id, file_id, cell_id, side, target_lang, value, event_id, source_event_id
       FROM cells WHERE project_id = $1
      ORDER BY cell_id, side, target_lang`,
    [projectId],
  )
  return rows.rows
}

/** Seed the host source rows + donor default-lane target rows. `matched` cell
 *  ids exist on BOTH host source and donor target; `donorOnly` exist only on
 *  the donor (→ skipped). */
async function seedContent(
  t: TestDb,
  matched: string[],
  donorOnly: string[],
): Promise<void> {
  await seedProject(t, HOST, "Host")
  await seedProject(t, DONOR, "Donor")
  await seedFile(t, HOST, HOST_FILE)
  await seedFile(t, DONOR, DONOR_FILE)

  const events: PersistedEvent[] = []
  // Host source rows for the matched cells.
  for (const cid of matched) {
    events.push(
      ev({
        kind: "source.cell.create",
        projectId: HOST,
        fileId: HOST_FILE,
        cellId: cid,
        id: `hsrc-${cid}`,
        payload: { cellId: cid, value: `SRC ${cid}` },
      }),
    )
  }
  // Donor default-lane target rows for matched + donor-only cells.
  for (const cid of [...matched, ...donorOnly]) {
    events.push(
      ev({
        kind: "target.cell.commit",
        projectId: DONOR,
        fileId: DONOR_FILE,
        cellId: cid,
        id: `dtgt-${cid}`,
        payload: { value: `Donor ${cid}` },
      }),
    )
  }
  await applyEvents(t.db, events)
}

let t: TestDb
beforeEach(async () => {
  if (!t) t = await makeTestDb()
  else await t.reset()
  seq = 0
})
afterAll(async () => {
  await t?.close()
})

describe("mergeSibling — fold donor default lane into a host lane", () => {
  it("lands matched cells on the host lane chained on the source head with the pin set", async () => {
    await seedContent(t, ["c1", "c2"], [])

    const result = await mergeSibling(t.db, {
      hostProjectId: HOST,
      donorProjectId: DONOR,
      lane: "fr",
    })

    expect(result.merged).toBe(2)
    expect(result.skipped).toEqual([])
    expect(result.lane).toBe("fr")

    const hostCells = await cellsFor(t, HOST)
    const frRows = hostCells.filter((r) => r.side === "target" && r.target_lang === "fr")
    expect(frRows.map((r) => [r.cell_id, r.value])).toEqual([
      ["c1", "Donor c1"],
      ["c2", "Donor c2"],
    ])
    // AD-9 pin: source_event_id points at the host source head.
    expect(frRows.find((r) => r.cell_id === "c1")!.source_event_id).toBe("hsrc-c1")
    expect(frRows.find((r) => r.cell_id === "c2")!.source_event_id).toBe("hsrc-c2")
    // Deterministic event id.
    expect(frRows.find((r) => r.cell_id === "c1")!.event_id).toBe(
      deterministicMergeEventId(HOST, "dtgt-c1", "fr"),
    )

    // The emitted event chains on the HOST source head.
    const evtRow = await t.pg.query<{ parent_id: string; payload: string; kind: string }>(
      `SELECT parent_id, payload, kind FROM events WHERE id = $1`,
      [deterministicMergeEventId(HOST, "dtgt-c1", "fr")],
    )
    expect(evtRow.rows[0]?.kind).toBe("target.cell.commit")
    expect(evtRow.rows[0]?.parent_id).toBe("hsrc-c1")
    const payload = JSON.parse(evtRow.rows[0]!.payload) as { targetLang: string; sourceEventId: string }
    expect(payload.targetLang).toBe("fr")
    expect(payload.sourceEventId).toBe("hsrc-c1")

    // Host default lane untouched — no '' target rows created.
    expect(hostCells.filter((r) => r.side === "target" && r.target_lang === "")).toHaveLength(0)
  })

  it("reports donor cells with no matching host source cell_id as skipped", async () => {
    await seedContent(t, ["c1"], ["orphan"])

    const result = await mergeSibling(t.db, {
      hostProjectId: HOST,
      donorProjectId: DONOR,
      lane: "fr",
    })

    expect(result.merged).toBe(1)
    expect(result.skipped).toEqual([{ cellId: "orphan", preview: "Donor orphan" }])

    // Only c1 landed on the host lane; the orphan produced no host row.
    const hostCells = await cellsFor(t, HOST)
    expect(hostCells.filter((r) => r.side === "target" && r.target_lang === "fr").map((r) => r.cell_id)).toEqual(["c1"])
  })

  it("is idempotent on re-run: no duplicate events, host cells unchanged, donor untouched", async () => {
    await seedContent(t, ["c1", "c2"], ["orphan"])

    const donorBefore = await cellsFor(t, DONOR)

    await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })
    const hostAfterFirst = await cellsFor(t, HOST)
    const hostEventCountFirst = (
      await t.pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1`, [HOST])
    ).rows[0]!.n

    const rerun = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "fr" })
    expect(rerun.merged).toBe(2)

    const hostAfterSecond = await cellsFor(t, HOST)
    const hostEventCountSecond = (
      await t.pg.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM events WHERE project_id = $1`, [HOST])
    ).rows[0]!.n

    // No duplicate events, cells state byte-identical.
    expect(hostEventCountSecond).toBe(hostEventCountFirst)
    expect(hostAfterSecond).toEqual(hostAfterFirst)

    // Donor rows never touched.
    expect(await cellsFor(t, DONOR)).toEqual(donorBefore)
  })

  it("merges nothing (no host rows, no crash) when no cell_ids match", async () => {
    await seedContent(t, [], ["a", "b"])
    const result = await mergeSibling(t.db, { hostProjectId: HOST, donorProjectId: DONOR, lane: "es" })
    expect(result.merged).toBe(0)
    expect(result.skipped.map((s) => s.cellId).sort()).toEqual(["a", "b"])
    expect((await cellsFor(t, HOST)).filter((r) => r.side === "target")).toHaveLength(0)
  })
})
