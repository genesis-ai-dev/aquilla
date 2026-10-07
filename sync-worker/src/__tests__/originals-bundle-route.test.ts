import { describe, it, expect } from "vitest"
import { handleOriginalsBundleRequest } from "../events/originals-bundle-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "originals-bundle-secret"

function emptyBucket(): R2Bucket {
  return { get: async () => null } as unknown as R2Bucket
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
})
