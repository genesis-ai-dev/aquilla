import { describe, it, expect } from "vitest"
import {
  handleSearchPassagesRequest,
  handleSearchReadRequest,
  sanitizeFtsQuery,
} from "../events/search-route"
import { type CellRow } from "./helpers/in-memory-db"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "search-secret"

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
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
    const { db } = await makeTestDb({
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

  // AQU-1566: a promoted caption leaves its cues live in a deleted staging (or
  // track) file. The editor only drops hits from hidden files it can list,
  // never a deleted one, so the caption came back twice, the second time
  // under a blank file name. Deleted and hidden timeline files are not searched.
  it("returns one hit per caption after it became the file's rows", async () => {
    const caption = "Earlier caption"
    const { db } = await makeTestDb({
      files: [
        { id: "file-x", project_id: "proj-a", name: "Episode", kind: "srt", event_id: "e-f1" },
        { id: "staged", project_id: "proj-a", name: "captions.srt", kind: "srt", role: "timeline-content",
          anchor_file_id: "file-x", event_id: "e-f2", deleted_at: 5 },
        { id: "track", project_id: "proj-a", name: "Track B", kind: "vtt", role: "timeline-content",
          anchor_file_id: "file-x", event_id: "e-f3" },
        { id: "gone", project_id: "proj-a", name: "Deleted doc", kind: "codex", event_id: "e-f4", deleted_at: 6 },
      ],
      cells: [
        makeCell({ cell_id: "row1", side: "source", value: caption }),
        makeCell({ cell_id: "cue1", side: "source", value: caption, file_id: "staged" }),
        makeCell({ cell_id: "cue2", side: "source", value: caption, file_id: "track" }),
        makeCell({ cell_id: "doc1", side: "source", value: caption, file_id: "gone" }),
        // A cell whose file row is missing is still read as before.
        makeCell({ cell_id: "orphan", side: "source", value: caption, file_id: "no-row" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    for (const [path, handle] of [
      ["search?q=earlier%20caption", handleSearchReadRequest],
      ["search/passages?q=earlier%20caption", handleSearchPassagesRequest],
    ] as const) {
      const res = (await handle(new Request(`https://w/api/v1/projects/proj-a/${path}`, {
        headers: { Authorization: `Bearer ${token}` },
      }), envWith(db)))!
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results: Array<{ cellId: string; fileId: string }> }
      expect(body.results.map((r) => r.cellId).sort()).toEqual(["orphan", "row1"])
    }
  })

  it("filters by side when specified", async () => {
    const { db } = await makeTestDb({
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
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/search", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("returns 400 when side is invalid", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search?q=hi&side=both",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(400)
  })

  it("returns [] when the query sanitizes to empty (only punctuation)", async () => {
    const { db } = await makeTestDb({
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
    const { db } = await makeTestDb({ cells: [] })
    const req = new Request("https://w/api/v1/projects/proj-a/search?q=hi")
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 403 when the token's projectId does not match", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "other-proj", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/search?q=hi", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("returns null when the route doesn't match", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleSearchReadRequest(req, envWith(db))
    expect(res).toBeNull()
  })
})
