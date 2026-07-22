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
    async put(key: string, value: ArrayBuffer | Uint8Array | string | ReadableStream) {
      const body = value instanceof ReadableStream
        ? await new Response(value).arrayBuffer()
        :
        typeof value === "string"
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, body as ArrayBuffer)
      return { size: (body as ArrayBuffer).byteLength }
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
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Source-Format": "docx",
          "X-Artifact-Id": "01900000-0000-7000-8000-000000000001",
        },
        body: bytes,
      },
    )

    const res = await handleSourceUploadRequest(req, env)
    expect(res?.status).toBe(200)
    const body = (await res!.json()) as { ok: boolean; artifactId: string; key: string; sha256: string }
    expect(body.ok).toBe(true)
    expect(body.artifactId).toBe("01900000-0000-7000-8000-000000000001")
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/)

    const key = sourceObjectKey(env, "p1", "f1", "docx", body.artifactId)
    expect(key).toContain(`artifacts/p1/${body.artifactId}/original.docx`)
    expect(SNAPSHOTS._allKeys()).toContain(key)
    expect(body.key).toBe(key)

    // DB row must exist with r2_key set and raw_source NULL
    const row = await db.prepare(
      "SELECT r2_key, raw_source FROM file_source_blobs WHERE file_id = ?",
    ).bind("f1").first<{ r2_key: string; raw_source: string | null }>()
    expect(row).not.toBeNull()
    expect(row!.r2_key).toBe(key)
    expect(row!.raw_source).toBeNull()

    const artifact = await db.prepare(
      "SELECT id::text AS id, credential_id, file_id, sha256, jsonb_typeof(metadata) AS metadata_type FROM artifacts WHERE id::text = ?",
    ).bind(body.artifactId).first<{ id: string; credential_id: string | null; file_id: string; sha256: string; metadata_type: string }>()
    expect(artifact).toMatchObject({
      id: body.artifactId,
      credential_id: null,
      file_id: "f1",
      sha256: body.sha256,
      metadata_type: "object",
    })
    const binding = await db.prepare(
      "SELECT artifact_id::text AS artifact_id, file_id, binding_role, profile_id, jsonb_typeof(manifest) AS manifest_type FROM artifact_bindings WHERE artifact_id::text = ?",
    ).bind(body.artifactId).first<{ artifact_id: string; file_id: string; binding_role: string; profile_id: string; manifest_type: string }>()
    expect(binding).toMatchObject({
      artifact_id: body.artifactId,
      file_id: "f1",
      binding_role: "source",
      profile_id: "legacy:docx",
      manifest_type: "object",
    })
  })

  it("rejects an artifact id that already identifies a different artifact kind", async () => {
    const artifactId = "01900000-0000-7000-8000-000000000001"
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    const sha = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "test.docx", event_id: "ev1" }],
    })
    await db.prepare(
      `INSERT INTO artifacts (
         id, project_id, uploaded_by_user_id, credential_id, name, content_type,
         size_bytes, sha256, r2_key, file_id, kind, audio_id, metadata
       ) VALUES (?::uuid, 'p1', '1', NULL, 'clip.wav', 'audio/wav', 4, ?, 'audio-key', 'f1', 'audio', 'clip.wav', '{}'::jsonb)`,
    ).bind(artifactId, sha).run()
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const SNAPSHOTS = makeStubBucket()
    const response = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Source-Format": "docx",
          "X-Artifact-Id": artifactId,
        },
        body: bytes,
      },
    ), { SNAPSHOTS, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any)

    expect(response?.status).toBe(409)
    expect(SNAPSHOTS._allKeys()).toHaveLength(0)
  })

  it("returns a CORS-readable error and removes a new R2 object when metadata persistence fails", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "test.docx", event_id: "ev1" }],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const SNAPSHOTS = makeStubBucket()
    const failingDb = Object.create(db) as typeof db
    failingDb.batch = async () => {
      throw new Error("raw_source constraint")
    }
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04])
    const res = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Source-Format": "docx",
          "X-Artifact-Id": "01900000-0000-7000-8000-000000000002",
        },
        body: bytes,
      },
    ), { SNAPSHOTS, AQUILLA_PG: failingDb, SYNC_SECRET_KEY: SECRET } as any)

    expect(res?.status).toBe(500)
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(await res?.text()).toContain("source metadata write failed")
    expect(SNAPSHOTS._allKeys()).toHaveLength(0)
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

  it("persists target artifacts against the selected language lane only", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "Genesis", event_id: "ev1" }],
    })
    await db.prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       VALUES ('f1', 'p1', 'usfm', NULL, 'source-key', 12, 1)`,
    ).run()
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const artifactId = "01900000-0000-7000-8000-000000000009"
    const response = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Source-Format": "xlsx",
          "X-Artifact-Id": artifactId,
          "X-Artifact-Binding-Role": "target",
          "X-Artifact-Target-Lang": "fr-CA",
        },
        body: new Uint8Array([0x50, 0x4b, 1]),
      },
    ), { SNAPSHOTS: makeStubBucket(), AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any)

    expect(response?.status).toBe(200)
    const binding = await db.prepare(
      `SELECT binding_role, target_lang FROM artifact_bindings WHERE artifact_id::text = ?`,
    ).bind(artifactId).first<{ binding_role: string; target_lang: string }>()
    expect(binding).toEqual({ binding_role: "target", target_lang: "fr-CA" })
    const sourceSidecar = await db.prepare(
      `SELECT format, r2_key FROM file_source_blobs WHERE file_id = 'f1'`,
    ).first<{ format: string; r2_key: string }>()
    expect(sourceSidecar).toEqual({ format: "usfm", r2_key: "source-key" })
  })

  it("replaces the round-trip sidecar for an explicitly selected target skeleton", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "Genesis", event_id: "ev1" }],
    })
    await db.prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       VALUES ('f1', 'p1', 'usfm', NULL, 'source-key', 12, 1)`,
    ).run()
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const response = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Source-Format": "usfm",
          "X-Artifact-Id": "01900000-0000-7000-8000-000000000012",
          "X-Artifact-Binding-Role": "target",
          "X-Artifact-Target-Lang": "fr",
          "X-Update-Source-Sidecar": "true",
        },
        body: new TextEncoder().encode("\\id GEN\n\\c 1\n\\v 1 Au commencement"),
      },
    ), { SNAPSHOTS: makeStubBucket(), AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any)

    expect(response?.status).toBe(200)
    const sidecar = await db.prepare(
      `SELECT format, r2_key FROM file_source_blobs WHERE file_id = 'f1'`,
    ).first<{ format: string; r2_key: string }>()
    expect(sidecar?.format).toBe("usfm")
    expect(sidecar?.r2_key).not.toBe("source-key")
  })

  it("stores one complete Paratext package and binds it to every book without replacing book sidecars", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [
        { id: "f1", project_id: "p1", name: "Genesis", event_id: "ev1" },
        { id: "f2", project_id: "p1", name: "Exodus", event_id: "ev2" },
      ],
    })
    await db.prepare(
      `INSERT INTO file_source_blobs (file_id, project_id, format, raw_source, r2_key, size_bytes, created_at)
       VALUES ('f1', 'p1', 'usfm', NULL, 'existing-usfm-key', 12, 1)`,
    ).run()
    const firstToken = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const secondToken = await makeTestToken(SECRET, { projectId: "p1", fileId: "f2", role: 500 })
    const SNAPSHOTS = makeStubBucket()
    const env = { SNAPSHOTS, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any
    const artifactId = "01900000-0000-7000-8000-000000000010"
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

    const upload = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${firstToken}`,
          "X-Source-Format": "paratext-project",
          "X-Artifact-Id": artifactId,
          "X-Artifact-Name": "My%20Project.zip",
          "X-Artifact-Binding-Role": "support",
          "X-Artifact-Member-Path": "My%20Project%2F01GEN.SFM",
          "X-Artifact-Profile-Id": "builtin:paratext-project",
          "X-Artifact-Profile-Version": "1",
          "X-Artifact-Fidelity": "preserved-only",
          "X-Update-Source-Sidecar": "false",
        },
        body: bytes,
      },
    ), env)
    expect(upload?.status).toBe(200)

    const bind = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f2/source-bindings",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${secondToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId,
          bindingRole: "support",
          memberPath: "My Project/02EXO.SFM",
          profileId: "builtin:paratext-project",
          profileVersion: "1",
          fidelity: "preserved-only",
        }),
      },
    ), env)
    expect(bind?.status).toBe(200)

    const artifact = await db.prepare(
      `SELECT name, content_type, r2_key FROM artifacts WHERE id::text = ?`,
    ).bind(artifactId).first<{ name: string; content_type: string; r2_key: string }>()
    expect(artifact).toMatchObject({ name: "My Project.zip", content_type: "application/zip" })
    expect(SNAPSHOTS._allKeys()).toEqual([artifact!.r2_key])
    const bindings = await db.prepare(
      `SELECT file_id, binding_role, member_path, profile_id, fidelity
         FROM artifact_bindings WHERE artifact_id::text = ? ORDER BY file_id`,
    ).bind(artifactId).all<{
      file_id: string
      binding_role: string
      member_path: string
      profile_id: string
      fidelity: string
    }>()
    expect(bindings.results).toEqual([
      {
        file_id: "f1",
        binding_role: "support",
        member_path: "My Project/01GEN.SFM",
        profile_id: "builtin:paratext-project",
        fidelity: "preserved-only",
      },
      {
        file_id: "f2",
        binding_role: "support",
        member_path: "My Project/02EXO.SFM",
        profile_id: "builtin:paratext-project",
        fidelity: "preserved-only",
      },
    ])
    const sidecar = await db.prepare(
      `SELECT format, r2_key FROM file_source_blobs WHERE file_id = 'f1'`,
    ).first<{ format: string; r2_key: string }>()
    expect(sidecar).toEqual({ format: "usfm", r2_key: "existing-usfm-key" })
  })

  it("does not allow an artifact to be bound to a file in another project", async () => {
    const { db } = await makeTestDb({
      projects: [
        { id: "p1", name: "One", created_by: 1 },
        { id: "p2", name: "Two", created_by: 2 },
      ],
      files: [
        { id: "f1", project_id: "p1", name: "Genesis", event_id: "ev1" },
        { id: "f2", project_id: "p2", name: "Genesis", event_id: "ev2" },
      ],
    })
    await db.prepare(
      `INSERT INTO artifacts (
         id, project_id, uploaded_by_user_id, credential_id, name, content_type,
         size_bytes, sha256, r2_key, file_id, kind, metadata
       ) VALUES (?::uuid, 'p1', '1', NULL, 'p1.zip', 'application/zip', 1, 'abc', 'key', 'f1', 'source', '{}'::jsonb)`,
    ).bind("01900000-0000-7000-8000-000000000011").run()
    const token = await makeTestToken(SECRET, { projectId: "p2", fileId: "f2", role: 500 })
    const response = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p2/files/f2/source-bindings",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId: "01900000-0000-7000-8000-000000000011",
          bindingRole: "support",
          memberPath: "01GEN.SFM",
          profileId: "builtin:paratext-project",
          profileVersion: "1",
          fidelity: "preserved-only",
        }),
      },
    ), { SNAPSHOTS: makeStubBucket(), AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any)
    expect(response?.status).toBe(404)
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

  // Reject an oversize upload before reading or streaming its body.
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

  it("does not reject an at-cap streaming declaration as oversized", async () => {
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
        "X-Source-Size": String(MAX_SOURCE_BYTES),
        "X-Source-Sha256": "00".repeat(32),
      },
      body: new Uint8Array([0x50, 0x4b, 0x03, 0x04]),
    })
    const res = await handleSourceUploadRequest(req, env)
    // The tiny test body does not match the declared boundary size, but the
    // request passed the over-cap gate (strictly-over alone is 413).
    expect(res?.status).toBe(400)
  })

  it("streams checksum-qualified source bytes directly into R2", async () => {
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Test Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "project.zip", event_id: "ev1" }],
    })
    const token = await makeTestToken(SECRET, { projectId: "p1", fileId: "f1", role: 500 })
    const SNAPSHOTS = makeStubBucket()
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    const sha = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("")
    const res = await handleSourceUploadRequest(new Request(
      "https://x/api/v1/projects/p1/files/f1/source",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Source-Format": "paratext-project",
          "X-Source-Size": String(bytes.byteLength),
          "X-Source-Sha256": sha,
        },
        body: bytes,
      },
    ), { SNAPSHOTS, AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET } as any)

    expect(res?.status).toBe(200)
    expect(SNAPSHOTS._allKeys()).toHaveLength(1)
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
