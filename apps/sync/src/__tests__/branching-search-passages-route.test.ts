// AD-13 branching-search passages route integration tests.

import { describe, it, expect } from "vitest"
import { handleBranchingSearchPassagesRequest } from "../events/branching-search-passages-route"
import type { BranchingSearchPassagesResponse } from "../events/branching-search-passages-route"
import { makeInMemoryD1, type CellRow, type ProjectRow } from "./helpers/d1-fake"
import { makeTestToken } from "./helpers/auth"

const SECRET = "branching-search-passages-secret"

function envWith(db: ReturnType<typeof makeInMemoryD1>) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

function makeCell(
  over: Partial<CellRow> & Pick<CellRow, "cell_id" | "event_id" | "side" | "value">,
): CellRow {
  return {
    project_id: "p1",
    file_id: "f1",
    value_html: null,
    type: null,
    canonical_ref: null,
    anchor_cell_id: null,
    last_editor: "alice",
    last_edit_at: 1700000000000,
    validated: 0,
    word_count: 1,
    content_hash: null,
    source_event_id: null,
    ...over,
  }
}

function makeProject(over: Partial<ProjectRow> & Pick<ProjectRow, "id">): ProjectRow {
  return { source_project_id: null, ...over }
}

async function authedRequest(
  url: string,
  tokenOverrides: Parameters<typeof makeTestToken>[1] = {},
): Promise<Request> {
  const token = await makeTestToken(SECRET, tokenOverrides)
  return new Request(url, { headers: { Authorization: `Bearer ${token}` } })
}

/** 6-cell anchor chain in file f1, plus a tangential 2-cell chain in f2. */
function projectFixture() {
  const cells: CellRow[] = [
    makeCell({ cell_id: "c1", side: "source", event_id: "e1", value: "alpha cat",   anchor_cell_id: null,  file_id: "f1" }),
    makeCell({ cell_id: "c2", side: "source", event_id: "e2", value: "beta cat",    anchor_cell_id: "c1",  file_id: "f1" }),
    makeCell({ cell_id: "c3", side: "source", event_id: "e3", value: "gamma cat",   anchor_cell_id: "c2",  file_id: "f1" }),
    makeCell({ cell_id: "c4", side: "source", event_id: "e4", value: "delta cat",   anchor_cell_id: "c3",  file_id: "f1" }),
    makeCell({ cell_id: "c5", side: "source", event_id: "e5", value: "epsilon cat", anchor_cell_id: "c4",  file_id: "f1" }),
    makeCell({ cell_id: "d1", side: "source", event_id: "f1", value: "uno",         anchor_cell_id: null,  file_id: "f2" }),
    makeCell({ cell_id: "d2", side: "source", event_id: "f2", value: "dos cat",     anchor_cell_id: "d1",  file_id: "f2" }),
    // Paired target rows
    makeCell({ cell_id: "c1", side: "target", event_id: "t1", value: "alpha tgt",   file_id: "f1" }),
    makeCell({ cell_id: "c2", side: "target", event_id: "t2", value: "beta tgt",    file_id: "f1" }),
    makeCell({ cell_id: "c3", side: "target", event_id: "t3", value: "gamma tgt",   file_id: "f1" }),
    makeCell({ cell_id: "c4", side: "target", event_id: "t4", value: "delta tgt",   file_id: "f1" }),
    makeCell({ cell_id: "c5", side: "target", event_id: "t5", value: "epsilon tgt", file_id: "f1" }),
    makeCell({ cell_id: "d2", side: "target", event_id: "td2", value: "dos tgt",    file_id: "f2" }),
  ]
  return makeInMemoryD1({
    projects: [makeProject({ id: "p1" })],
    cells,
  })
}

describe("GET /api/v1/projects/:projectId/branching-search/passages", () => {
  it("returns null for non-matching paths", async () => {
    const db = makeInMemoryD1()
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleBranchingSearchPassagesRequest(req, envWith(db))
    expect(res).toBeNull()
  })

  it("returns 401 with no Authorization header", async () => {
    const db = projectFixture()
    const req = new Request(
      "https://w/api/v1/projects/p1/branching-search/passages?q=cat",
    )
    const res = (await handleBranchingSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 400 when q is missing", async () => {
    const db = projectFixture()
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search/passages",
    )
    const res = (await handleBranchingSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("expands each hit into a passage of ±radius cells from the same file", async () => {
    const db = projectFixture()
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search/passages?q=cat&topK=3&radius=1",
    )
    const res = (await handleBranchingSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as BranchingSearchPassagesResponse
    expect(body.passages.length).toBeGreaterThan(0)
    for (const p of body.passages) {
      expect(p.cells.length).toBeGreaterThan(0)
      expect(p.cells.length).toBeLessThanOrEqual(3) // 2*radius+1
      const hits = p.cells.filter((c) => c.hit)
      expect(hits.length).toBe(1)
      expect(hits[0].cellId).toBe(p.hitCellId)
      // All cells in a passage share the passage's fileId.
      for (const cc of p.cells) {
        const corpusFile = body.passages.find((q) =>
          q.cells.some((x) => x.cellId === cc.cellId),
        )?.fileId
        expect(corpusFile).toBe(p.fileId)
      }
    }
  })

  it("uses default radius=2 when not provided", async () => {
    const db = projectFixture()
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search/passages?q=cat&topK=1",
    )
    const res = (await handleBranchingSearchPassagesRequest(req, envWith(db)))!
    const body = (await res.json()) as BranchingSearchPassagesResponse
    // First hit is in f1 (where most of the corpus is); radius 2 yields up
    // to 5 cells. Exact count depends on hit position; assert ≤ 5 and ≥ 1.
    expect(body.passages.length).toBe(1)
    expect(body.passages[0].cells.length).toBeLessThanOrEqual(5)
    expect(body.passages[0].cells.length).toBeGreaterThan(0)
  })

  it("respects radius=0 — single-cell passages", async () => {
    const db = projectFixture()
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search/passages?q=cat&topK=2&radius=0",
    )
    const res = (await handleBranchingSearchPassagesRequest(req, envWith(db)))!
    const body = (await res.json()) as BranchingSearchPassagesResponse
    for (const p of body.passages) {
      expect(p.cells.length).toBe(1)
      expect(p.cells[0].hit).toBe(true)
    }
  })

  it("populates source + target text from the corpus", async () => {
    const db = projectFixture()
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search/passages?q=cat&topK=1&radius=1",
    )
    const res = (await handleBranchingSearchPassagesRequest(req, envWith(db)))!
    const body = (await res.json()) as BranchingSearchPassagesResponse
    const p = body.passages[0]
    for (const c of p.cells) {
      expect(c.sourceText.length).toBeGreaterThan(0)
      expect(c.targetText.length).toBeGreaterThan(0)
    }
  })
})
