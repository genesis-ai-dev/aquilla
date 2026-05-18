// AD-13 branching-search route integration tests.
//
// Covers: auth gates, path matching, query-string validation, project-shape
// behaviors (self-contained / source-only / linked-target), validatedOnly +
// excludeCellId filters, response shape.

import { describe, it, expect } from "vitest"
import { handleBranchingSearchRequest } from "../events/branching-search-route"
import type { BranchingSearchResponse } from "../events/branching-search-route"
import { makeInMemoryD1, type CellRow, type ProjectRow } from "./helpers/d1-fake"
import { makeTestToken } from "./helpers/auth"

const SECRET = "branching-search-secret"

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
  return {
    source_project_id: null,
    ...over,
  }
}

async function authedRequest(
  url: string,
  tokenOverrides: Parameters<typeof makeTestToken>[1] = {},
): Promise<Request> {
  const token = await makeTestToken(SECRET, tokenOverrides)
  return new Request(url, {
    headers: { Authorization: `Bearer ${token}` },
  })
}

describe("GET /api/v1/projects/:projectId/branching-search", () => {
  it("returns null for non-matching paths (so the dispatcher can chain)", async () => {
    const db = makeInMemoryD1()
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleBranchingSearchRequest(req, envWith(db))
    expect(res).toBeNull()
  })

  it("returns null for non-GET methods", async () => {
    const db = makeInMemoryD1()
    const req = new Request("https://w/api/v1/projects/p1/branching-search?q=x", {
      method: "POST",
    })
    const res = await handleBranchingSearchRequest(req, envWith(db))
    expect(res).toBeNull()
  })

  it("returns 401 when Authorization header is missing", async () => {
    const db = makeInMemoryD1()
    const req = new Request("https://w/api/v1/projects/p1/branching-search?q=x")
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 500 when SYNC_SECRET_KEY is missing", async () => {
    const db = makeInMemoryD1()
    const req = await authedRequest("https://w/api/v1/projects/p1/branching-search?q=x")
    const res = (await handleBranchingSearchRequest(req, { AQUILLA_DB: db }))!
    expect(res.status).toBe(500)
  })

  it("returns 400 when q is missing", async () => {
    const db = makeInMemoryD1()
    const req = await authedRequest("https://w/api/v1/projects/p1/branching-search")
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("returns 400 when q is whitespace-only", async () => {
    const db = makeInMemoryD1()
    const req = await authedRequest("https://w/api/v1/projects/p1/branching-search?q=%20%20")
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("returns 403 when token's project doesn't match the URL's project", async () => {
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p1" })],
    })
    const req = await authedRequest("https://w/api/v1/projects/p2/branching-search?q=x", {
      projectId: "p1",
    })
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  // ─── Self-contained project ─────────────────────────────────────────

  it("retrieves source cells from the project itself for self-contained shape", async () => {
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p1" })],
      cells: [
        makeCell({
          cell_id: "c1",
          side: "source",
          event_id: "e1",
          value: "the cat sat on the mat",
        }),
        makeCell({
          cell_id: "c1",
          side: "target",
          event_id: "et1",
          value: "le chat",
          validated: 1,
        }),
        makeCell({
          cell_id: "c2",
          side: "source",
          event_id: "e2",
          value: "completely unrelated",
        }),
      ],
    })
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search?q=the%20cat%20sat",
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as BranchingSearchResponse
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results[0].cellId).toBe("c1")
    expect(body.results[0].sourceText).toBe("the cat sat on the mat")
    expect(body.results[0].targetText).toBe("le chat")
    expect(body.upstreamProjectId).toBeNull()
    expect(body.corpusSize).toBe(2) // c1 + c2 source rows
  })

  // ─── Linked target project (AD-9) ───────────────────────────────────

  it("retrieves source cells from the upstream for linked-target shape", async () => {
    const db = makeInMemoryD1({
      projects: [
        makeProject({ id: "p-target", source_project_id: "p-src" }),
        makeProject({ id: "p-src" }),
      ],
      cells: [
        // Upstream source rows
        makeCell({
          project_id: "p-src",
          cell_id: "c1",
          side: "source",
          event_id: "e-src-c1",
          value: "alpha beta gamma",
        }),
        makeCell({
          project_id: "p-src",
          cell_id: "c2",
          side: "source",
          event_id: "e-src-c2",
          value: "delta epsilon",
        }),
        // Target rows live in p-target
        makeCell({
          project_id: "p-target",
          cell_id: "c1",
          side: "target",
          event_id: "et1",
          value: "ALPHA BETA in target language",
          source_event_id: "e-src-c1",
        }),
      ],
    })
    const req = await authedRequest(
      "https://w/api/v1/projects/p-target/branching-search?q=alpha%20beta",
      { projectId: "p-target" },
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as BranchingSearchResponse
    expect(body.upstreamProjectId).toBe("p-src")
    // c1 should rank first — it has "alpha beta gamma" matching the query.
    expect(body.results[0].cellId).toBe("c1")
    // Target text comes from p-target, not from p-src.
    expect(body.results[0].targetText).toBe("ALPHA BETA in target language")
    expect(body.corpusSize).toBe(2)
  })

  // ─── Source-only project ────────────────────────────────────────────

  it("retrieves source cells with empty target_text for source-only shape", async () => {
    // Source-only: targets simply aren't there (no target rows in p1).
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p1" })],
      cells: [
        makeCell({
          cell_id: "c1",
          side: "source",
          event_id: "e1",
          value: "the cat sat",
        }),
      ],
    })
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search?q=the%20cat",
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as BranchingSearchResponse
    expect(body.results[0].cellId).toBe("c1")
    expect(body.results[0].targetText).toBe("")
  })

  // ─── Filters ────────────────────────────────────────────────────────

  it("validatedOnly=true filters out cells with unvalidated targets", async () => {
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p1" })],
      cells: [
        makeCell({
          cell_id: "c1",
          side: "source",
          event_id: "es1",
          value: "the cat sat",
        }),
        makeCell({
          cell_id: "c1",
          side: "target",
          event_id: "et1",
          value: "le chat",
          validated: 0, // NOT validated
        }),
        makeCell({
          cell_id: "c2",
          side: "source",
          event_id: "es2",
          value: "the cat sat",
        }),
        makeCell({
          cell_id: "c2",
          side: "target",
          event_id: "et2",
          value: "le chat",
          validated: 1, // validated
        }),
      ],
    })
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search?q=the%20cat&validatedOnly=true",
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    const body = (await res.json()) as BranchingSearchResponse
    expect(body.results.map((r) => r.cellId)).toEqual(["c2"])
  })

  it("excludeCellId removes the given cell from the corpus", async () => {
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p1" })],
      cells: [
        makeCell({ cell_id: "c1", side: "source", event_id: "e1", value: "the cat sat" }),
        makeCell({ cell_id: "c2", side: "source", event_id: "e2", value: "the cat sat" }),
      ],
    })
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search?q=the%20cat&excludeCellId=c1",
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    const body = (await res.json()) as BranchingSearchResponse
    expect(body.results.map((r) => r.cellId)).toEqual(["c2"])
    expect(body.corpusSize).toBe(1)
  })

  // ─── Tunables override ──────────────────────────────────────────────

  it("topK query param overrides the default", async () => {
    const cells: CellRow[] = []
    for (let i = 1; i <= 10; i++) {
      cells.push(
        makeCell({
          cell_id: `c${i}`,
          side: "source",
          event_id: `e${i}`,
          value: "the cat sat on the mat",
        }),
      )
    }
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p1" })],
      cells,
    })
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search?q=the%20cat%20sat&topK=2",
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    const body = (await res.json()) as BranchingSearchResponse
    expect(body.results.length).toBe(2)
  })

  // ─── Provenance shape ───────────────────────────────────────────────

  it("includes a provenance entry for each result", async () => {
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p1" })],
      cells: [
        makeCell({ cell_id: "c1", side: "source", event_id: "e1", value: "the cat sat" }),
      ],
    })
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search?q=the%20cat%20sat",
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    const body = (await res.json()) as BranchingSearchResponse
    expect(body.results.length).toBe(1)
    expect(body.provenance["c1"]).toBeDefined()
    expect(body.provenance["c1"].length).toBeGreaterThan(0)
  })

  // ─── corpusEventMax ─────────────────────────────────────────────────

  it("returns the max source event_id seen as corpusEventMax", async () => {
    const db = makeInMemoryD1({
      projects: [makeProject({ id: "p1" })],
      cells: [
        makeCell({ cell_id: "c1", side: "source", event_id: "e-aaaa", value: "the cat" }),
        makeCell({ cell_id: "c2", side: "source", event_id: "e-zzzz", value: "the dog" }),
        makeCell({ cell_id: "c3", side: "source", event_id: "e-mmmm", value: "the bird" }),
      ],
    })
    const req = await authedRequest(
      "https://w/api/v1/projects/p1/branching-search?q=the",
    )
    const res = (await handleBranchingSearchRequest(req, envWith(db)))!
    const body = (await res.json()) as BranchingSearchResponse
    expect(body.corpusEventMax).toBe("e-zzzz")
  })
})
