// AQU-1453: a clone starts from the CURATED source, parked cells included.
//
// `snapshotSourceCells` is the one-time copy behind two flows — clone-mode
// linking at project creation, and detaching a live link to freeze its snapshot.
// It read the upstream's source rows for text and structure and nothing else, so
// every cell the upstream lead had hidden (AQU-1422) arrived VISIBLE in the new
// project: countable, exportable, and offered up for translation, which is the
// opposite of what parking it meant.
//
// The copy is an ordinary `source.cell.visibility.set` event rather than a bare
// `hidden_at` write, because the acceptance criterion is that the receiving
// project's lead can show the cell again — an event is what makes that an
// ordinary reversible source change downstream.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import { snapshotSourceCells } from "../services/source-linking"

const UP = "proj-hide-up"
const DOWN = "proj-hide-down"

async function seedProject(id: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)")
    .bind(id, name)
    .run()
}

/** An upstream file with three source cells, the middle one parked. */
async function seedCuratedUpstream(): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO files (id, project_id, name, kind, event_id, created_at, updated_at)
     VALUES ('f-gen', ?, '01-GEN.usfm', 'text', 'e-file', 1000, 1000)`,
  )
    .bind(UP)
    .run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at) VALUES
       (?, 'f-gen', 'c1', 'source', 'In the beginning', 'GEN 1:1', 'e-c1', 1000),
       (?, 'f-gen', 'c2', 'source', 'And the earth was void', 'GEN 1:2', 'e-c2', 1000),
       (?, 'f-gen', 'c3', 'source', 'And God said', 'GEN 1:3', 'e-c3', 1000)`,
  )
    .bind(UP, UP, UP)
    .run()
  // c2 is parked upstream — the whole point of the snapshot carrying visibility.
  await env.AQUILLA_PG.prepare(
    `UPDATE cells SET hidden_at = 1700000000000
      WHERE project_id = ? AND file_id = 'f-gen' AND cell_id = 'c2' AND side = 'source'`,
  )
    .bind(UP)
    .run()
}

/** The snapshot remaps file ids (files.id is a global PK), so read the target's
 *  rows by cell id and let the file id fall out of the query. */
async function targetCells(): Promise<Map<string, { value: string; hidden: boolean }>> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT cell_id, value, hidden_at FROM cells
      WHERE project_id = ? AND side = 'source'`,
  )
    .bind(DOWN)
    .all<{ cell_id: string; value: string; hidden_at: number | null }>()
  return new Map(
    (rows.results ?? []).map((r) => [r.cell_id, { value: r.value, hidden: r.hidden_at != null }]),
  )
}

async function visibilityEvents(): Promise<Array<{ cell_id: string; payload: string }>> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT cell_id, payload FROM events
      WHERE project_id = ? AND kind = 'source.cell.visibility.set'
      ORDER BY server_seq ASC`,
  )
    .bind(DOWN)
    .all<{ cell_id: string; payload: string }>()
  return rows.results ?? []
}

describe("snapshotSourceCells — the clone carries hidden cells (AQU-1453)", () => {
  it("copies a parked cell as parked, and leaves the visible ones visible", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedCuratedUpstream()

    const emitted = await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })
    expect(emitted).toBe(3)

    const cells = await targetCells()
    expect(cells.get("c1")).toEqual({ value: "In the beginning", hidden: false })
    expect(cells.get("c2")).toEqual({ value: "And the earth was void", hidden: true })
    expect(cells.get("c3")).toEqual({ value: "And God said", hidden: false })
  })

  it("records the hide as a real event, so the new project's lead can show it again", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedCuratedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    const events = await visibilityEvents()
    // Exactly one, for the one parked cell. An unconditional event per cell
    // would put a no-op hide in the log for every verse of a Bible.
    expect(events).toHaveLength(1)
    expect(events[0].cell_id).toBe("c2")
    expect(JSON.parse(events[0].payload)).toEqual({ hidden: true })
  })

  it("does not advance the cell's chain head — a hide must not make translations stale", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedCuratedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    // `source.cell.visibility.set` is non-chain-mutating (AQU-1422): the row's
    // event_id must still be the create event the snapshot wrote, not the hide.
    const row = await env.AQUILLA_PG.prepare(
      `SELECT c.event_id AS event_id, e.kind AS kind
         FROM cells c JOIN events e ON e.id = c.event_id
        WHERE c.project_id = ? AND c.cell_id = 'c2' AND c.side = 'source'`,
    )
      .bind(DOWN)
      .first<{ event_id: string; kind: string }>()
    expect(row?.kind).toBe("source.cell.create")
  })

  it("a re-snapshot shows a cell the upstream un-parked in the meantime", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedCuratedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })
    expect((await targetCells()).get("c2")?.hidden).toBe(true)

    // The upstream lead brings c2 back and parks c3 instead.
    await env.AQUILLA_PG.prepare(
      `UPDATE cells SET hidden_at = NULL
        WHERE project_id = ? AND cell_id = 'c2' AND side = 'source'`,
    )
      .bind(UP)
      .run()
    await env.AQUILLA_PG.prepare(
      `UPDATE cells SET hidden_at = 1700000000001
        WHERE project_id = ? AND cell_id = 'c3' AND side = 'source'`,
    )
      .bind(UP)
      .run()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    const cells = await targetCells()
    expect(cells.get("c2")?.hidden).toBe(false)
    expect(cells.get("c3")?.hidden).toBe(true)
  })

  it("a second snapshot with nothing changed adds no further visibility events", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedCuratedUpstream()

    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })
    await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    // The hide already landed; the second pass has nothing to say about it.
    expect(await visibilityEvents()).toHaveLength(1)
    expect((await targetCells()).get("c2")?.hidden).toBe(true)
  })

  it("an upstream with nothing parked writes no visibility events at all", async () => {
    await seedProject(UP, "Upstream")
    await seedProject(DOWN, "Downstream")
    await seedCuratedUpstream()
    await env.AQUILLA_PG.prepare(
      `UPDATE cells SET hidden_at = NULL WHERE project_id = ? AND side = 'source'`,
    )
      .bind(UP)
      .run()

    const emitted = await snapshotSourceCells(env, {
      upstreamProjectId: UP,
      targetProjectId: DOWN,
      authorUsername: "lead",
    })

    expect(emitted).toBe(3)
    expect(await visibilityEvents()).toHaveLength(0)
    const cells = await targetCells()
    expect([...cells.values()].every((c) => !c.hidden)).toBe(true)
  })
})
