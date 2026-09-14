// Files listing: keyset pagination + the threshold-aware approved count after
// the correlated-subquery rewrite.
//
// Why: the listing is fetched on every workspace open and by the PM dashboard;
// prod measured it at ~444 ms mean. The rewrite must keep the exact approved
// semantics (validationCount threshold, 15+ cap, legacy fallback) while the
// paging must be exact across the NULLS LAST tail and name ties.
import { describe, it, expect } from "vitest"
import { handleFilesReadRequest, decodeFilesCursor, encodeFilesCursor } from "../events/files-read-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "files-page-secret"

async function get(db: AquillaDb, path: string) {
  const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
  return (await handleFilesReadRequest(
    new Request(`https://w${path}`, { headers: { Authorization: `Bearer ${token}` } }),
    { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET },
  ))!
}

type Page = { files: Array<{ fileId: string; name: string; lastEditAt: number | null; approvedCount: number }>; nextCursor: string | null }

describe("GET /files — keyset pagination", () => {
  it("walks the listing exactly once through last_edit_at ties, name ties and the NULL tail", async () => {
    const files = [
      // three-way last_edit_at tie, two of them a name tie
      { id: "f-a", project_id: "proj-a", name: "Same", last_edit_at: 300 },
      { id: "f-b", project_id: "proj-a", name: "Same", last_edit_at: 300 },
      { id: "f-c", project_id: "proj-a", name: "Alpha", last_edit_at: 300 },
      { id: "f-d", project_id: "proj-a", name: "Older", last_edit_at: 100 },
      // NULL tail (never-edited files) sorted by name then id
      { id: "f-n2", project_id: "proj-a", name: "Zed", last_edit_at: null },
      { id: "f-n1", project_id: "proj-a", name: "Zed", last_edit_at: null },
      { id: "f-n0", project_id: "proj-a", name: "Beta", last_edit_at: null },
      { id: "f-trash", project_id: "proj-a", name: "Gone", last_edit_at: 999, deleted_at: 1 },
      { id: "f-other", project_id: "proj-b", name: "Other", last_edit_at: 999 },
    ]
    const { db } = await makeTestDb({ files })
    const unpaged = (await (await get(db, "/api/v1/projects/proj-a/files")).json()) as Page
    expect(unpaged.nextCursor).toBeNull()
    expect(unpaged.files.map((f) => f.fileId)).toEqual(["f-c", "f-a", "f-b", "f-d", "f-n0", "f-n1", "f-n2"])

    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const res = await get(db, `/api/v1/projects/proj-a/files?limit=2${cursor ? `&cursor=${cursor}` : ""}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Page
      expect(body.files.length).toBeLessThanOrEqual(2)
      seen.push(...body.files.map((f) => f.fileId))
      cursor = body.nextCursor
      pages++
    } while (cursor)
    expect(pages).toBe(4)
    expect(seen).toEqual(unpaged.files.map((f) => f.fileId))
  })

  it("pages the trash listing independently of the active one", async () => {
    const { db } = await makeTestDb({
      files: [
        { id: "t1", project_id: "proj-a", name: "T1", deleted_at: 1, last_edit_at: 2 },
        { id: "t2", project_id: "proj-a", name: "T2", deleted_at: 1, last_edit_at: 1 },
        { id: "live", project_id: "proj-a", name: "Live", last_edit_at: 3 },
      ],
    })
    const p1 = (await (await get(db, "/api/v1/projects/proj-a/files?trash=1&limit=1")).json()) as Page
    expect(p1.files.map((f) => f.fileId)).toEqual(["t1"])
    const p2 = (await (await get(db, `/api/v1/projects/proj-a/files?trash=1&limit=1&cursor=${p1.nextCursor}`)).json()) as Page
    expect(p2.files.map((f) => f.fileId)).toEqual(["t2"])
    expect(p2.nextCursor).toBeNull()
  })

  it("rejects a bad limit or cursor with 400", async () => {
    const { db } = await makeTestDb({ files: [] })
    expect((await get(db, "/api/v1/projects/proj-a/files?limit=0")).status).toBe(400)
    expect((await get(db, "/api/v1/projects/proj-a/files?limit=abc")).status).toBe(400)
    expect((await get(db, "/api/v1/projects/proj-a/files?limit=5&cursor=nope")).status).toBe(400)
  })

  it("cursor round-trips including the null last_edit_at form", () => {
    for (const c of [{ lastEditAt: 17e11, name: "Ge/n+esis", id: "f1" }, { lastEditAt: null, name: "", id: "f2" }]) {
      expect(decodeFilesCursor(encodeFilesCursor(c))).toEqual(c)
    }
  })
})

describe("GET /files — approved count after the rewrite", () => {
  it("counts histogram mass at or above validationCount, per file, in one listing", async () => {
    const { db } = await makeTestDb({
      files: [
        { id: "f1", project_id: "proj-a", name: "One", approved_count: 99, last_edit_at: 2 },
        { id: "f2", project_id: "proj-a", name: "Two", approved_count: 99, last_edit_at: 1 },
        // No progress row → legacy files.approved_count fallback.
        { id: "f3", project_id: "proj-a", name: "Three", approved_count: 7, last_edit_at: 0 },
      ],
      project_settings: [{ project_id: "proj-a", settings: JSON.stringify({ validationCount: 2 }), version: 1 }],
      file_section_progress: [
        { project_id: "proj-a", file_id: "f1", scope: "file", section_key: "", total_count: 10, filled_count: 9,
          validator_histogram: JSON.stringify({ 1: 4, 2: 3, 3: 2 }), revision: 1, updated_at: 1 },
        { project_id: "proj-a", file_id: "f2", scope: "file", section_key: "", total_count: 10, filled_count: 9,
          validator_histogram: JSON.stringify({ 1: 5 }), revision: 1, updated_at: 1 },
      ],
    })
    const body = (await (await get(db, "/api/v1/projects/proj-a/files")).json()) as Page
    expect(body.files.map((f) => [f.fileId, f.approvedCount])).toEqual([["f1", 5], ["f2", 0], ["f3", 7]])
  })

  it("treats a missing project_settings row as threshold 1", async () => {
    const { db } = await makeTestDb({
      files: [{ id: "f1", project_id: "proj-a", name: "One", approved_count: 0 }],
      file_section_progress: [
        { project_id: "proj-a", file_id: "f1", scope: "file", section_key: "", total_count: 3, filled_count: 3,
          validator_histogram: JSON.stringify({ 1: 2, 4: 1 }), revision: 1, updated_at: 1 },
      ],
    })
    const body = (await (await get(db, "/api/v1/projects/proj-a/files")).json()) as Page
    expect(body.files[0].approvedCount).toBe(3)
  })
})
