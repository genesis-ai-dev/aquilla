// Regression tests for FRO-153: example count must reflect real source→target
// translation pairs, not source-only cells.

import { describe, it, expect } from "vitest"
import { handleBranchingSearchRequest } from "../events/branching-search-route"
import { makeInMemoryD1, type CellRow } from "./helpers/d1-fake"
import { makeTestToken } from "./helpers/auth"

const SECRET = "bs-route-secret"

function envWith(db: ReturnType<typeof makeInMemoryD1>) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

function makeCell(
  over: Partial<CellRow> & Pick<CellRow, "cell_id" | "side" | "value">,
): CellRow {
  return {
    project_id: "proj-a",
    file_id: "file-x",
    anchor_cell_id: null,
    event_id: `e-${over.cell_id}-${over.side}`,
    last_editor: null,
    last_edit_at: 0,
    validated: 0,
    word_count: 1,
    ...over,
  }
}

describe("GET /api/v1/projects/:projectId/branching-search — FRO-153 example count", () => {
  it("returns 0 results for a brand-new project with no target translations", async () => {
    const db = makeInMemoryD1({
      cells: [
        makeCell({ cell_id: "c1", side: "source", value: "In the beginning God created the heavens" }),
        makeCell({ cell_id: "c2", side: "source", value: "and the earth was without form and void" }),
        makeCell({ cell_id: "c3", side: "source", value: "darkness was over the face of the deep" }),
        makeCell({ cell_id: "c4", side: "source", value: "the Spirit of God was hovering over the waters" }),
        makeCell({ cell_id: "c5", side: "source", value: "God said let there be light and there was light" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/branching-search?q=God+created+the+heavens",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[]; corpusSize: number }
    // No translations exist — copilot must report 0 examples, not 5.
    expect(body.results).toHaveLength(0)
  })

  it("returns only cells with actual target translations, not source-only cells", async () => {
    const db = makeInMemoryD1({
      cells: [
        // c1: has source + target
        makeCell({ cell_id: "c1", side: "source", value: "In the beginning God created" }),
        makeCell({ cell_id: "c1", side: "target", value: "En el principio creó Dios" }),
        // c2: source only, no target — must NOT appear as an example
        makeCell({ cell_id: "c2", side: "source", value: "and the earth was without form" }),
        // c3: has source + target
        makeCell({ cell_id: "c3", side: "source", value: "God said let there be light" }),
        makeCell({ cell_id: "c3", side: "target", value: "Dios dijo haya luz" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/branching-search?q=God+created+the+earth",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ cellId: string; targetText: string }>
    }
    const resultIds = body.results.map((r) => r.cellId)
    // c2 must not appear — it has no translation
    expect(resultIds).not.toContain("c2")
    // Every returned cell must have a non-empty targetText
    for (const r of body.results) {
      expect(r.targetText).not.toBe("")
    }
  })
})
