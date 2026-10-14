import { describe, it, expect } from "vitest"
import { handleOriginalsBundleRequest } from "../events/originals-bundle-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"
import { readZip } from "./helpers/read-zip"

const SECRET = "originals-bundle-secret"

function emptyBucket(): R2Bucket {
  return { get: async () => null, head: async () => null } as unknown as R2Bucket
}

/**
 * AQU-1863: a bucket that serves each key's bytes as a stream and counts the
 * calls, so a test can prove the route settles existence with `head()` and
 * pulls bytes only while the response body is read.
 */
function streamingBucket(objects: Record<string, Uint8Array>) {
  const calls = { head: [] as string[], get: [] as string[] }
  const bucket = {
    head: async (key: string) => {
      calls.head.push(key)
      const bytes = objects[key]
      return bytes ? ({ key, size: bytes.length } as unknown as R2Object) : null
    },
    get: async (key: string) => {
      calls.get.push(key)
      const bytes = objects[key]
      if (!bytes) return null
      return {
        key,
        size: bytes.length,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            // Two chunks, so a single-chunk assumption would show up.
            controller.enqueue(bytes.slice(0, Math.ceil(bytes.length / 2)))
            controller.enqueue(bytes.slice(Math.ceil(bytes.length / 2)))
            controller.close()
          },
        }),
      } as unknown as R2ObjectBody
    },
  } as unknown as R2Bucket
  return { bucket, calls }
}

describe("GET /export/originals (AQU-656)", () => {
  it("403s a contributor under the default export floor", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "GEN.usfm", event_id: "e1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "usfm", raw_source: "\\id GEN\n" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 400 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(403)
  })

  it("404s when the project has no original blobs", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "GEN.usfm", event_id: "e1" }],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(404)
  })

  it("zips every original and names the archive {project}-originals.zip", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [
        { id: "f1", project_id: "p1", name: "GEN.usfm", event_id: "e1" },
        { id: "f2", project_id: "p1", name: "EXO.usfm", event_id: "e2" },
      ],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "usfm", raw_source: "\\id GEN\n" },
        { file_id: "f2", project_id: "p1", format: "usfm", raw_source: "\\id EXO\n" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(200)
    expect(res?.headers.get("Content-Type")).toBe("application/zip")
    expect(res?.headers.get("Content-Disposition")).toContain("My-Project-originals.zip")
    const buf = new Uint8Array(await res!.arrayBuffer())
    expect(Array.from(buf.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
    const txt = new TextDecoder().decode(buf)
    expect(txt).toContain("GEN.usfm")
    expect(txt).toContain("EXO.usfm")
  })

  it("skips files whose R2 object is missing and still packs the rest", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [
        { id: "f1", project_id: "p1", name: "Matthew.docx", event_id: "e1" },
        { id: "f2", project_id: "p1", name: "GEN.usfm", event_id: "e2" },
      ],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "docx", raw_source: null, r2_key: "missing/key" },
        { file_id: "f2", project_id: "p1", format: "usfm", raw_source: "\\id GEN\n" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f2", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(200)
    const txt = new TextDecoder().decode(await res!.arrayBuffer())
    expect(txt).toContain("GEN.usfm")
    expect(txt).not.toContain("Matthew.docx")
  })

  it("AQU-1566: leaves a caption track's and a cue sheet's original out", async () => {
    // Attaching captions to a linked video keeps the caption file as the
    // track content's original. The track is not a file of the project.
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [
        { id: "f1", project_id: "p1", name: "Episode.vtt", event_id: "e1" },
        { id: "f-track", project_id: "p1", name: "Track-captions.vtt", event_id: "e2", role: "timeline-content", anchor_file_id: "f1" },
        { id: "f-cues", project_id: "p1", name: "Audio-cues.vtt", event_id: "e3", role: "audio-cues", anchor_file_id: "f1" },
        { id: "f-gone", project_id: "p1", name: "Deleted.vtt", event_id: "e4", deleted_at: 1 },
      ],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "vtt", raw_source: "WEBVTT\n" },
        { file_id: "f-track", project_id: "p1", format: "vtt", raw_source: "WEBVTT\n" },
        { file_id: "f-cues", project_id: "p1", format: "vtt", raw_source: "WEBVTT\n" },
        { file_id: "f-gone", project_id: "p1", format: "vtt", raw_source: "WEBVTT\n" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(200)
    const txt = new TextDecoder().decode(await res!.arrayBuffer())
    expect(txt).toContain("Episode.vtt")
    expect(txt).not.toContain("Track-captions")
    expect(txt).not.toContain("Audio-cues")
    expect(txt).not.toContain("Deleted")
  })

  it("disambiguates colliding zip entry names as Name (2).ext", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [
        { id: "f1", project_id: "p1", name: "Matthew.docx", event_id: "e1" },
        { id: "f2", project_id: "p1", name: "Matthew.docx", event_id: "e2" },
      ],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "docx", raw_source: "UEsDBA==" },
        { file_id: "f2", project_id: "p1", format: "docx", raw_source: "UEsDBA==" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(200)
    const txt = new TextDecoder().decode(await res!.arrayBuffer())
    expect(txt).toContain("Matthew.docx")
    expect(txt).toContain("Matthew (2).docx")
  })

  it("names zip entries original.ext when files.name is a file id", async () => {
    const a = "01a045cf-1131-7158-8150-03ae69b8c1c0"
    const b = "01a045cf-1131-7158-8150-03ae69b8c1c1"
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [
        { id: a, project_id: "p1", name: a, event_id: "e1" },
        { id: b, project_id: "p1", name: b, event_id: "e2" },
      ],
      file_source_blobs: [
        { file_id: a, project_id: "p1", format: "json", raw_source: "{}" },
        { file_id: b, project_id: "p1", format: "json", raw_source: "{}" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: a, role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(200)
    const txt = new TextDecoder().decode(await res!.arrayBuffer())
    expect(txt).toContain("original.json")
    expect(txt).toContain("original (2).json")
    expect(txt).not.toContain(a)
    expect(txt).not.toContain(b)
  })

  it("AQU-1863: streams originals from R2 — bytes are pulled only as the body is read", async () => {
    const matthew = new TextEncoder().encode("PK\u0003\u0004matthew-docx-bytes".repeat(64))
    const luke = new TextEncoder().encode("PK\u0003\u0004luke-idml-bytes".repeat(64))
    const { bucket, calls } = streamingBucket({ "orig/matthew": matthew, "orig/luke": luke })
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [
        { id: "f1", project_id: "p1", name: "Luke.idml", event_id: "e1" },
        { id: "f2", project_id: "p1", name: "Matthew.docx", event_id: "e2" },
      ],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "idml", raw_source: null, r2_key: "orig/luke" },
        { file_id: "f2", project_id: "p1", format: "docx", raw_source: null, r2_key: "orig/matthew" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: bucket })

    expect(res?.status).toBe(200)
    // Existence came from head() alone, and the response headers are out with
    // at most the first original's body stream open (the stream's queue pulls
    // one chunk eagerly). Nothing beyond it has been fetched, which is what
    // keeps peak memory off the sum of the originals.
    expect(calls.head.sort()).toEqual(["orig/luke", "orig/matthew"])
    expect(calls.get).not.toContain("orig/matthew")

    const entries = readZip(new Uint8Array(await res!.arrayBuffer()))
    expect(entries.map((e) => e.name)).toEqual(["Luke.idml", "Matthew.docx"])
    expect(entries[0].data).toEqual(luke)
    expect(entries[1].data).toEqual(matthew)
    expect(calls.get).toEqual(["orig/luke", "orig/matthew"])
  })

  it("AQU-1863: the archive opens with legacy inline and R2 originals side by side", async () => {
    const idml = new TextEncoder().encode("idml-bytes".repeat(32))
    const { bucket } = streamingBucket({ "orig/luke": idml })
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [
        { id: "f1", project_id: "p1", name: "GEN.usfm", event_id: "e1" },
        { id: "f2", project_id: "p1", name: "Luke.idml", event_id: "e2" },
      ],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "usfm", raw_source: "\\id GEN\n" },
        { file_id: "f2", project_id: "p1", format: "idml", raw_source: null, r2_key: "orig/luke" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: bucket })

    expect(res?.status).toBe(200)
    const entries = readZip(new Uint8Array(await res!.arrayBuffer()))
    expect(entries.map((e) => e.name)).toEqual(["GEN.usfm", "Luke.idml"])
    expect(new TextDecoder().decode(entries[0].data)).toBe("\\id GEN\n")
    expect(entries[1].data).toEqual(idml)
  })

  it("AQU-1863: 404s when every blob row has no bytes at all", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "GEN.usfm", event_id: "e1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "usfm", raw_source: "" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(404)
  })
})

describe("GET /export/originals — nothing packable (AQU-1863)", () => {
  it("404s when the only original is a corrupted legacy side-car", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "Matthew.docx", event_id: "e1" }],
      file_source_blobs: [
        // Not valid base64 — the pre-R2 side-car is unrecoverable.
        { file_id: "f1", project_id: "p1", format: "docx", raw_source: "!!! not base64 !!!" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(404)
    expect(await res!.text()).toContain("re-import")
  })

  it("packs the good originals and drops a corrupted side-car alongside them", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "My Project", created_by: 1 }],
      files: [
        { id: "f1", project_id: "p1", name: "Matthew.docx", event_id: "e1" },
        { id: "f2", project_id: "p1", name: "GEN.usfm", event_id: "e2" },
      ],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "docx", raw_source: "!!! not base64 !!!" },
        { file_id: "f2", project_id: "p1", format: "usfm", raw_source: "\\id GEN\n" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f2", role: 600 })
    const res = await handleOriginalsBundleRequest(new Request(
      "https://x/api/v1/projects/p1/export/originals",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: emptyBucket() })
    expect(res?.status).toBe(200)
    const entries = readZip(new Uint8Array(await res!.arrayBuffer()))
    expect(entries.map((e) => e.name)).toEqual(["GEN.usfm"])
  })
})
