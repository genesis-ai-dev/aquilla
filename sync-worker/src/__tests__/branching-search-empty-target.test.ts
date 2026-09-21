// AQU-153: example retrieval must count real source→target pairs, never
// source-only cells.
//
// The corpus LEFT JOINs the target side, and a source-only cell legitimately
// yields `COALESCE(t.value, '') = ''` — correct for the join, wrong for
// few-shot examples. Without a non-empty guard the algorithm happily returned
// up to topK of those, and the editor reported "5 examples used" on a project
// with no translations at all.
//
// The `validatedOnly` path never had the bug: `validated = 1` already implies
// a target row exists. The unvalidated path is the one under test here, and
// both are pinned so a future refactor cannot reintroduce it on either branch.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { handleBranchingSearchRequest } from "../events/branching-search-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "branching-search-empty-target-secret"
const PROJECT = "proj-bs-empty"
const FILE = "file-gen"
const QUERY = "God called the light Day"

const TRANSLATED = "Dios llamó a la luz Día"

interface SeedCell {
  cell_id: string
  side: "source" | "target"
  value: string
  validated?: number
  target_lang?: string
}

function row(c: SeedCell) {
  return {
    project_id: PROJECT,
    file_id: FILE,
    cell_id: c.cell_id,
    side: c.side,
    value: c.value,
    target_lang: c.target_lang ?? "",
    event_id: `ev-${c.cell_id}-${c.side}-${c.target_lang ?? ""}`,
    last_edit_at: 1700000000000,
    validated: c.validated ?? 0,
  }
}

// Six sources that all match the query strongly. Exactly ONE carries a target,
// and it is deliberately left unvalidated so the guard — not `validated = 1` —
// is what does the filtering. topK defaults to 5, so a corpus that admitted
// source-only cells would return 5 here rather than 1.
const CELLS: SeedCell[] = [
  { cell_id: "gen-1-5", side: "source", value: "God called the light Day and the darkness Night" },
  { cell_id: "gen-1-5", side: "target", value: TRANSLATED },
  { cell_id: "gen-1-4", side: "source", value: "God called the light Day and saw that it was good" },
  { cell_id: "gen-1-3", side: "source", value: "God called the light Day and there was evening" },
  { cell_id: "gen-1-2", side: "source", value: "God called the light Day and divided the waters" },
  { cell_id: "gen-1-1", side: "source", value: "God called the light Day in the beginning" },
  { cell_id: "gen-1-0", side: "source", value: "God called the light Day over the deep" },
]

// A target row that exists but holds an empty string — an emptied edit rather
// than an absent row. The COALESCE makes these indistinguishable in the join,
// so the guard has to catch both shapes.
const EMPTY_TARGET: SeedCell = { cell_id: "gen-1-4", side: "target", value: "" }

let t: TestDb

function env() {
  return { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }
}

async function search(qs: string) {
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
  const req = new Request(
    `https://w/api/v1/projects/${PROJECT}/branching-search?${qs}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const res = (await handleBranchingSearchRequest(req, env()))!
  expect(res.status).toBe(200)
  return (await res.json()) as { results: Array<{ cellId: string; targetText: string }> }
}

beforeAll(async () => {
  t = await makeTestDb({ cells: [...CELLS, EMPTY_TARGET].map(row) })
})
afterAll(async () => {
  await t.close()
})

describe("branching-search excludes cells with no target (AQU-153)", () => {
  it("returns only the one translated cell, not five source-only matches", async () => {
    const body = await search(`q=${encodeURIComponent(QUERY)}`)
    expect(body.results).toHaveLength(1)
    expect(body.results[0]?.cellId).toBe("gen-1-5")
    expect(body.results[0]?.targetText).toBe(TRANSLATED)
  })

  it("never returns a result whose targetText is empty", async () => {
    const body = await search(`q=${encodeURIComponent(QUERY)}`)
    for (const r of body.results) {
      expect(r.targetText).not.toBe("")
    }
  })

  it("excludes a target row that exists but is an empty string", async () => {
    const body = await search(`q=${encodeURIComponent(QUERY)}`)
    // gen-1-4 has a target ROW, but its value is "". An absent row and an
    // emptied one must both be filtered, since COALESCE collapses them.
    expect(body.results.map((r) => r.cellId)).not.toContain("gen-1-4")
  })

  it("returns nothing at all when the project has no translations", async () => {
    const bare = await makeTestDb({
      cells: CELLS.filter((c) => c.side === "source").map(row),
    })
    try {
      const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
      const req = new Request(
        `https://w/api/v1/projects/${PROJECT}/branching-search?q=${encodeURIComponent(QUERY)}`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      const res = (await handleBranchingSearchRequest(req, {
        AQUILLA_PG: bare.db,
        SYNC_SECRET_KEY: SECRET,
      }))!
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results: unknown[] }
      // The symptom on the issue: "5 examples used" on a brand-new project.
      expect(body.results).toEqual([])
    } finally {
      await bare.close()
    }
  })

  it("still filters on the validatedOnly path", async () => {
    const body = await search(`q=${encodeURIComponent(QUERY)}&validatedOnly=true`)
    // Nothing here is validated, so this is empty for a different reason —
    // pinned so the two branches cannot diverge into one admitting empties.
    for (const r of body.results) {
      expect(r.targetText).not.toBe("")
    }
  })
})
