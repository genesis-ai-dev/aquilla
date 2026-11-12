// AQU-1393: every branching-search hit names the file its source cell lives
// in. The editor's Examples panel resolves a match's origin from it — the
// project file, or `TM · <file>` for an imported TMX. The response used to
// carry no file id at all, so the panel could never say where a match came
// from after a single-cell draft.

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { handleBranchingSearchRequest } from "../events/branching-search-route"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "branching-search-origin-secret"
const PROJECT = "proj-origin"
const FILE_GEN = "file-gen"
const FILE_TMX = "file-tmx"

function pair(fileId: string, cellId: string, source: string, target: string) {
  const base = {
    project_id: PROJECT,
    file_id: fileId,
    cell_id: cellId,
    target_lang: "",
    last_edit_at: 1700000000000,
  }
  return [
    { ...base, side: "source", value: source, event_id: `ev-${cellId}-source`, validated: 0 },
    { ...base, side: "target", value: target, event_id: `ev-${cellId}-target`, validated: 1 },
  ]
}

let t: TestDb

beforeAll(async () => {
  t = await makeTestDb({
    cells: [
      ...pair(FILE_GEN, "gen-1-1", "In the beginning God created the heavens and the earth", "En el principio creó Dios los cielos y la tierra"),
      ...pair(FILE_TMX, "tu-0001", "In the beginning God created the heaven and the earth", "En el principio Dios creó el cielo y la tierra"),
    ],
  })
})
afterAll(async () => {
  await t.close()
})

describe("GET /branching-search result origin (AQU-1393)", () => {
  it("returns the source cell's file id on every hit", async () => {
    const token = await makeTestToken(SECRET, { projectId: PROJECT, fileId: FILE_GEN })
    const req = new Request(
      `https://w/api/v1/projects/${PROJECT}/branching-search` +
        `?q=${encodeURIComponent("In the beginning God created the heavens and the earth")}` +
        "&validatedOnly=true&topK=5",
      { headers: { Authorization: `Bearer ${token}` } },
    )
    const res = (await handleBranchingSearchRequest(req, { AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET }))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ cellId: string; fileId?: string }> }

    const fileByCell = new Map(body.results.map((r) => [r.cellId, r.fileId]))
    expect(fileByCell.get("gen-1-1")).toBe(FILE_GEN)
    expect(fileByCell.get("tu-0001")).toBe(FILE_TMX)
  })
})
