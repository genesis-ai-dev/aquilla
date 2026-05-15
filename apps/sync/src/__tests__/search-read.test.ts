import { describe, it, expect } from "vitest"
import {
  handleSearchReadRequest,
  sanitizeFtsQuery,
} from "../events/search-route"
import { makeInMemoryD1, type CellRow } from "./helpers/d1-fake"
import { makeTestToken } from "./helpers/auth"

const SECRET = "search-secret"

function envWith(db: ReturnType<typeof makeInMemoryD1>) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

function makeCell(
  over: Partial<CellRow> &
    Pick<CellRow, "cell_id" | "side" | "value">,
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

describe("sanitizeFtsQuery", () => {
  it("wraps each surviving token in double quotes", () => {
    expect(sanitizeFtsQuery("hello world")).toBe('"hello" "world"')
  })
  it("strips reserved FTS5 keywords", () => {
    expect(sanitizeFtsQuery("foo AND bar")).toBe('"foo" "bar"')
    expect(sanitizeFtsQuery("alpha OR NOT NEAR omega")).toBe('"alpha" "omega"')
  })
  it("removes punctuation that confuses the FTS parser", () => {
    expect(sanitizeFtsQuery('"quoted (parens) col:on"')).toBe('"quoted" "parens" "col" "on"')
  })
  it("returns null for queries that sanitize to empty", () => {
    expect(sanitizeFtsQuery('"*()"')).toBeNull()
    expect(sanitizeFtsQuery("AND OR")).toBeNull()
    expect(sanitizeFtsQuery("")).toBeNull()
  })
})

describe("GET /api/v1/projects/:projectId/search", () => {
  it("returns cells matching the query, scoped to the project", async () => {
    const db = makeInMemoryD1({
      cells: [
        makeCell({ cell_id: "c1", side: "source", value: "In the beginning God created" }),
        makeCell({ cell_id: "c1", side: "target", value: "En el principio creó Dios" }),
        makeCell({ cell_id: "c2", side: "source", value: "Earth was without form" }),
        makeCell({ cell_id: "x1", side: "source", value: "In the beginning God created", project_id: "other-proj" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/search?q=beginning", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ cellId: string; side: string; value: string; snippet: string }>
    }
    expect(body.results).toHaveLength(1)
    expect(body.results[0].cellId).toBe("c1")
    expect(body.results[0].side).toBe("source")
  })

  it("filters by side when specified", async () => {
    const db = makeInMemoryD1({
      cells: [
        makeCell({ cell_id: "c1", side: "source", value: "hola" }),
        makeCell({ cell_id: "c1", side: "target", value: "hola" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search?q=hola&side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { results: Array<{ side: string }> }
    expect(body.results).toHaveLength(1)
    expect(body.results[0].side).toBe("target")
  })

  it("returns 400 when q is missing", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/search", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("returns 400 when side is invalid", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search?q=hi&side=both",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("returns [] when the query sanitizes to empty (only punctuation)", async () => {
    const db = makeInMemoryD1({
      cells: [makeCell({ cell_id: "c1", side: "target", value: "hello" })],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/search?q=AND%20OR", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: unknown[] }
    expect(body.results).toEqual([])
  })

  it("returns 401 without an Authorization header", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const req = new Request("https://w/api/v1/projects/proj-a/search?q=hi")
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 403 when the token's projectId does not match", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "other-proj", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/search?q=hi", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("returns null when the route doesn't match", async () => {
    const db = makeInMemoryD1({ cells: [] })
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleSearchReadRequest(req, envWith(db))
    expect(res).toBeNull()
  })
})
