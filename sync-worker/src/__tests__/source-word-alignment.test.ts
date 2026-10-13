// Bridge 1 links: GET/POST /api/v1/projects/:p/files/:f/source-word-alignment (AQU-1694)
//
// Against a real Postgres (PGlite) on the canonical schema. What matters here
// is the contract Who's Who leans on: a link is shown only while the source
// text it was computed on is the cell's current text. A source edit must turn
// the cell's links off (stale) without anything writing to this table, and a
// write computed on an older text must not land.

import { describe, it, expect } from "vitest"
import { handleSourceWordAlignmentRequest, MAX_ALIGNMENT_LINKS } from "../events/source-word-alignment-route"
import { contentHash } from "../events/event-projection"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "source-word-alignment-secret"
const PROJECT = "proj-a"
const FILE = "file-jhn"
const MAINTAINER = 600
const PROJECT_LEAD = 500
const VIEWER = 100

const TEXT_7 = "When a Samaritan woman came to draw water, Jesus said to her, “Give Me a drink.”"
const TEXT_8 = "(His disciples had gone into the town to buy food.)"

const sourceRow = (cellId: string, value: string, extra: Record<string, unknown> = {}) => ({
  project_id: PROJECT,
  file_id: FILE,
  cell_id: cellId,
  side: "source",
  target_lang: "",
  value,
  content_hash: contentHash(value),
  canonical_ref: cellId === "c7" ? "JHN 4:7" : "JHN 4:8",
  event_id: `ev-${cellId}`,
  last_edit_at: 0,
  ...extra,
})

const SEED = {
  cells: [
    sourceRow("c7", TEXT_7),
    sourceRow("c8", TEXT_8),
    // Same cell id in another file and another project: must never be read or written.
    { ...sourceRow("c7", TEXT_7), file_id: "file-other" },
    { ...sourceRow("c7", TEXT_7), project_id: "proj-b" },
  ],
}

type Link = [string, number, number]

// αὐτῇ → "to her", Ἰησοῦς → "Jesus", μοι → "Me": tokens 10–11, 8 and 13 of TEXT_7.
const LINKS_7: Link[] = [
  ["n43004007009", 10, 0.41],
  ["n43004007009", 11, 0.96],
  ["n43004007011", 8, 0.79],
  ["n43004007013", 13, 0.7432],
]
const LINKS_8: Link[] = [["n43004008003", 1, 0.88]]

async function call(
  db: TestDb,
  method: "GET" | "POST",
  opts: { role?: number; fileId?: string; body?: unknown; tokenFile?: string } = {},
): Promise<Response> {
  const fileId = opts.fileId ?? FILE
  const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: opts.tokenFile ?? fileId, role: opts.role ?? MAINTAINER })
  const request = new Request(`https://w/api/v1/projects/${PROJECT}/files/${fileId}/source-word-alignment`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const response = await handleSourceWordAlignmentRequest(request, { AQUILLA_PG: db.db, SYNC_SECRET_KEY: SECRET })
  if (!response) throw new Error("route did not match")
  return response
}

const write = (cells: { cellId: string; text: string; links: Link[] }[], replace: "file" | "cells" = "file") => ({
  replace,
  method: "ibm1-gdfa-names/1",
  trainedPairs: 878,
  cells: cells.map((cell) => ({ cellId: cell.cellId, sourceHash: contentHash(cell.text), links: cell.links })),
})

interface ReadCell {
  cellId: string
  sourceHash: string
  method: string
  trainedPairs: number
  stale: boolean
  links: Link[]
}

async function read(db: TestDb, role = VIEWER): Promise<ReadCell[]> {
  const response = await call(db, "GET", { role })
  expect(response.status).toBe(200)
  return ((await response.json()) as { cells: ReadCell[] }).cells
}

describe("source word alignment: round trip", () => {
  it("reads back what a maintainer wrote, grouped by cell, for any member", async () => {
    const db = await makeTestDb(SEED)
    const written = await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: LINKS_7 }, { cellId: "c8", text: TEXT_8, links: LINKS_8 }]) })
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({ accepted: 2, links: 5, stale: [] })

    const cells = await read(db)
    const c7 = cells.find((cell) => cell.cellId === "c7")!
    expect(c7).toMatchObject({ sourceHash: contentHash(TEXT_7), method: "ibm1-gdfa-names/1", trainedPairs: 878, stale: false })
    // Confidence comes back to three places: enough to place a tint, a third of the bytes.
    expect(c7.links).toEqual([
      ["n43004007011", 8, 0.79],
      ["n43004007009", 10, 0.41],
      ["n43004007009", 11, 0.96],
      ["n43004007013", 13, 0.743],
    ])
    expect(cells.find((cell) => cell.cellId === "c8")!.links).toEqual(LINKS_8)
  })

  it("never reads or writes across the file or the project", async () => {
    const db = await makeTestDb(SEED)
    await db.pg.query(
      `INSERT INTO source_word_alignment (project_id, file_id, cell_id, src_word_id, tgt_token_idx, conf, method, source_hash, trained_pairs)
       VALUES ('proj-b', $1, 'c7', 'n43004007011', 0, 0.9, 'm', $2, 1), ($3, 'file-other', 'c7', 'n43004007011', 0, 0.9, 'm', $2, 1)`,
      [FILE, contentHash(TEXT_7), PROJECT],
    )
    await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: LINKS_7 }]) })
    expect((await read(db)).map((cell) => cell.cellId)).toEqual(["c7"])
    const others = await db.pg.query(`SELECT count(*)::int AS n FROM source_word_alignment WHERE project_id = 'proj-b' OR file_id = 'file-other'`)
    expect(others.rows[0]).toEqual({ n: 2 })
  })
})

describe("source word alignment: a changed source cell", () => {
  it("reads as stale, with no links, once the source text changes", async () => {
    const db = await makeTestDb(SEED)
    await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: LINKS_7 }, { cellId: "c8", text: TEXT_8, links: LINKS_8 }]) })
    // A source commit moves cells.content_hash; nothing touches the alignment rows.
    const edited = TEXT_7.replace("Jesus", "Yeshua")
    await db.pg.query(`UPDATE cells SET value = $1, content_hash = $2 WHERE project_id = $3 AND file_id = $4 AND cell_id = 'c7'`, [
      edited,
      contentHash(edited),
      PROJECT,
      FILE,
    ])
    const cells = await read(db)
    expect(cells.find((cell) => cell.cellId === "c7")).toMatchObject({ stale: true, links: [] })
    expect(cells.find((cell) => cell.cellId === "c8")).toMatchObject({ stale: false, links: LINKS_8 })
  })

  it("refuses links computed on an older text and keeps the cell's current rows", async () => {
    const db = await makeTestDb(SEED)
    await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: LINKS_7 }]) })
    // A browser that still had last week's text for c7 aligns again.
    const response = await call(db, "POST", {
      body: write([{ cellId: "c7", text: "When a woman of Samaria came…", links: [["n43004007002", 3, 0.9]] }], "cells"),
    })
    expect(await response.json()).toEqual({ accepted: 0, links: 0, stale: ["c7"] })
    expect((await read(db)).find((cell) => cell.cellId === "c7")!.links).toHaveLength(LINKS_7.length)
  })

  it("drops a deleted cell's rows on the next run for the file", async () => {
    const db = await makeTestDb(SEED)
    await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: LINKS_7 }, { cellId: "c8", text: TEXT_8, links: LINKS_8 }]) })
    await db.pg.query(`DELETE FROM cells WHERE project_id = $1 AND file_id = $2 AND cell_id = 'c8'`, [PROJECT, FILE])
    // Gone from reads at once (the read joins the source row) …
    expect((await read(db)).map((cell) => cell.cellId)).toEqual(["c7"])
    // … and from the table when the next run starts.
    await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: LINKS_7 }]) })
    const left = await db.pg.query(`SELECT DISTINCT cell_id FROM source_word_alignment WHERE project_id = $1 AND file_id = $2`, [PROJECT, FILE])
    expect(left.rows).toEqual([{ cell_id: "c7" }])
  })

  it("replaces a cell's links rather than adding to them", async () => {
    const db = await makeTestDb(SEED)
    await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: LINKS_7 }]) })
    await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: [["n43004007011", 8, 0.5]] }], "cells") })
    expect((await read(db))[0].links).toEqual([["n43004007011", 8, 0.5]])
  })
})

describe("source word alignment: who may do what", () => {
  it("needs the Maintainer role to write, like the project's settings", async () => {
    const db = await makeTestDb(SEED)
    const response = await call(db, "POST", { role: PROJECT_LEAD, body: write([{ cellId: "c7", text: TEXT_7, links: LINKS_7 }]) })
    expect(response.status).toBe(403)
    expect(await read(db)).toEqual([])
  })

  it("refuses a token scoped to another file", async () => {
    const db = await makeTestDb(SEED)
    const response = await call(db, "GET", { tokenFile: "file-other" })
    expect(response.status).toBe(403)
  })

  it("rejects malformed links and oversized writes before touching the table", async () => {
    const db = await makeTestDb(SEED)
    const bad = write([{ cellId: "c7", text: TEXT_7, links: [["not-a-word-id", 1, 0.5]] }])
    expect((await call(db, "POST", { body: bad })).status).toBe(400)
    const outOfRange = write([{ cellId: "c7", text: TEXT_7, links: [["n43004007011", 1, 1.5]] }])
    expect((await call(db, "POST", { body: outOfRange })).status).toBe(400)
    const huge: Link[] = Array.from({ length: MAX_ALIGNMENT_LINKS + 1 }, (_, k) => ["n43004007011", k, 0.5])
    expect((await call(db, "POST", { body: write([{ cellId: "c7", text: TEXT_7, links: huge }]) })).status).toBe(400)
    expect(await read(db)).toEqual([])
  })
})
