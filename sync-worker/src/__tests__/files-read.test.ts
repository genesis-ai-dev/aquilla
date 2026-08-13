import { describe, it, expect } from "vitest"
import { handleFilesReadRequest } from "../events/files-read-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "files-read-secret"

function envWith(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET }
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

  it("prefers a projected zero over stale legacy counters", async () => {
    const { db } = await makeTestDb({
      files: [{
        id: "file-zero", project_id: "proj-a", name: "Genesis",
        cell_count: 10, filled_count: 8, approved_count: 6,
      }],
      project_settings: [{
        project_id: "proj-a", settings: JSON.stringify({ validationCount: 2 }), version: 1,
      }],
      file_section_progress: [{
        project_id: "proj-a", file_id: "file-zero", scope: "file", section_key: "",
        total_count: 3, filled_count: 0, validator_histogram: {}, revision: 1, updated_at: 1,
      }],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-zero" })
    const response = (await handleFilesReadRequest(new Request(
      "https://w/api/v1/projects/proj-a/files/file-zero",
      { headers: { Authorization: `Bearer ${token}` } },
    ), envWith(db)))!
    const body = await response.json() as {
      file: { cellCount: number; filledCount: number; approvedCount: number }
    }

    expect(body.file).toMatchObject({ cellCount: 3, filledCount: 0, approvedCount: 0 })
  })

  it("caps legacy validationCount values at the 15+ histogram bucket", async () => {
    const { db } = await makeTestDb({
      files: [{ id: "file-cap", project_id: "proj-a", name: "Genesis", approved_count: 0 }],
      project_settings: [{
        project_id: "proj-a", settings: JSON.stringify({ validationCount: 99 }), version: 1,
      }],
      file_section_progress: [{
        project_id: "proj-a", file_id: "file-cap", scope: "file", section_key: "",
        total_count: 1, filled_count: 1, validator_histogram: JSON.stringify({ 15: 1 }), revision: 1, updated_at: 1,
      }],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-cap" })
    const response = (await handleFilesReadRequest(new Request(
      "https://w/api/v1/projects/proj-a/files/file-cap",
      { headers: { Authorization: `Bearer ${token}` } },
    ), envWith(db)))!
    const body = await response.json() as { file: { approvedCount: number } }

    expect(body.file.approvedCount).toBe(1)
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

  it("maps meta.trackOverrides through untouched, unknown kinds included", async () => {
    // The route forwards the stored deltas verbatim — the client's
    // mergeTrackOverrides is the only validator. A kind this build cannot draw
    // still has to reach a newer client that can.
    const { db } = await makeTestDb({
      files: [{
        id: "file-tracks", project_id: "proj-a", name: "ep-101",
        meta: JSON.stringify({
          trackOverrides: {
            subtitles: { name: "Script" },
            "trk-x9": { kind: "character-audio", order: 7 },
          },
        }),
      }],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-tracks" })
    const res = (await handleFilesReadRequest(new Request(
      "https://w/api/v1/projects/proj-a/files/file-tracks",
      { headers: { Authorization: `Bearer ${token}` } },
    ), envWith(db)))!
    const body = await res.json() as { file: { trackOverrides: unknown } }

    expect(body.file.trackOverrides).toEqual({
      subtitles: { name: "Script" },
      "trk-x9": { kind: "character-audio", order: 7 },
    })
  })

  it("reports null trackOverrides for a file that has never had one set", async () => {
    const { db } = await makeTestDb({
      files: [{
        id: "file-plain", project_id: "proj-a", name: "ep-102",
        meta: JSON.stringify({ timingMode: "dubbing" }),
      }],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-plain" })
    const res = (await handleFilesReadRequest(new Request(
      "https://w/api/v1/projects/proj-a/files/file-plain",
      { headers: { Authorization: `Bearer ${token}` } },
    ), envWith(db)))!
    const body = await res.json() as { file: { trackOverrides: unknown } }

    expect(body.file.trackOverrides).toBeNull()
  })

  it("nulls a trackOverrides that is not a plain object", async () => {
    // An array is `typeof 'object'` and would hydrate client-side as a map with
    // numeric keys; an empty map means exactly what an absent key means. Both
    // collapse so the client has one "no overrides" case, not three.
    const { db } = await makeTestDb({
      files: [
        { id: "f-arr", project_id: "proj-a", name: "arr", meta: JSON.stringify({ trackOverrides: [{ name: "x" }] }) },
        { id: "f-str", project_id: "proj-a", name: "str", meta: JSON.stringify({ trackOverrides: "subtitles" }) },
        { id: "f-empty", project_id: "proj-a", name: "empty", meta: JSON.stringify({ trackOverrides: {} }) },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const res = (await handleFilesReadRequest(new Request(
      "https://w/api/v1/projects/proj-a/files",
      { headers: { Authorization: `Bearer ${token}` } },
    ), envWith(db)))!
    const body = await res.json() as { files: Array<{ fileId: string; trackOverrides: unknown }> }

    expect(body.files).toHaveLength(3)
    for (const file of body.files) expect(file.trackOverrides).toBeNull()
  })

  it("reports role/kind/anchorFileId so the client can spot a hidden sibling", async () => {
    // `fileType` is kind ?? role, which reads "vtt" for both rows below — the
    // audio-cue sibling is only distinguishable through the unfolded columns.
    const { db } = await makeTestDb({
      files: [
        { id: "f-text", project_id: "proj-a", name: "ep-101", role: "source", kind: "vtt" },
        {
          id: "f-cues", project_id: "proj-a", name: "ep-101 · audio cues",
          role: "audio-cues", kind: "vtt", anchor_file_id: "f-text",
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "f-cues" })
    const res = (await handleFilesReadRequest(new Request(
      "https://w/api/v1/projects/proj-a/files/f-cues",
      { headers: { Authorization: `Bearer ${token}` } },
    ), envWith(db)))!
    const body = await res.json() as {
      file: { fileType: string; role: string | null; anchorFileId: string | null }
    }

    expect(body.file).toMatchObject({ fileType: "vtt", role: "audio-cues", anchorFileId: "f-text" })
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
