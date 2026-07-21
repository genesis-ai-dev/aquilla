// TDD test for PUT /api/v1/projects/:projectId/files/:fileId/source
// Uploads original .docx to SNAPSHOTS R2 bucket and upserts file_source_blobs.

import { describe, it, expect } from "vitest"
import { handleSourceUploadRequest, sourceObjectKey, MAX_SOURCE_BYTES } from "../events/source-upload-route"
import { makeTestDb } from "./helpers/pg-test-db"
import { makeTestToken } from "./helpers/auth"

const SECRET = "test-secret"

// Minimal R2 stub copied from admin.test.ts
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
      store.set(key, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    },
  }
}

describe("PUT /api/v1/projects/:projectId/files/:fileId/source", () => {
  it("uses a lossless .usx object key for preserved USX originals", () => {
    expect(sourceObjectKey({}, "p1", "f1", "usx"))
      .toContain("projects/p1/files/f1/source/original.usx")
  })

  it("uploads docx bytes to SNAPSHOTS and writes a file_source_blobs row", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "test.docx", event_id: "ev1" }],
    })
    const token = await makeTestToken(SECRET, {
      projectId: "p1",
      fileId: "f1",
      role: 500, // PROJECT_LEAD
    })
    const SNAPSHOTS = makeStubBucket()
    const env = { SNAPSHOTS, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any

    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]) // PK zip magic
    const req = new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "X-Source-Format": "docx" },
        body: bytes,
      },
    )

    const res = await handleSourceUploadRequest(req, env)
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; key: string }
    expect(body.ok).toBe(true)

    const key = sourceObjectKey(env, "p1", "f1", "docx")
    expect(key).toContain("projects/p1/files/f1/source/original.docx")
    expect(SNAPSHOTS._allKeys()).toContain(key)
    expect(body.key).toBe(key)

    // DB row must exist with r2_key set and raw_source NULL
    const row = await db.prepare(
      "SELECT r2_key, raw_source FROM file_source_blobs WHERE file_id = ?",
    ).bind("f1").first<{ r2_key: string; raw_source: string | null }>()
    expect(row).not.toBeNull()
    expect(row!.r2_key).toBe(key)
    expect(row!.raw_source).toBeNull()
  })

  it("preserves a custom text original with its explicit format", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "records.odd", event_id: "ev1" }],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const SNAPSHOTS = makeStubBucket()
    const env = { SNAPSHOTS, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any
    const original = new TextEncoder().encode("source|target\nHello|Bonjour\n")

    const res = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "X-Source-Format": "custom-original" },
        body: original,
      },
    ), env)

    expect(res?.status).toBe(200)
    const row = await db.prepare(
      "SELECT format, r2_key, raw_source FROM file_source_blobs WHERE file_id = ?",
    ).bind("f1").first<{ format: string; r2_key: string; raw_source: string | null }>()
    expect(row).toMatchObject({ format: "custom-original", raw_source: null })
    expect(row?.r2_key).toContain("original.bin")
    expect(SNAPSHOTS._allKeys()).toContain(row?.r2_key)
  })

  it("rejects an unsafe source-format header", async () => {
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const env = { SNAPSHOTS: makeStubBucket(), AQUILLA_PG: {} as any, SYNC_SECRET_KEY: SECRET } as any
    const res = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "X-Source-Format": "../../secret" },
        body: new Uint8Array([1]),
      },
    ), env)
    expect(res?.status).toBe(400)
  })

  it("returns null for non-matching path", async () => {
    const env = { SNAPSHOTS: makeStubBucket(), SYNC_SECRET_KEY: SECRET } as any
    const res = await handleSourceUploadRequest(
      new Request("https://x/api/v1/other", { method: "PUT" }),
      env,
    )
    expect(res).toBeNull()
  })

  // WHY: the handler buffers the whole body into memory (arrayBuffer) before
  // writing to R2. Without a cap, an oversize (or hostile) upload can exhaust
  // memory / write an unbounded object. Reject early on the advertised size.
  it("returns 413 when Content-Length exceeds the cap (before buffering)", async () => {
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const SNAPSHOTS = makeStubBucket()
    const env = { SNAPSHOTS, AQUILLA_PG: {} as any, SYNC_SECRET_KEY: SECRET } as any

    const req = new Request("https://x/api/v1/projects/p1/files/f1/source", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Source-Format": "docx",
        "Content-Length": String(MAX_SOURCE_BYTES + 1),
      },
      body: new Uint8Array([0x50, 0x4b]),
    })
    const res = await handleSourceUploadRequest(req, env)
    expect(res?.status).toBe(413)
    // Rejected before touching R2 — nothing was written.
    expect(SNAPSHOTS._allKeys()).toHaveLength(0)
  })

  it("still accepts an at-cap upload (boundary is exclusive of the over-cap case)", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "test.docx", event_id: "ev1" }],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const SNAPSHOTS = makeStubBucket()
    const env = { SNAPSHOTS, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any

    const req = new Request("https://x/api/v1/projects/p1/files/f1/source", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Source-Format": "docx",
        // Exactly at the cap must NOT be rejected — only strictly-over is 413.
        "Content-Length": String(MAX_SOURCE_BYTES),
      },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    })
    const res = await handleSourceUploadRequest(req, env)
    expect(res?.status).toBe(200)
  })

  it("returns 403 for a token with role below PROJECT_LEAD (500)", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "test.docx", event_id: "ev1" }],
    })
    const lowRoleToken = await makeTestToken(SECRET, {
      projectId: "p1",
      fileId: "f1",
      role: 400, // CONTRIBUTOR — below PROJECT_LEAD (500)
    })
    const env = { SNAPSHOTS: makeStubBucket(), AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any

    const req = new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${lowRoleToken}`, "X-Source-Format": "docx" },
        body: new Uint8Array([0x50, 0x4b]),
      },
    )
    const res = await handleSourceUploadRequest(req, env)
    expect(res?.status).toBe(403)
  })
})
