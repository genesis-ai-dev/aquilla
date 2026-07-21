// TDD tests for export-route R2 read branch (Task 3).
//
// Verifies that GET /api/v1/projects/:projectId/files/:fileId/source:
//   (a) serves docx bytes from R2 when r2_key is set in file_source_blobs
//   (b) falls back to legacy base64 raw_source when r2_key is null

import { describe, it, expect } from "vitest"
import { handleExportSourceRequest } from "../events/export-route"
import { sourceObjectKey } from "../events/source-upload-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "export-r2-test-secret"

// Minimal R2 stub with _seed helper (mirrors admin.test.ts + source-upload-route.test.ts)
function makeStubBucket() {
  const store = new Map<string, ArrayBuffer>()
  return {
    async put(key: string, value: ArrayBuffer | Uint8Array | string) {
      const body =
        typeof value === "string"
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, body as ArrayBuffer)
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj }
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]
      for (const k of list) store.delete(k)
    },
    async list({ prefix }: { prefix?: string } = {}) {
      const keys = Array.from(store.keys()).filter((k) => !prefix || k.startsWith(prefix))
      return { objects: keys.map((k) => ({ key: k })), truncated: false }
    },
    _allKeys() {
      return Array.from(store.keys())
    },
    _seed(key: string, bytes: Uint8Array) {
      store.set(
        key,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )
    },
  }
}

describe("GET /source — R2 read branch", () => {
  it("round-trips USFM after reconcile moved the original from inline text to R2", async () => {
    const SNAPSHOTS = makeStubBucket()
    const key = sourceObjectKey({ R2_KEY_PREFIX: "" }, "p1", "f1", "usfm")
    const original = new TextEncoder().encode("\\id GEN\n\\c 1\n\\v 1 In the beginning.\n")
    SNAPSHOTS._seed(key, original)
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "GEN.usfm", event_id: "ev1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "usfm", raw_source: null, r2_key: key },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleExportSourceRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS } as any)

    expect(res?.status).toBe(200)
    expect(await res!.text()).toBe(new TextDecoder().decode(original))
  })

  it("(a) serves docx bytes from R2 when r2_key is present", async () => {
    const SNAPSHOTS = makeStubBucket()

    // We need a minimal env to call sourceObjectKey
    const stubEnvForKey = { R2_KEY_PREFIX: "" }
    const key = sourceObjectKey(stubEnvForKey, "p1", "f1", "docx")

    // Seed bytes into the stub R2 bucket
    const docxMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // PK zip magic
    SNAPSHOTS._seed(key, docxMagic)

    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "doc.docx", event_id: "ev1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "docx", raw_source: null, r2_key: key },
      ],
    })

    // role 600 = MAINTAINER (the default export floor)
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })

    const req = new Request("https://x/api/v1/projects/p1/files/f1/source", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    const env = { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS } as any

    const res = await handleExportSourceRequest(req, env)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("X-Export-Mode")).toBe("raw-sidecar")
    const buf = new Uint8Array(await res!.arrayBuffer())
    expect(Array.from(buf.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04])
  })

  it("(b) falls back to legacy raw_source base64 when r2_key is null", async () => {
    const SNAPSHOTS = makeStubBucket()

    const rawB64 = btoa("PK") // minimal valid base64 for test

    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "doc.docx", event_id: "ev1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "docx", raw_source: rawB64, r2_key: null },
      ],
    })

    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })

    const req = new Request("https://x/api/v1/projects/p1/files/f1/source", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    const env = { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS } as any

    const res = await handleExportSourceRequest(req, env)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("X-Export-Mode")).toBe("raw-sidecar")
  })

  it("serves an exact non-Office original without claiming translated round-trip", async () => {
    const SNAPSHOTS = makeStubBucket()
    const key = sourceObjectKey({ R2_KEY_PREFIX: "" }, "p1", "f1", "vtt")
    const original = new TextEncoder().encode("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello\n")
    SNAPSHOTS._seed(key, original)
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "episode.vtt", event_id: "ev1" }],
      file_source_blobs: [
        { file_id: "f1", project_id: "p1", format: "vtt", raw_source: null, r2_key: key },
      ],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 600 })
    const res = await handleExportSourceRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      { headers: { Authorization: `Bearer ${token}` } },
    ), { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, SNAPSHOTS } as any)

    expect(res?.status).toBe(200)
    expect(res?.headers.get("X-Export-Mode")).toBe("raw-original")
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(original)
  })
})
