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

  it("sets hasOriginalSource from file_source_blobs (AQU-656)", async () => {
    const { db } = await makeTestDb({
      files: [
        { id: "with-blob", project_id: "proj-a", name: "GEN.usfm", event_id: "e1" },
        { id: "no-blob", project_id: "proj-a", name: "EXO.usfm", event_id: "e2" },
      ],
      file_source_blobs: [
        { file_id: "with-blob", project_id: "proj-a", format: "usfm", raw_source: "\\id GEN\n" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const res = (await handleFilesReadRequest(new Request(
      "https://w/api/v1/projects/proj-a/files",
      { headers: { Authorization: `Bearer ${token}` } },
    ), envWith(db)))!
    const body = (await res.json()) as {
      files: Array<{ fileId: string; hasOriginalSource: boolean }>
    }
    const byId = Object.fromEntries(body.files.map((f) => [f.fileId, f.hasOriginalSource]))
    expect(byId["with-blob"]).toBe(true)
    expect(byId["no-blob"]).toBe(false)
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

  // AQU-1626. The sidebar has always filtered these out by role client-side, so
  // this API was the one surface that handed them to a caller — and an agent
  // reading it had no such filter, so a 500-cue caption track read back as 500
  // files' worth of untranslated work. The by-id fetch above is deliberately
  // NOT filtered: the audio workflow follows `anchor_file_id` straight to its
  // cue sheet, and both halves of that pair have to stay reachable.
  it("leaves hidden companion files out of the listing while by-id still returns them", async () => {
    const { db } = await makeTestDb({
      files: [
        { id: "f-text", project_id: "proj-a", name: "ep-101", kind: "vtt", cell_count: 12 },
        {
          id: "f-cues", project_id: "proj-a", name: "ep-101 · audio cues",
          role: "audio-cues", kind: "vtt", anchor_file_id: "f-text", cell_count: 500,
        },
        {
          id: "f-track", project_id: "proj-a", name: "ep-101 · captions",
          role: "timeline-content", kind: "vtt", anchor_file_id: "f-text", cell_count: 500,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const auth = { headers: { Authorization: `Bearer ${token}` } }
    const list = (await handleFilesReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files", auth), envWith(db),
    ))!
    const listed = (await list.json()) as { files: Array<{ fileId: string }> }
    expect(listed.files.map((f) => f.fileId)).toEqual(["f-text"])

    const byId = (await handleFilesReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files/f-cues", auth), envWith(db),
    ))!
    expect(byId.status).toBe(200)
    expect((await byId.json() as { file: { fileId: string } }).file.fileId).toBe("f-cues")
  })

  // Deleting the parent of a hidden companion tombstones the companion too, so
  // without the same rule Recently deleted grew a "· audio cues" row for a
  // person to puzzle over — and offered to restore machinery on its own.
  it("leaves hidden companion files out of the trash listing too", async () => {
    const { db } = await makeTestDb({
      files: [
        { id: "f-text", project_id: "proj-a", name: "ep-101", kind: "vtt", deleted_at: 1700000000000 },
        {
          id: "f-cues", project_id: "proj-a", name: "ep-101 · audio cues",
          role: "audio-cues", kind: "vtt", anchor_file_id: "f-text", deleted_at: 1700000000000,
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const res = (await handleFilesReadRequest(new Request(
      "https://w/api/v1/projects/proj-a/files?trash=1",
      { headers: { Authorization: `Bearer ${token}` } },
    ), envWith(db)))!
    const body = (await res.json()) as { files: Array<{ fileId: string }> }
    expect(body.files.map((f) => f.fileId)).toEqual(["f-text"])
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

// ── The timing correction, forwarded (AQU-646, 2026-08-19) ───────────────
//
// An audio VTT arrives at a different frame rate from the subtitles it belongs
// to, and the import measures the drift and stretches the cues to match. That
// measurement happens once and was, until now, written into the file's meta and
// never read again. The project report signs an episode's timing off with it,
// so the read route has to forward it — recomputing is not an option, and a
// second opinion that disagreed with the correction actually applied would be
// worse than silence.

describe("the audio-cue timebase a file was imported with", () => {
  const metaWith = (timebase: unknown) =>
    JSON.stringify({ orderedBy: "time", aquillaImport: { audioVtt: { timebase } } })

  async function readFiles(meta: string | null) {
    const { db } = await makeTestDb({
      files: [
        {
          id: "file-cues",
          project_id: "proj-a",
          name: "Episode · audio cues",
          file_type: "vtt",
          cell_count: 548,
          ...(meta === null ? {} : { meta }),
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "any" })
    const res = (await handleFilesReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    const body = (await res.json()) as {
      files: Array<{ audioVttTimebase: { fromFps?: string; toFps?: string; scale: number } | null }>
    }
    return body.files[0]!.audioVttTimebase
  }

  it("comes back with both rates when the import could name them", async () => {
    expect(await readFiles(metaWith({ fromFps: "24", toFps: "23.976", scale: 1.001 }))).toEqual({
      fromFps: "24",
      toFps: "23.976",
      scale: 1.001,
    })
  })

  it("comes back with the scale alone when it could not", async () => {
    // A drift measured from the words is exact even when neither frame rate is
    // knowable — 24-against-23.976 and 30-against-29.97 are the same ratio — so
    // the labels are optional and the scale never is.
    expect(await readFiles(metaWith({ scale: 1.001 }))).toEqual({ scale: 1.001 })
  })

  it("is null for a file that was never measured", async () => {
    expect(await readFiles(JSON.stringify({ orderedBy: "time" }))).toBeNull()
    expect(await readFiles(null)).toBeNull()
  })

  it("is null rather than a lie when the stored record is malformed", async () => {
    expect(await readFiles(metaWith({ fromFps: "24" }))).toBeNull()
    expect(await readFiles(metaWith("nonsense"))).toBeNull()
    expect(await readFiles(metaWith({ scale: "1.001" }))).toBeNull()
  })
})

describe("GET /files with the lane read wall", () => {
  it("replaces the default-lane counters when that lane was not granted", async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: "deflane1", project_id: "proj-a", role: "target", name: "Spanish", legacy_tag: "" },
        { id: "eslane01", project_id: "proj-a", role: "target", name: "Spanish Team", legacy_tag: "es" },
      ],
      files: [{
        id: "file-gen", project_id: "proj-a", name: "Genesis",
        cell_count: 80, filled_count: 20, approved_count: 9,
      }],
      file_section_progress: [
        {
          project_id: "proj-a", file_id: "file-gen", scope: "file", section_key: "",
          target_lang: "", total_count: 70, filled_count: 20, validator_histogram: { "1": 9 },
          revision: 1, updated_at: 1,
        },
        {
          project_id: "proj-a", file_id: "file-gen", scope: "file", section_key: "",
          target_lang: "es", total_count: 10, filled_count: 3, validator_histogram: { "1": 2 },
          revision: 1, updated_at: 1,
        },
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "proj-a",
      fileId: "file-gen",
      role: 400,
      laneGrants: [{ lane: "eslane01", level: 400 }],
    })
    const req = new Request("https://w/api/v1/projects/proj-a/files", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleFilesReadRequest(req, {
      AQUILLA_PG: db,
      SYNC_SECRET_KEY: SECRET,
      LANE_READ_WALL: "1",
    }))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { files: Array<{ cellCount: number; filledCount: number; approvedCount: number }> }
    expect(body.files[0]).toMatchObject({ cellCount: 10, filledCount: 3, approvedCount: 2 })
  })

  it("takes the shared denominator once when several non-default lanes are granted", async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: "deflane1", project_id: "proj-a", role: "target", name: "Spanish", legacy_tag: "" },
        { id: "eslane01", project_id: "proj-a", role: "target", name: "Spanish Team", legacy_tag: "es" },
        { id: "frlane01", project_id: "proj-a", role: "target", name: "French Team", legacy_tag: "fr" },
      ],
      project_settings: [{
        project_id: "proj-a",
        settings: JSON.stringify({ countStructuralCells: false }),
        version: 1,
      }],
      files: [{
        id: "file-gen", project_id: "proj-a", name: "Genesis",
        cell_count: 80, filled_count: 20, approved_count: 9,
      }],
      file_section_progress: [
        {
          project_id: "proj-a", file_id: "file-gen", scope: "file", section_key: "",
          target_lang: "", total_count: 40, structural_count: 4,
          filled_count: 20, structural_filled_count: 2,
          validator_histogram: { "1": 9 }, structural_validator_histogram: { "1": 2 },
          revision: 1, updated_at: 1,
        },
        {
          project_id: "proj-a", file_id: "file-gen", scope: "file", section_key: "",
          target_lang: "es", lane_id: "eslane01",
          total_count: 40, structural_count: 4,
          filled_count: 3, structural_filled_count: 1,
          validator_histogram: { "1": 2 }, structural_validator_histogram: { "1": 1 },
          revision: 1, updated_at: 1,
        },
        {
          project_id: "proj-a", file_id: "file-gen", scope: "file", section_key: "",
          target_lang: "fr", lane_id: "frlane01",
          total_count: 40, structural_count: 4,
          filled_count: 5, structural_filled_count: 0,
          validator_histogram: { "1": 1 }, structural_validator_histogram: {},
          revision: 1, updated_at: 1,
        },
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "proj-a",
      fileId: "file-gen",
      role: 400,
      laneGrants: [
        { lane: "eslane01", level: 400 },
        { lane: "frlane01", level: 400 },
      ],
    })
    const res = (await handleFilesReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, LANE_READ_WALL: "1" },
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      files: Array<{ cellCount: number; filledCount: number; approvedCount: number }>
    }
    // 40 − 4 once, not twice. Filled and approved are the two lanes' own work.
    expect(body.files[0]).toMatchObject({ cellCount: 36, filledCount: 7, approvedCount: 2 })
  })

  it("does not borrow another lane's fill when the default lane has no progress row", async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: "deflane1", project_id: "proj-a", role: "target", name: "Spanish", legacy_tag: "" },
        { id: "frlane01", project_id: "proj-a", role: "target", name: "French", legacy_tag: "fr" },
      ],
      project_settings: [{
        project_id: "proj-a",
        settings: JSON.stringify({ countStructuralCells: false }),
        version: 1,
      }],
      files: [{
        id: "file-gen", project_id: "proj-a", name: "Genesis",
        cell_count: 10, structural_cell_count: 2,
        filled_count: 8, structural_filled_count: 4,
        approved_count: 3, structural_approved_count: 1,
      }],
      file_section_progress: [{
        project_id: "proj-a", file_id: "file-gen", scope: "file", section_key: "",
        target_lang: "fr", lane_id: "frlane01",
        total_count: 10, structural_count: 2,
        filled_count: 8, structural_filled_count: 1,
        validator_histogram: { "1": 3 },
        structural_validator_histogram: { "1": 1 },
        revision: 1, updated_at: 1,
      }],
    })
    const token = await makeTestToken(SECRET, { projectId: "proj-a", fileId: "file-gen" })
    const res = (await handleFilesReadRequest(
      new Request("https://w/api/v1/projects/proj-a/files/file-gen", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      envWith(db),
    ))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      file: { cellCount: number; filledCount: number; approvedCount: number }
    }
    expect(body.file).toMatchObject({ cellCount: 8, filledCount: 0, approvedCount: 0 })
  })

  it("uses the files counters for one target lane and not when a second lane is archived", async () => {
    const file = {
      name: "Genesis",
      cell_count: 10, structural_cell_count: 2,
      filled_count: 8, structural_filled_count: 4,
      approved_count: 3, structural_approved_count: 1,
    }
    const { db } = await makeTestDb({
      lanes: [
        { id: "srconly1", project_id: "proj-one", role: "source", name: "Source" },
        { id: "onlylane", project_id: "proj-one", role: "target", name: "Spanish", legacy_tag: "" },
        { id: "live0001", project_id: "proj-two", role: "target", name: "Spanish", legacy_tag: "" },
        {
          id: "arch0001", project_id: "proj-two", role: "target", name: "French", legacy_tag: "fr",
          archived_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      project_settings: [
        { project_id: "proj-one", settings: JSON.stringify({ countStructuralCells: false }), version: 1 },
        { project_id: "proj-two", settings: JSON.stringify({ countStructuralCells: false }), version: 1 },
      ],
      files: [
        { id: "file-one", project_id: "proj-one", ...file },
        { id: "file-two", project_id: "proj-two", ...file },
      ],
    })
    const read = async (projectId: string, fileId: string) => {
      const token = await makeTestToken(SECRET, { projectId, fileId })
      const res = (await handleFilesReadRequest(
        new Request(`https://w/api/v1/projects/${projectId}/files/${fileId}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        envWith(db),
      ))!
      expect(res.status).toBe(200)
      return (await res.json()) as { file: { cellCount: number; filledCount: number; approvedCount: number } }
    }
    // 8 − 4 filled, 3 − 1 approved. A source lane does not count.
    expect((await read("proj-one", "file-one")).file).toMatchObject({
      cellCount: 8, filledCount: 4, approvedCount: 2,
    })
    expect((await read("proj-two", "file-two")).file).toMatchObject({
      cellCount: 8, filledCount: 0, approvedCount: 0,
    })
  })

  it("sorts and reports lastEditAt from the granted lanes", async () => {
    const { db } = await makeTestDb({
      lanes: [
        { id: "deflane1", project_id: "proj-a", role: "target", name: "Spanish", legacy_tag: "" },
        { id: "eslane01", project_id: "proj-a", role: "target", name: "Spanish Team", legacy_tag: "es" },
      ],
      files: [
        {
          id: "file-gen", project_id: "proj-a", name: "Genesis",
          last_edit_at: 9000,
        },
        {
          id: "file-exo", project_id: "proj-a", name: "Exodus",
          last_edit_at: 2000,
        },
      ],
      file_section_progress: [
        {
          project_id: "proj-a", file_id: "file-gen", scope: "file", section_key: "",
          target_lang: "", last_edit_at: 1000, revision: 1, updated_at: 1,
        },
        {
          project_id: "proj-a", file_id: "file-gen", scope: "file", section_key: "",
          target_lang: "es", last_edit_at: 9000, revision: 1, updated_at: 1,
        },
        {
          project_id: "proj-a", file_id: "file-exo", scope: "file", section_key: "",
          target_lang: "", last_edit_at: 5000, revision: 1, updated_at: 1,
        },
        {
          project_id: "proj-a", file_id: "file-exo", scope: "file", section_key: "",
          target_lang: "es", last_edit_at: 1500, revision: 1, updated_at: 1,
        },
      ],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "proj-a",
      fileId: "file-gen",
      role: 400,
      laneGrants: [{ lane: "deflane1", level: 400 }],
    })
    const req = new Request("https://w/api/v1/projects/proj-a/files?limit=1", {
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = (await handleFilesReadRequest(req, {
      AQUILLA_PG: db,
      SYNC_SECRET_KEY: SECRET,
      LANE_READ_WALL: "1",
    }))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      files: Array<{ fileId: string; lastEditAt: number | null }>
      nextCursor: string | null
    }
    // Default-lane clocks are Exodus 5000, Genesis 1000. The file clocks
    // (9000, 2000) would have put Genesis first.
    expect(body.files).toHaveLength(1)
    expect(body.files[0]).toMatchObject({ fileId: "file-exo", lastEditAt: 5000 })
    expect(body.nextCursor).toBeTruthy()

    const page2 = (await handleFilesReadRequest(
      new Request(`https://w/api/v1/projects/proj-a/files?limit=1&cursor=${body.nextCursor}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, LANE_READ_WALL: "1" },
    ))!
    const rest = (await page2.json()) as {
      files: Array<{ fileId: string; lastEditAt: number | null }>
      nextCursor: string | null
    }
    expect(rest.files).toHaveLength(1)
    expect(rest.files[0]).toMatchObject({ fileId: "file-gen", lastEditAt: 1000 })
    expect(rest.nextCursor).toBeNull()
  })
})

