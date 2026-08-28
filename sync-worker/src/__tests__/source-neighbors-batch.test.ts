// AQU-641 / AQU-1005: queryFileSourceNeighbors is the confidence routes' one
// retrieval statement. It must (a) match the per-cell querySourceNeighbors
// oracle for every asker within a file, and (b) stay scoped to the file and
// target-language lane — the project-wide predecessor ran for minutes on large
// projects and mixed lanes (see AQU-1005). Real Postgres (PGlite) so
// tsquery/ts_rank/LATERAL run for real.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import {
  querySourceNeighbors,
  queryFileSourceNeighbors,
  makeVerifiedProjectId,
} from "../events/scoped-search"
import type { SyncTokenClaims } from "../auth"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const PROJECT = "proj-conf"
const FILE = "file-1"
const OTHER_FILE = "file-2"

const verifiedProjectId = makeVerifiedProjectId({ projectId: PROJECT } as SyncTokenClaims)

interface SeedCell {
  cell_id: string
  side: "source" | "target"
  value: string
  validated?: number
  file_id?: string
  target_lang?: string
}

function row(c: SeedCell) {
  return {
    project_id: PROJECT,
    file_id: c.file_id ?? FILE,
    cell_id: c.cell_id,
    side: c.side,
    value: c.value,
    target_lang: c.target_lang ?? "",
    event_id: `ev-${c.cell_id}-${c.side}-${c.target_lang ?? ""}`,
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
  // Untranslated cell: never an asker, never a neighbor (no target to compare).
  { cell_id: "e", side: "source", value: "In the beginning of the gospel" },
  { cell_id: "e", side: "target", value: "" },
  // Another file with maximal text overlap: must never leak into FILE's
  // neighbor sets — retrieval is file-scoped (AQU-1005).
  { cell_id: "x", side: "source", value: "In the beginning God created the heavens", file_id: OTHER_FILE },
  { cell_id: "x", side: "target", value: "Im Anfang schuf Gott die Himmel", file_id: OTHER_FILE },
  // A translated cell that exists ONLY in the 'es' lane: invisible to the
  // default ('') lane, an asker/neighbor when lane-scoped to 'es'.
  { cell_id: "f", side: "source", value: "God created the Word in the beginning" },
  { cell_id: "f", side: "target", value: "Dios creó la Palabra en el principio", target_lang: "es" },
]

let t: TestDb

beforeAll(async () => {
  t = await makeTestDb({ cells: CELLS.map(row) })
})
afterAll(async () => {
  await t.close()
})

describe("queryFileSourceNeighbors (AQU-641 / AQU-1005)", () => {
  it("matches per-cell querySourceNeighbors for every translated unvalidated asker", async () => {
    const byFile = await queryFileSourceNeighbors(t.db, verifiedProjectId, FILE, { topK: 10 })

    // Askers = translated + unvalidated source cells of FILE in the '' lane:
    // b, c, d ("a" is validated → anchor, "e" untranslated, "f" only in 'es').
    expect([...byFile.keys()].sort()).toEqual(["b", "c", "d"])

    for (const askerId of ["b", "c", "d"]) {
      const text = CELLS.find((c) => c.cell_id === askerId && c.side === "source")!.value
      const single = await querySourceNeighbors(t.db, verifiedProjectId, text, {
        topK: 10,
        excludeCellId: askerId,
        validatedOnly: false,
      })
      // The oracle is project-wide, so drop its out-of-file / off-lane rows
      // before comparing — the file query must agree on everything in-file.
      const oracle = single.filter((n) => !["x", "f"].includes(n.cellId))
      const got = byFile.get(askerId) ?? []
      expect(got.map((n) => n.cellId).sort()).toEqual(oracle.map((n) => n.cellId).sort())
      for (const n of got) {
        const other = oracle.find((s) => s.cellId === n.cellId)!
        expect(other).toBeDefined()
        expect(n.targetValue).toBe(other.targetValue)
      }
    }
  })

  it("excludes the asker itself and untranslated neighbors", async () => {
    const byFile = await queryFileSourceNeighbors(t.db, verifiedProjectId, FILE, { topK: 10 })
    const ids = (byFile.get("b") ?? []).map((n) => n.cellId)
    expect(ids).not.toContain("b") // no self-endorsement
    expect(ids).not.toContain("e") // untranslated → not a neighbor
    expect(ids.length).toBeGreaterThan(0)
  })

  it("never returns neighbors from another file, even with identical text", async () => {
    const byFile = await queryFileSourceNeighbors(t.db, verifiedProjectId, FILE, { topK: 10 })
    for (const neighbors of byFile.values()) {
      expect(neighbors.map((n) => n.cellId)).not.toContain("x")
    }
  })

  it("scopes askers and neighbors to the requested target-language lane", async () => {
    // Default lane (''): "f" (translated only in 'es') is neither asker nor neighbor.
    const defaultLane = await queryFileSourceNeighbors(t.db, verifiedProjectId, FILE, { topK: 10 })
    expect(defaultLane.has("f")).toBe(false)
    for (const neighbors of defaultLane.values()) {
      expect(neighbors.map((n) => n.cellId)).not.toContain("f")
    }

    // 'es' lane: "f" is the only translated cell, so it is the only asker —
    // and it has no translated same-lane neighbors.
    const esLane = await queryFileSourceNeighbors(t.db, verifiedProjectId, FILE, {
      topK: 10,
      targetLang: "es",
    })
    expect([...esLane.keys()]).toEqual([])
  })
})
