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
    Pick<CellRow, "cell_id" | "side" | "value"> & {
      sequence_index?: number | null
      metadata?: Record<string, unknown> | null
    },
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
      results: Array<{ cellId: string; side: string; value: string; snippet: string; pairedValue: string | null }>
    }
    expect(body.results).toHaveLength(1)
    expect(body.results[0].cellId).toBe("c1")
    expect(body.results[0].side).toBe("source")
    expect(body.results[0].pairedValue).toBe("En el principio creó Dios")
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
    const body = (await res.json()) as { results: Array<{ side: string; pairedValue: string | null }> }
    expect(body.results).toHaveLength(1)
    expect(body.results[0].side).toBe("target")
    expect(body.results[0].pairedValue).toBe("hola")
  })

  it("returns pairedValue null when the opposite side has no row", async () => {
    const { db } = await makeTestDb({
      cells: [makeCell({ cell_id: "c1", side: "target", value: "orphan target" })],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request(
      "https://w/api/v1/projects/proj-a/search?q=orphan&side=target",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleSearchReadRequest(req, envWith(db)))!
    const body = (await res.json()) as { results: Array<{ pairedValue: string | null }> }
    expect(body.results).toHaveLength(1)
    expect(body.results[0].pairedValue).toBeNull()
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

  it("honors match case, whole word, and a regular expression", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "god", side: "target", value: "the God of heaven" }),
        makeCell({ cell_id: "lower", side: "target", value: "a god among idols" }),
        makeCell({ cell_id: "goddess", side: "target", value: "the Goddess" }),
        makeCell({ cell_id: "color", side: "target", value: "color and colour" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const search = async (query: string) => {
      const res = (await handleSearchReadRequest(
        new Request(`https://w/api/v1/projects/proj-a/search?${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        envWith(db),
      ))!
      expect(res.status).toBe(200)
      const body = (await res.json()) as { results: Array<{ cellId: string; snippet: string }> }
      return body.results
    }

    const cased = await search("q=God&case=1")
    expect(cased.map((row) => row.cellId).sort()).toEqual(["god", "goddess"])
    expect(cased.find((row) => row.cellId === "god")?.snippet).toContain("<mark>God</mark>")

    const words = await search("q=God&word=1")
    expect(words.map((row) => row.cellId).sort()).toEqual(["god", "lower"])

    const pattern = await search("q=colou%3Fr&regexp=1")
    expect(pattern.map((row) => row.cellId)).toEqual(["color"])
    expect(pattern[0].snippet).toContain("<mark>")
  })

  it("matches a JavaScript word-boundary regexp in the worker", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({ cell_id: "god", side: "target", value: "the God of heaven" }),
        makeCell({ cell_id: "goddess", side: "target", value: "the Goddess" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const res = (await handleSearchReadRequest(
      new Request("https://w/api/v1/projects/proj-a/search?q=%5CbGod%5Cb&regexp=1", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ cellId: string }> }
    expect(body.results.map((row) => row.cellId)).toEqual(["god"])
  })

  it("names a target hit by the source verse, and a heading by its label", async () => {
    const { db } = await makeTestDb({
      cells: [
        makeCell({
          cell_id: "head", side: "source", value: "The creation", type: "heading",
          sequence_index: 0,
          metadata: { aquillaImport: { milestone: { label: "Creation" } } },
        }),
        makeCell({ cell_id: "head", side: "target", value: "God made the heading" }),
        makeCell({
          cell_id: "a", side: "source", value: "In the beginning",
          canonical_ref: "GEN 1:1", type: "verse", sequence_index: 1,
        }),
        makeCell({ cell_id: "a", side: "target", value: "God made the light first" }),
        makeCell({
          cell_id: "b", side: "source", value: "And the light",
          canonical_ref: "GEN 1:1", type: "verse", sequence_index: 2,
        }),
        makeCell({ cell_id: "b", side: "target", value: "God made the light second" }),
        makeCell({
          cell_id: "note", side: "source", value: "a study note", sequence_index: 3,
        }),
        makeCell({ cell_id: "note", side: "target", value: "God made a note" }),
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const search = async (query: string) => {
      const res = (await handleSearchReadRequest(
        new Request(`https://w/api/v1/projects/proj-a/search?${query}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        envWith(db),
      ))!
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        results: Array<{
          cellId: string
          canonicalRef: string | null
          cellType: string | null
          placeLabel: string | null
          position: number
        }>
      }
      return body.results
    }

    const hits = await search("q=God&side=target")
    const byId = new Map(hits.map((row) => [row.cellId, row]))
    expect(byId.get("a")).toMatchObject({
      canonicalRef: "GEN 1:1", cellType: "verse", position: 2,
    })
    expect(byId.get("b")).toMatchObject({
      canonicalRef: "GEN 1:1", cellType: "verse", position: 3,
    })
    expect(byId.get("head")).toMatchObject({
      cellType: "heading", placeLabel: "Creation", position: 1,
    })
    expect(byId.get("note")?.position).toBe(4)
    expect(byId.get("note")?.canonicalRef).toBeNull()

    const cased = await search("q=God&side=target&case=1")
    expect(cased.find((row) => row.cellId === "a")?.canonicalRef).toBe("GEN 1:1")
  })

  it("rejects an invalid regular expression", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const res = (await handleSearchReadRequest(
      new Request("https://w/api/v1/projects/proj-a/search?q=(&regexp=1", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(400)
  })

  it("returns null when the route doesn't match", async () => {
    const { db } = await makeTestDb({ cells: [] })
    const req = new Request("https://w/api/v1/something-else")
    const res = await handleSearchReadRequest(req, envWith(db))
    expect(res).toBeNull()
  })
})

// AQU-2732: a page is cut at `limit`, and nothing said so. A full page of 50
// read the same for 50 matches and for 5,000, the side panel's "N more" line
// could never show, and Replace all changed the first page in silence. The
// response now carries `total`, counted by the query that made the page.
describe("search totals (AQU-2732)", () => {
  interface Page {
    results: Array<{ cellId: string }>
    total: number
    totalIsLowerBound: boolean
  }

  type Seed = Parameters<typeof makeCell>[0] & { lane_id?: string | null; hidden_at?: number | null }
  const cellRow = (over: Seed) => makeCell(over) as ReturnType<typeof makeCell>

  async function page(
    db: AquillaDb,
    pathAndQuery: string,
    opts: { walledTo?: string } = {},
  ): Promise<Page> {
    const token = await makeTestToken(SECRET, {
      projectId: "proj-a",
      fileId: "any",
      ...(opts.walledTo ? { role: 400, laneGrants: [{ lane: opts.walledTo, level: 400 }] } : {}),
    })
    const handle = pathAndQuery.startsWith("search/passages") ? handleSearchPassagesRequest : handleSearchReadRequest
    const res = (await handle(
      new Request(`https://w/api/v1/projects/proj-a/${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { ...envWith(db), ...(opts.walledTo ? { LANE_READ_WALL: "1" } : {}) },
    ))!
    expect(res.status).toBe(200)
    return (await res.json()) as Page
  }

  // One project, two books. As a word, "temple" is in 6 target cells and 1
  // source cell of 2 Kings and 2 target cells of Ezra: 9. One of the nine is
  // capitalised, and "temples" is a tenth cell to a substring test and to no
  // other. Never counted: a parked cell, a cell of a deleted file, and
  // another project's cell.
  async function seedTemple() {
    return makeTestDb({
      files: [
        { id: "kings", project_id: "proj-a", name: "2 Kings", event_id: "fe1" },
        { id: "ezra", project_id: "proj-a", name: "Ezra", event_id: "fe2" },
        { id: "gone", project_id: "proj-a", name: "Deleted", event_id: "fe3", deleted_at: 5 },
      ],
      cells: [
        ...[1, 2, 3, 4, 5].map((n) =>
          cellRow({ cell_id: `k${n}`, side: "target", value: `he went up to the temple ${n}`, file_id: "kings" }),
        ),
        cellRow({ cell_id: "k6", side: "target", value: "The Temple was shut", file_id: "kings" }),
        cellRow({ cell_id: "k1", side: "source", value: "the temple gate", file_id: "kings" }),
        cellRow({ cell_id: "k7", side: "target", value: "temples of the nations", file_id: "kings" }),
        cellRow({ cell_id: "e1", side: "target", value: "build the temple again", file_id: "ezra" }),
        cellRow({ cell_id: "e2", side: "target", value: "the temple stood", file_id: "ezra" }),
        cellRow({ cell_id: "p1", side: "source", value: "parked", file_id: "kings", hidden_at: 9 }),
        cellRow({ cell_id: "p1", side: "target", value: "the temple, parked", file_id: "kings" }),
        cellRow({ cell_id: "g1", side: "target", value: "the temple, deleted", file_id: "gone" }),
        cellRow({ cell_id: "x1", side: "target", value: "the temple elsewhere", project_id: "other" }),
      ],
    })
  }

  it.each([
    // [what, path and query, total]
    ["the word index", "search?q=temple", 9],
    ["one side", "search?q=temple&side=target", 8],
    ["one file", "search?q=temple&fileId=kings", 7],
    ["one file, one side", "search?q=temple&fileId=kings&side=target", 6],
    // Loses "The Temple", gains "temples": a case-sensitive substring.
    ["match case", "search?q=temple&case=1", 9],
    ["whole word", "search?q=temple&word=1", 9],
    ["a regexp Postgres runs", "search?q=temples%3F&regexp=1", 10],
    ["a regexp only the worker runs", "search?q=%5Cbtemple%5Cb&regexp=1", 9],
    ["passages", "search/passages?q=the%20temple", 9],
  ])("counts every match past the page: %s", async (_what, pathAndQuery, total) => {
    const { db } = await seedTemple()
    const cut = await page(db, `${pathAndQuery}&limit=2`)
    expect(cut.results).toHaveLength(2)
    expect(cut).toMatchObject({ total, totalIsLowerBound: false })
    // The whole list, when asked for, is that many rows.
    expect((await page(db, `${pathAndQuery}&limit=500`)).results).toHaveLength(total)
  })

  it("counts text matches in a script with no spaces between words", async () => {
    const { db } = await makeTestDb({
      cells: [1, 2, 3].map((n) => cellRow({ cell_id: `v${n}`, side: "target", value: `並所用的一切銅器皿${n}` })),
    })
    expect(await page(db, `search?q=${encodeURIComponent("器皿")}&limit=1`)).toMatchObject({
      results: [{ cellId: "v1" }],
      total: 3,
      totalIsLowerBound: false,
    })
    expect(await page(db, `search/passages?q=${encodeURIComponent("器皿")}&limit=1`)).toMatchObject({ total: 3 })
  })

  it("says nothing matched as a total of zero", async () => {
    const { db } = await seedTemple()
    for (const query of ["search?q=quokka", "search?q=quokka&case=1", "search/passages?q=quokka", "search?q=%22*()%22"]) {
      expect(await page(db, query)).toEqual({ results: [], total: 0, totalIsLowerBound: false })
    }
  })

  // The wall is part of the WHERE, so it is part of the count: a member
  // limited to lane A must not learn from a number how much lane B holds.
  it("counts only what a lane-limited member can see", async () => {
    const lane = (id: string, tag: string) =>
      ({ id, project_id: "proj-a", role: "target", name: id, lang_code: tag || "sw", legacy_tag: tag })
    const { db } = await makeTestDb({
      lanes: [lane("lane-a", ""), lane("lane-b", "fr")],
      cells: [
        ...[1, 2, 3].map((n) =>
          cellRow({ cell_id: `c${n}`, side: "target", value: `the temple 器皿 a${n}`, lane_id: "lane-a", event_id: `ea${n}` }),
        ),
        ...[1, 2, 3, 4, 5].map((n) =>
          cellRow({ cell_id: `c${n}`, side: "target", value: `the temple 器皿 b${n}`, lane_id: "lane-b", event_id: `eb${n}` }),
        ),
      ],
    })
    for (const query of [
      "search?q=temple",
      `search?q=${encodeURIComponent("器皿")}`,
      "search?q=temple&case=1",
      "search?q=temple&word=1",
      "search?q=%5Cbtemple%5Cb&regexp=1",
      "search/passages?q=the%20temple",
    ]) {
      const walled = await page(db, `${query}&limit=2`, { walledTo: "lane-a" })
      expect(walled, query).toMatchObject({ total: 3, totalIsLowerBound: false })
      expect(walled.results, query).toHaveLength(2)
      expect((await page(db, `${query}&limit=2`)).total, query).toBe(8)
    }
  })

  // Whole word is decided in the worker over at most 500 of the rows SQL let
  // through. Past that read the rest is not known, and the response says so
  // rather than passing a partial count off as the count.
  it("reports a floor when whole word has more candidates than it reads", async () => {
    const pad = (n: number) => String(n).padStart(4, "0")
    const { db } = await makeTestDb({
      cells: [
        // Sorts first, so all of these are inside the read.
        ...[1, 2, 3].map((n) => cellRow({ cell_id: `a${pad(n)}`, side: "target", value: `the temple ${n}` })),
        // 600 substring hits that are not the word.
        ...Array.from({ length: 600 }, (_, n) =>
          cellRow({ cell_id: `b${pad(n)}`, side: "target", value: `temples ${n}` }),
        ),
        // A real match the read never reaches.
        cellRow({ cell_id: "z0001", side: "target", value: "the temple at last" }),
      ],
    })
    const words = await page(db, "search?q=temple&word=1&limit=2")
    expect(words.results.map((row) => row.cellId)).toEqual(["a0001", "a0002"])
    expect(words).toMatchObject({ total: 3, totalIsLowerBound: true })
    // The same cells with match case alone are counted in SQL, exactly.
    expect(await page(db, "search?q=temple&case=1&limit=2")).toMatchObject({ total: 604, totalIsLowerBound: false })
  })
})

// AQU-2732: a hit's place in its file is counted a hit at a time on a small
// page, and a file at a time on a big page or a page out of one file
// (`numbersPlacesByFile`). Whichever way a request takes, the number is the
// same one.
describe("a hit's place in its file, however it is counted (AQU-2732)", () => {
  type Seed = Parameters<typeof makeCell>[0] & { lane_id?: string | null; hidden_at?: number | null }
  const cellRow = (over: Seed) => makeCell(over) as ReturnType<typeof makeCell>

  /** `file/cell → position` for every row returned, in a fixed order. A row listed twice shows twice. */
  async function places(db: AquillaDb, pathAndQuery: string): Promise<Array<[string, number | null]>> {
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const handle = pathAndQuery.startsWith("search/passages") ? handleSearchPassagesRequest : handleSearchReadRequest
    const res = (await handle(
      new Request(`https://w/api/v1/projects/proj-a/${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status, pathAndQuery).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ fileId: string; cellId: string; position: number | null }>
    }
    return body.results
      .map((row): [string, number | null] => [`${row.fileId}/${row.cellId}`, row.position])
      .sort((a, b) => a[0].localeCompare(b[0]))
  }

  // Every translation says "a lamp" and 燈, so one seed serves the word
  // index, the flags, text matching and passages.
  //   "ordered" reads zed, (a parked cell), mid, abe: against its ids, and
  //     the parked cell is nobody's place. "orphan" is a translation with no
  //     source row; it comes after every cell that has one.
  //   "migrated" has no sequence index, as a project from Codex has none,
  //     and reads in id order.
  const seed = () =>
    makeTestDb({
      cells: [
        cellRow({ file_id: "ordered", cell_id: "zed", side: "source", value: "one", sequence_index: 1 }),
        cellRow({ file_id: "ordered", cell_id: "parked", side: "source", value: "two", sequence_index: 2, hidden_at: 1 }),
        cellRow({ file_id: "ordered", cell_id: "mid", side: "source", value: "three", sequence_index: 3 }),
        cellRow({ file_id: "ordered", cell_id: "abe", side: "source", value: "four", sequence_index: 4 }),
        ...["zed", "parked", "mid", "abe"].map((id) =>
          cellRow({ file_id: "ordered", cell_id: id, side: "target", value: `a lamp 燈 for ${id}` }),
        ),
        cellRow({ file_id: "ordered", cell_id: "orphan", side: "target", value: "a lamp 燈 with no source" }),
        ...["k1", "k2", "k3"].flatMap((id) => [
          cellRow({ file_id: "migrated", cell_id: id, side: "source", value: `verse ${id}` }),
          cellRow({ file_id: "migrated", cell_id: id, side: "target", value: `a lamp 燈 in ${id}` }),
        ]),
      ],
    })

  const ORDERED: Array<[string, number]> = [
    ["ordered/abe", 3],
    ["ordered/mid", 2],
    ["ordered/orphan", 4],
    ["ordered/zed", 1],
  ]
  const MIGRATED: Array<[string, number]> = [
    ["migrated/k1", 1],
    ["migrated/k2", 2],
    ["migrated/k3", 3],
  ]
  const cjk = encodeURIComponent("燈")
  const jsOnlyRegexp = encodeURIComponent(String.raw`\blamp\b`)

  it.each([
    ["the word index, a page of 50", "search?q=lamp&side=target"],
    ["the word index, a page of 500", "search?q=lamp&side=target&limit=500"],
    ["match case, a page of 50", "search?q=lamp&side=target&case=1"],
    ["match case, a page of 500", "search?q=lamp&side=target&case=1&limit=500"],
    ["whole word, which reads 500 rows whatever the page", "search?q=lamp&side=target&word=1"],
    ["a regexp only the worker can run, which reads the project", `search?q=${jsOnlyRegexp}&side=target&regexp=1`],
    ["text matching, a page of 50", `search?q=${cjk}&side=target`],
    ["text matching, a page of 500", `search?q=${cjk}&side=target&limit=500`],
    ["passages, a page of 50", "search/passages?q=a%20lamp&side=target"],
    ["passages, a page of 500", "search/passages?q=a%20lamp&side=target&limit=500"],
  ])("%s", async (_name, query) => {
    const { db } = await seed()
    expect(await places(db, query)).toEqual([...MIGRATED, ...ORDERED])
  })

  it.each([
    ["the word index", "search?q=lamp&side=target&fileId=ordered"],
    ["match case", "search?q=lamp&side=target&case=1&fileId=ordered"],
    ["text matching", `search?q=${cjk}&side=target&fileId=ordered`],
  ])("one file, %s", async (_name, query) => {
    const { db } = await seed()
    expect(await places(db, query)).toEqual(ORDERED)
  })

  // A project has one source lane, but nothing ties a row's side to its
  // lane's role, so the schema does not rule out a second source row for a
  // cell. Numbering a file at a time joins hits to that numbering, and a
  // cell numbered twice would come back as two hits.
  it("lists a hit once when its cell has two source rows", async () => {
    const { db } = await makeTestDb({
      lanes: [{ id: "stray", project_id: "proj-a", role: "target", name: "stray", lang_code: "sw", legacy_tag: "stray" }],
      cells: [
        cellRow({ cell_id: "a", side: "source", value: "one", sequence_index: 1 }),
        cellRow({ cell_id: "a", side: "source", value: "one again", sequence_index: 1, lane_id: "stray", event_id: "e-a-stray" }),
        cellRow({ cell_id: "a", side: "target", value: "a lamp" }),
        cellRow({ cell_id: "b", side: "source", value: "two", sequence_index: 2 }),
        cellRow({ cell_id: "b", side: "target", value: "a lamp too" }),
      ],
    })
    for (const query of ["search?q=lamp&side=target", "search?q=lamp&side=target&limit=500"]) {
      expect((await places(db, query)).map(([key]) => key), query).toEqual(["file-x/a", "file-x/b"])
    }
  })
})
