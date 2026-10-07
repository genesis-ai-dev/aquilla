import { describe, it, expect } from "vitest"
import { handleOriginalDownloadRequest } from "../events/original-download-route"
import { handleExportSourceRequest } from "../events/export-route"
import { sourceObjectKey } from "../events/source-upload-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "original-download-secret"

function makeStubBucket() {
  const store = new Map<string, ArrayBuffer>()
  return {
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj }
    },
    _seed(key: string, bytes: Uint8Array) {
      store.set(
        key,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )
    },
  }
}

describe("GET /files/:fileId/original (AQU-656)", () => {
  it("403s a contributor under the default export floor", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "P", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "GEN.usfm", event_id: "e1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "usfm", raw_source: "\\id GEN\n" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 400 })
    const res = await handleOriginalDownloadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/original",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: makeStubBucket() as unknown as R2Bucket })
    expect(res?.status).toBe(403)
  })

  it("returns exact imported USFM bytes, not the translation-injected export", async () => {
    const original = "\\id GEN\n\\c 1\n\\v 1 In the beginning.\n"
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "P", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "GEN.usfm", event_id: "e1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "usfm", raw_source: original },
      ],
      cells: [
        {
          project_id: "p1", file_id: "f1", cell_id: "c1", side: "source",
          target_lang: "", value: "In the beginning.", canonical_ref: "GEN 1:1",
        },
        {
          project_id: "p1", file_id: "f1", cell_id: "c1", side: "target",
          target_lang: "", value: "Al principio.", canonical_ref: "GEN 1:1",
        },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const env = { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: makeStubBucket() as unknown as R2Bucket }
    const originalRes = await handleOriginalDownloadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/original",
      { headers: { Authorization: `Bearer ${token}` } },
    ), env)
    const exportRes = await handleExportSourceRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      { headers: { Authorization: `Bearer ${token}` } },
    ), env)

    expect(originalRes?.status).toBe(200)
    expect(originalRes?.headers.get("X-Export-Mode")).toBe("raw-original")
    expect(await originalRes!.text()).toBe(original)
    expect(exportRes?.status).toBe(200)
    expect(await exportRes!.text()).toContain("Al principio.")
  })

  it("serves R2 bytes and 404s when the object is missing", async () => {
    const SNAPSHOTS = makeStubBucket()
    const key = sourceObjectKey({ R2_KEY_PREFIX: "" }, "p1", "f1", "docx")
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    SNAPSHOTS._seed(key, bytes)
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "P", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "Matthew", event_id: "e1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "docx", raw_source: null, r2_key: key },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const env = { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: SNAPSHOTS as unknown as R2Bucket }

    const hit = await handleOriginalDownloadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/original",
      { headers: { Authorization: `Bearer ${token}` } },
    ), env)
    expect(hit?.status).toBe(200)
    expect(hit?.headers.get("Content-Disposition")).toContain("Matthew.docx")
    expect(hit?.headers.get("Content-Type")).toBe("application/octet-stream")
    expect(hit?.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(new Uint8Array(await hit!.arrayBuffer())).toEqual(bytes)

    const miss = await handleOriginalDownloadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/original",
      { headers: { Authorization: `Bearer ${token}` } },
    ), {
      ...env,
      SNAPSHOTS: makeStubBucket() as unknown as R2Bucket,
    })
    expect(miss?.status).toBe(404)
  })

  it("does not use the file id as the download name when files.name is missing", async () => {
    const fileId = "01a045cf-1131-7158-8150-03ae69b8c1c0"
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "P", created_by: 1 }],
      files: [{ id: fileId, project_id: "p1", name: fileId, event_id: "e1" }],
      file_source_blobs: [
        { file_id: fileId, project_id: "p1", format: "json", raw_source: "{}" },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId, role: 600 })
    const res = await handleOriginalDownloadRequest(new Request(
      `https://x/api/v1/projects/p1/files/${fileId}/original`,
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS: makeStubBucket() as unknown as R2Bucket })
    expect(res?.status).toBe(200)
    const disposition = res?.headers.get("Content-Disposition") ?? ""
    expect(disposition).toContain("original.json")
    expect(disposition).not.toContain(fileId)
  })
})
