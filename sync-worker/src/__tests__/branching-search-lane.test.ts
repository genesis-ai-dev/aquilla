// AQU-1025: branching-search few-shot corpus is lane-scoped. One source cell
// with two validated targets must not contribute both languages to the same
// query — `targetLang=French` returns only the French target; omitted / ""
// stays on the default lane (`target_lang = ''`).

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { handleBranchingSearchRequest } from "../events/branching-search-route"
import { handleBranchingSearchPassagesRequest } from "../events/branching-search-passages-route"
import { hashQueryParams } from "../lib/branching-search/cache"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "branching-search-lane-secret"
const PROJECT = "proj-bs"
const FILE = "file-gen"
const QUERY = "God called the light Day"

const SPANISH_GEN_15 = "Dios llamó a la luz Día"
const FRENCH_GEN_15 = "Dieu appela la lumière Jour"

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

const CELLS: SeedCell[] = [
  { cell_id: "gen-1-5", side: "source", value: "God called the light Day and the darkness Night" },
  { cell_id: "gen-1-5", side: "target", value: SPANISH_GEN_15, validated: 1 },
  { cell_id: "gen-1-5", side: "target", value: FRENCH_GEN_15, validated: 1, target_lang: "French" },
  { cell_id: "gen-1-1", side: "source", value: "In the beginning God created the heavens and the earth" },
  { cell_id: "gen-1-1", side: "target", value: "En el principio creó Dios los cielos", validated: 1 },
  {
    cell_id: "gen-1-1",
    side: "target",
    value: "Au commencement Dieu créa les cieux",
    validated: 1,
    target_lang: "French",
  },
]

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
  t = await makeTestDb({ cells: CELLS.map(row) })
})
afterAll(async () => {
  await t.close()
})

describe("GET /branching-search lane scoping (AQU-1025)", () => {
  it("returns only the French target when targetLang=French", async () => {
    const body = await search(
      `q=${encodeURIComponent(QUERY)}&validatedOnly=true&targetLang=French`,
    )
    expect(body.results.length).toBeGreaterThan(0)
    const hit = body.results.find((r) => r.cellId === "gen-1-5")
    expect(hit?.targetText).toBe(FRENCH_GEN_15)
    for (const r of body.results) {
      expect(r.targetText).not.toContain("Dios")
    }
  })

  it("returns only the default-lane Spanish target when targetLang is omitted", async () => {
    const body = await search(`q=${encodeURIComponent(QUERY)}&validatedOnly=true`)
    expect(body.results.length).toBeGreaterThan(0)
    const hit = body.results.find((r) => r.cellId === "gen-1-5")
    expect(hit?.targetText).toBe(SPANISH_GEN_15)
    for (const r of body.results) {
      expect(r.targetText).not.toContain("Dieu")
    }
  })

  it("treats empty targetLang the same as omitted (default lane)", async () => {
    const omitted = await search(`q=${encodeURIComponent(QUERY)}&validatedOnly=true`)
    const empty = await search(`q=${encodeURIComponent(QUERY)}&validatedOnly=true&targetLang=`)
    expect(empty.results.map((r) => r.targetText)).toEqual(
      omitted.results.map((r) => r.targetText),
    )
  })

  it("scopes the passages corpus to the requested lane", async () => {
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE })
    const req = new Request(
      `https://w/api/v1/projects/${PROJECT}/branching-search/passages` +
        `?q=${encodeURIComponent(QUERY)}&validatedOnly=true&targetLang=French`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleBranchingSearchPassagesRequest(req, env()))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      passages: Array<{ cells: Array<{ cellId: string; targetText: string }> }>
    }
    const texts = body.passages.flatMap((p) => p.cells.map((c) => c.targetText))
    expect(texts.some((text) => text === FRENCH_GEN_15)).toBe(true)
    expect(texts.some((text) => text.includes("Dios"))).toBe(false)
  })
})

describe("hashQueryParams lane (AQU-1025)", () => {
  const base = {
    q: QUERY,
    topK: 5,
    validatedOnly: true,
    excludeCellId: null as string | null,
  }

  it("hashes French and default-lane queries differently", async () => {
    const def = await hashQueryParams({ ...base, targetLang: "" })
    const fr = await hashQueryParams({ ...base, targetLang: "French" })
    expect(fr).not.toBe(def)
  })

  it("hashes omitted targetLang the same as empty string", async () => {
    const omitted = await hashQueryParams(base)
    const empty = await hashQueryParams({ ...base, targetLang: "" })
    expect(omitted).toBe(empty)
  })
})
