import { describe, it, expect } from "vitest"
import { handleFilesReadRequest } from "../events/files-read-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "files-read-secret"

function envWith(db: D1Database) {
  return { AQUILLA_DB: db, SYNC_SECRET_KEY: SECRET }
}

describe("GET /api/v1/projects/:projectId/files", () => {
  it("returns populated file rollup rows for a member", async () => {
    const { db } = await makeTestDb({
      files: [
        {
          id: "file-gen",
          project_id: "proj-a",
          name: "Genesis",
          file_type: "codex",
          source_language: "en",
          target_language: "es",
          cell_count: 1533,
          approved_count: 100,
          word_count: 38400,
          last_edit_at: 1700000000000,
        },
        {
          id: "file-exo",
          project_id: "proj-a",
          name: "Exodus",
          file_type: "codex",
          source_language: "en",
          target_language: "es",
          cell_count: 1213,
          approved_count: 50,
          word_count: 31000,
          last_edit_at: 1700000010000,
        },
        // A file from a different project — must not appear in the response.
        {
          id: "file-other",
          project_id: "proj-b",
          name: "Other",
          file_type: "codex",
          cell_count: 1,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/files", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleFilesReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      files: Array<{ fileId: string; name: string; cellCount: number; lastEditAt: number | null }>
    }
    expect(body.files).toHaveLength(2)
    // Ordered by last_edit_at DESC.
    expect(body.files[0].fileId).toBe("file-exo")
    expect(body.files[1].fileId).toBe("file-gen")
    expect(body.files[0].cellCount).toBe(1213)
  })

  it("returns 401 without an Authorization header", async () => {
    const { db } = await makeTestDb({ files: [] })
    const req = new Request("https://w/api/v1/projects/proj-a/files")
    const res = (await handleFilesReadRequest(req, envWith(db)))!
    expect(res.status).toBe(401)
  })

  it("returns 403 when the token's projectId does not match the path", async () => {
    const { db } = await makeTestDb({ files: [] })
    const token = await makeTestToken(SECRET, { projectId: "different-proj", fileId: "any" })
    const req = new Request("https://w/api/v1/projects/proj-a/files", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleFilesReadRequest(req, envWith(db)))!
    expect(res.status).toBe(403)
  })

  it("returns the single file for the by-id variant", async () => {
    const { db } = await makeTestDb({
      files: [
        {
          id: "file-x",
          project_id: "proj-a",
          name: "Genesis",
          file_type: "codex",
          source_language: "en",
          target_language: "es",
          cell_count: 5,
          approved_count: 2,
          word_count: 50,
          last_edit_at: 1700,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-x" })
    const req = new Request("https://w/api/v1/projects/proj-a/files/file-x", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleFilesReadRequest(req, envWith(db)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { file: { fileId: string; name: string } }
    expect(body.file.fileId).toBe("file-x")
    expect(body.file.name).toBe("Genesis")
  })

  it("returns 404 for an unknown file id", async () => {
    const { db } = await makeTestDb({ files: [] })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "missing" })
    const req = new Request("https://w/api/v1/projects/proj-a/files/missing", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleFilesReadRequest(req, envWith(db)))!
    expect(res.status).toBe(404)
  })
})
