// AQU-641: querySourceNeighborsBatch must be behaviorally equivalent to the
// per-cell querySourceNeighbors it replaces in the confidence routes — the
// batching is a pure read-cost optimization (one LATERAL query per chunk vs
// one FTS query per cell) and must not change which neighbors a cell sees.
// Real Postgres (PGlite) so tsquery/ts_rank/LATERAL run for real.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  querySourceNeighbors,
  querySourceNeighborsBatch,
  makeVerifiedProjectId,
} from "../events/scoped-search"
import type { SyncTokenClaims } from "../auth"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-conf"
const FILE = "file-1"

const verifiedProjectId = makeVerifiedProjectId({ projectId: PROJECT } as SyncTokenClaims)

interface SeedCell {
  cell_id: string
  side: "source" | "target"
  value: string
  validated?: number
}

function row(c: SeedCell) {
  return {
    project_id: PROJECT,
    file_id: FILE,
    cell_id: c.cell_id,
    side: c.side,
    value: c.value,
    event_id: `ev-${c.cell_id}-${c.side}`,
    last_edit_at: 1700000000000,
    validated: c.validated ?? 0,
    word_count: c.value.split(/\s+/).length,
  }
}

// Overlapping source texts so FTS retrieval produces real ranked neighbors.
const CELLS: SeedCell[] = [
  { cell_id: "a", side: "source", value: "In the beginning God created the heavens" },
  { cell_id: "a", side: "target", value: "Au commencement Dieu créa les cieux", validated: 1 },
  { cell_id: "b", side: "source", value: "In the beginning was the Word" },
  { cell_id: "b", side: "target", value: "Au commencement était la Parole" },
  { cell_id: "c", side: "source", value: "God created great whales in the sea" },
  { cell_id: "c", side: "target", value: "Dieu créa les grands poissons de la mer" },
  { cell_id: "d", side: "source", value: "the Word became flesh" },
  { cell_id: "d", side: "target", value: "la Parole a été faite chair" },
  // Untranslated cell: must never appear as a neighbor (no target to compare).
  { cell_id: "e", side: "source", value: "In the beginning of the gospel" },
  { cell_id: "e", side: "target", value: "" },
]

let t: TestDb

beforeAll(async () => {
  t = await makeTestDb({ cells: CELLS.map(row) })
})
afterAll(async () => {
  await t.close()
})

describe("querySourceNeighborsBatch (AQU-641)", () => {
  it("matches per-cell querySourceNeighbors for every queried cell", async () => {
    const queries = ["a", "b", "c", "d"].map((id) => ({
      cellId: id,
      text: CELLS.find((c) => c.cell_id === id && c.side === "source")!.value,
    }))
    const batched = await querySourceNeighborsBatch(t.db, verifiedProjectId, queries, { topK: 10 })

    for (const q of queries) {
      const single = await querySourceNeighbors(t.db, verifiedProjectId, q.text, {
        topK: 10,
        excludeCellId: q.cellId,
        validatedOnly: false,
      })
      const got = batched.get(q.cellId) ?? []
      // Same neighbor set with the same target values; rank order can tie, so
      // compare as (cellId → targetValue) maps plus identical ordering by rank.
      expect(got.map((n) => n.cellId).sort()).toEqual(single.map((n) => n.cellId).sort())
      for (const n of got) {
        const other = single.find((s) => s.cellId === n.cellId)!
        expect(other).toBeDefined()
        expect(n.targetValue).toBe(other.targetValue)
        expect(n.rank).toBeCloseTo(other.rank, 6)
      }
    }
  })

  it("excludes the querying cell itself and untranslated neighbors", async () => {
    const batched = await querySourceNeighborsBatch(
      t.db,
      verifiedProjectId,
      [{ cellId: "a", text: "In the beginning God created the heavens" }],
      { topK: 10 },
    )
    const ids = (batched.get("a") ?? []).map((n) => n.cellId)
    expect(ids).not.toContain("a") // no self-endorsement
    expect(ids).not.toContain("e") // untranslated → not a neighbor
    expect(ids.length).toBeGreaterThan(0)
  })

  it("respects validatedOnly", async () => {
    const batched = await querySourceNeighborsBatch(
      t.db,
      verifiedProjectId,
      [{ cellId: "b", text: "In the beginning was the Word" }],
      { topK: 10, validatedOnly: true },
    )
    // Only cell "a" has a validated target.
    expect((batched.get("b") ?? []).map((n) => n.cellId)).toEqual(["a"])
  })

  it("omits cells whose text tokenizes to nothing", async () => {
    const batched = await querySourceNeighborsBatch(
      t.db,
      verifiedProjectId,
      [
        { cellId: "punct", text: "!!! ???" },
        { cellId: "b", text: "In the beginning was the Word" },
      ],
      { topK: 5 },
    )
    expect(batched.has("punct")).toBe(false)
    expect(batched.has("b")).toBe(true)
  })
})
