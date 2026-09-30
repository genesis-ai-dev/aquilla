// GET /api/v1/projects/:projectId/files/:fileId/morph  (AQU-462)
//
// Against a real Postgres (PGlite) on the canonical schema, because what is
// worth pinning here is the scoping: morphology rows are keyed by
// (project, file, cell, word_seq), and a read that leaks across any of those
// keys would hand a translator another file's original-language words.
//
// The route is deliberately id-bounded: a Macula book is tens of thousands of
// words and the caller is one expanded row, so an unbounded read is a bug, not
// a convenience.

import { describe, it, expect } from "vitest"
import { handleCellMorphReadRequest, MAX_MORPH_CELL_IDS } from "../events/cell-morph-read-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "cell-morph-read-secret"
const PROJECT = "proj-a"
const FILE = "file-gen"
const OTHER_FILE = "file-exo"

interface MorphWordOut {
  cellId: string
  wordSeq: number
  surface: string
  lemma?: string
  morphCode?: string
  strongsH?: string
  strongsG?: string
}

const word = (
  cellId: string,
  wordSeq: number,
  surface: string,
  extra: Partial<{
    lemma: string
    morph_code: string
    strongs_h: string
    strongs_g: string
    file_id: string
    project_id: string
  }> = {},
) => ({
  project_id: PROJECT,
  file_id: FILE,
  cell_id: cellId,
  word_seq: wordSeq,
  surface,
  ...extra,
})

const SEED = {
  cell_word_morph: [
    // Deliberately out of word order so the ORDER BY is doing real work.
    word("c1", 2, "בָּרָא", { lemma: "ברא", morph_code: "HVqp3ms", strongs_h: "H1254" }),
    word("c1", 1, "בְּרֵאשִׁית", { lemma: "רֵאשִׁית", morph_code: "HR/Ncfsa", strongs_h: "H7225" }),
    word("c1", 3, "אֱלֹהִים", { lemma: "אֱלֹהִים", strongs_h: "H430" }),
    word("c2", 1, "וְהָאָרֶץ", { lemma: "אֶרֶץ", strongs_h: "H776" }),
    // Same cell id in a different file of the same project — must not leak.
    word("c1", 1, "leaked-file", { file_id: OTHER_FILE }),
    // Same cell id in a different project — must not leak.
    word("c1", 1, "leaked-project", { project_id: "proj-b" }),
  ],
}

async function request(
  query: string,
  opts: { token?: string; method?: string } = {},
): Promise<Response | null> {
  const { db } = await makeTestDb(SEED)
  const token =
    opts.token ?? (await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE, role: 100 }))
  const req = new Request(
    `https://w/api/v1/projects/${PROJECT}/files/${FILE}/morph${query}`,
    { method: opts.method ?? "GET", headers: { Authorization: `Bearer ${token}` } },
  )
  return handleCellMorphReadRequest(req, { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET })
}

async function readWords(query: string): Promise<MorphWordOut[]> {
  const res = (await request(query))!
  expect(res.status).toBe(200)
  return ((await res.json()) as { words: MorphWordOut[] }).words
}

describe("original-language morphology read", () => {
  it("returns the cell's words in word_seq order with their morphology", async () => {
    const words = await readWords("?cellIds=c1")

    expect(words.map((w) => w.wordSeq)).toEqual([1, 2, 3])
    expect(words[0]).toEqual({
      cellId: "c1",
      wordSeq: 1,
      surface: "בְּרֵאשִׁית",
      lemma: "רֵאשִׁית",
      morphCode: "HR/Ncfsa",
      strongsH: "H7225",
    })
    // Optional columns are omitted rather than sent as null — the client type
    // treats them as absent, and a null lemma would defeat the lemma backoff.
    expect(words[2]).not.toHaveProperty("morphCode")
    expect(words[2]).not.toHaveProperty("strongsG")
  })

  it("reads several cells in one request, grouped by cell", async () => {
    const words = await readWords("?cellIds=c1,c2")
    expect(words.filter((w) => w.cellId === "c1")).toHaveLength(3)
    expect(words.filter((w) => w.cellId === "c2")).toHaveLength(1)
  })

  it("never crosses the file or the project, even for the same cell id", async () => {
    const surfaces = (await readWords("?cellIds=c1")).map((w) => w.surface)
    expect(surfaces).not.toContain("leaked-file")
    expect(surfaces).not.toContain("leaked-project")
  })

  it("returns an empty list for a cell that has no morphology", async () => {
    expect(await readWords("?cellIds=no-such-cell")).toEqual([])
  })

  it("requires cellIds — a whole-file morph dump is not a supported read", async () => {
    const res = (await request(""))!
    expect(res.status).toBe(400)
  })

  it("rejects more cell ids than the cap", async () => {
    const tooMany = Array.from({ length: MAX_MORPH_CELL_IDS + 1 }, (_, i) => `c${i}`).join(",")
    const res = (await request(`?cellIds=${tooMany}`))!
    expect(res.status).toBe(400)
  })

  it("rejects a token scoped to another project", async () => {
    const token = await makeTestToken(SECRET, { projectId: "proj-b", fileId: FILE, role: 600 })
    const res = (await request("?cellIds=c1", { token }))!
    expect(res.status).toBe(403)
  })

  it("does not claim a non-GET request", async () => {
    expect(await request("?cellIds=c1", { method: "POST" })).toBeNull()
  })
})
