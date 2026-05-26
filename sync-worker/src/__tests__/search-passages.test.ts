import { describe, it, expect } from "vitest"
import { handleSearchPassagesRequest } from "../events/search-route"
import { makeInMemoryD1, type CellRow, type CellsFtsRow } from "./helpers/d1-fake"
import { makeTestToken } from "./helpers/auth"

const SECRET = "passages-secret"

function envWith(db: ReturnType<typeof makeInMemoryD1>) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

function makeCell(over: Partial<CellRow> & Pick<CellRow, "cell_id" | "side" | "value">): CellRow {
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

/**
 * Build a cells array and assign matching cells_fts rows. The caller
 * specifies which (cell_id, side) pairs should be indexed.
 */
function makeSeedData(
  cellDefs: Array<Partial<CellRow> & Pick<CellRow, "cell_id" | "side" | "value">>,
): { cells: CellRow[]; cells_fts: CellsFtsRow[] } {
  const cells = cellDefs.map(makeCell)
  // Assign stable 1-based rowids in insertion order.
  const cells_fts: CellsFtsRow[] = cells.map((c, idx) => ({
    rowid: idx + 1,
    value: c.value,
  }))
  return { cells, cells_fts }
}

describe("GET /api/v1/projects/:projectId/search/passages", () => {
  // ── 1. Happy path: paired source + target ───────────────────────────────
  it("returns matched result with pairedValue from the opposite side", async () => {
    const { cells, cells_fts } = makeSeedData([
      { cell_id: "c1", side: "source", value: "In the beginning God created" },
      { cell_id: "c1", side: "target", value: "En el principio creó Dios" },
    ])
    const db = makeInMemoryD1({ cells, cells_fts })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search/passages?q=beginning",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ cellId: string; side: string; value: string; pairedValue: string | null }>
    }
    expect(body.results.length).toBeGreaterThanOrEqual(1)
    const hit = body.results.find((r) => r.cellId === "c1" && r.side === "source")
    expect(hit).toBeDefined()
    expect(hit!.pairedValue).toBe("En el principio creó Dios")
  })

  // ── 2. No paired side → pairedValue is null ─────────────────────────────
  it("returns pairedValue: null when no opposite-side cell exists", async () => {
    const { cells, cells_fts } = makeSeedData([
      { cell_id: "c2", side: "source", value: "Earth was without form" },
    ])
    const db = makeInMemoryD1({ cells, cells_fts })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search/passages?q=without+form",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ cellId: string; pairedValue: string | null }>
    }
    expect(body.results.length).toBeGreaterThanOrEqual(1)
    expect(body.results[0].pairedValue).toBeNull()
  })

  // ── 3. Auth failures ────────────────────────────────────────────────────
  it("returns 401 when Authorization header is missing", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const req = new Request("https://w/api/v1/projects/proj-a/search/passages?q=hi")
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 403 when the token's projectId does not match the URL", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "other-proj", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/search/passages?q=hi", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("returns 401 when the JWT signature is invalid", async () => {
    const db = makeInMemoryD1({ cells: [] })
    // Sign with a DIFFERENT secret so verification fails.
    const token = await makeTestToken("wrong-secret", { projectId: "proj-a", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/search/passages?q=hi", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  // ── 4. side filter ──────────────────────────────────────────────────────
  it("?side=source returns only source-side hits", async () => {
    const { cells, cells_fts } = makeSeedData([
      { cell_id: "c3", side: "source", value: "hola amigo" },
      { cell_id: "c3", side: "target", value: "hola amigo" },
    ])
    const db = makeInMemoryD1({ cells, cells_fts })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search/passages?q=hola&side=source",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ side: string }> }
    expect(body.results.every((r) => r.side === "source")).toBe(true)
  })

  it("?side=target returns only target-side hits", async () => {
    const { cells, cells_fts } = makeSeedData([
      { cell_id: "c4", side: "source", value: "hello world" },
      { cell_id: "c4", side: "target", value: "hello world" },
    ])
    const db = makeInMemoryD1({ cells, cells_fts })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search/passages?q=hello&side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ side: string }> }
    expect(body.results.every((r) => r.side === "target")).toBe(true)
  })

  it("returns 400 when side is invalid", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search/passages?q=hi&side=both",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  // ── 5. Empty / sanitized-to-null query ──────────────────────────────────
  it("returns { results: [] } with 200 when query sanitizes to null (pure punctuation)", async () => {
    const { cells, cells_fts } = makeSeedData([
      { cell_id: "c5", side: "source", value: "some text" },
    ])
    const db = makeInMemoryD1({ cells, cells_fts })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search/passages?q=AND%20OR",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toEqual([])
  })

  it("returns 400 when q is missing", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search/passages",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  // ── 6. Cross-project isolation ──────────────────────────────────────────
  it("does NOT return results from a different project even with overlapping text", async () => {
    // Seed project B cells with the same text as project A.
    const cellsA = [makeCell({ cell_id: "ca1", side: "source", value: "genesis passage" })]
    const cellsB = [
      makeCell({
        cell_id: "cb1",
        side: "source",
        value: "genesis passage",
        project_id: "proj-b",
      }),
    ]
    const allCells = [...cellsA, ...cellsB]
    // cells_fts rowids are 1-based in insertion order.
    const cells_fts: CellsFtsRow[] = allCells.map((c, idx) => ({
      rowid: idx + 1,
      value: c.value,
    }))

    const db = makeInMemoryD1({ cells: allCells, cells_fts })

    // Token is scoped to proj-a only.
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search/passages?q=genesis",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchPassagesRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ cellId: string }> }

    // All returned results must belong to proj-a.
    // The fake's queryScopedExact handler filters by cells.project_id, so proj-b
    // rows cannot appear. This asserts the VerifiedProjectId predicate works.
    expect(body.results.every((r) => r.cellId !== "cb1")).toBe(true)
    // And at least one proj-a result is returned.
    expect(body.results.some((r) => r.cellId === "ca1")).toBe(true)
  })

  // ── Routing: null when path doesn't match ───────────────────────────────
  it("returns null when the route does not match", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleSearchPassagesRequest(req, envWith(db))
    expect(res).toBeNull()
  })
})
