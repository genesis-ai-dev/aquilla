import { describe, expect, it } from "vitest"
import {
  deterministicSourceArtifactIds,
  handleMigrateSourceArtifactCopyRequest,
} from "../events/migrate-source-artifact-copy-route"
import { gitlabLfsKey } from "../events/migrate-audio-copy-route"
import { makeTestDb } from "./helpers/pg-test-db"

const SECRET = "source-copy-secret"
const OID = "ab12cd34" + "0".repeat(56)

function makeBucket() {
  const store = new Map<string, {
    body: ArrayBuffer
    customMetadata?: Record<string, string>
    httpMetadata?: { contentType?: string }
  }>()
  return {
    async head(key: string) {
      const object = store.get(key)
      return object
        ? { key, size: object.body.byteLength, customMetadata: object.customMetadata }
        : null
    },
    async get(key: string) {
      const object = store.get(key)
      if (!object) return null
      return {
        size: object.body.byteLength,
        body: new Blob([object.body]).stream(),
        customMetadata: object.customMetadata,
        httpMetadata: object.httpMetadata,
      }
    },
    async put(
      key: string,
      value: ArrayBuffer | Uint8Array | ReadableStream,
      options?: {
        customMetadata?: Record<string, string>
        httpMetadata?: { contentType?: string }
      },
    ) {
      const body = value instanceof ReadableStream
        ? await new Response(value).arrayBuffer()
        : value instanceof Uint8Array
          ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
          : value
      store.set(key, {
        body,
        customMetadata: options?.customMetadata,
        httpMetadata: options?.httpMetadata,
      })
      return { key, size: body.byteLength }
    },
    async delete(key: string) {
      store.delete(key)
    },
    seed(key: string, bytes: Uint8Array) {
      store.set(key, {
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      })
    },
    keys() {
      return [...store.keys()]
    },
  }
}

function request(body: unknown, auth = `Bearer ${SECRET}`): Request {
  return new Request("https://sync.example/migrate/source-artifact-copy", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /migrate/source-artifact-copy", () => {
  it("matches the Node migration's pinned cross-runtime artifact ids", async () => {
    expect(await deterministicSourceArtifactIds("p1", "f1", OID)).toEqual({
      artifactId: "d8b2d842-2c4f-57d6-b61f-d057edff9ce4",
      bindingId: "e96365df-b317-5e79-a675-174ea420fefd",
    })
  })

  it("copies LFS bytes and atomically binds the deterministic IDML source artifact", async () => {
    const bytes = new TextEncoder().encode("IDML-BYTES")
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Project", created_by: 1 }],
      files: [{
        id: "f1",
        project_id: "p1",
        name: "book.idml",
        event_id: "evt-file",
        created_by: "1",
      }],
    })
    const LFS_SRC = makeBucket()
    const SNAPSHOTS = makeBucket()
    LFS_SRC.seed(gitlabLfsKey(OID), bytes)

    const response = await handleMigrateSourceArtifactCopyRequest(
      request({ projectId: "p1", fileId: "f1", oid: OID, size: bytes.byteLength, name: "book.idml" }),
      {
        AQUILLA_PG: db,
        SNAPSHOTS: SNAPSHOTS as unknown as R2Bucket,
        LFS_SRC: LFS_SRC as unknown as R2Bucket,
        SYNC_SECRET_KEY: SECRET,
      },
    )
    expect(response?.status).toBe(200)
    const body = await response!.json() as {
      artifactId: string
      bindingId: string
      copied: boolean
      key: string
    }
    expect(body).toMatchObject({
      ...(await deterministicSourceArtifactIds("p1", "f1", OID)),
      copied: true,
    })
    expect(SNAPSHOTS.keys()).toEqual([body.key])

    const sidecar = await db.prepare(
      `SELECT format, r2_key, size_bytes FROM file_source_blobs WHERE project_id = ? AND file_id = ?`,
    ).bind("p1", "f1").first<{ format: string; r2_key: string; size_bytes: number }>()
    expect(sidecar).toMatchObject({ format: "idml", r2_key: body.key, size_bytes: bytes.byteLength })
    const artifact = await db.prepare(
      `SELECT id::text AS id, sha256, kind FROM artifacts WHERE id::text = ?`,
    ).bind(body.artifactId).first<{ id: string; sha256: string; kind: string }>()
    expect(artifact).toMatchObject({ id: body.artifactId, sha256: OID, kind: "source" })
    const binding = await db.prepare(
      `SELECT id::text AS id, profile_id, profile_version, fidelity
         FROM artifact_bindings WHERE artifact_id::text = ?`,
    ).bind(body.artifactId).first<{
      id: string
      profile_id: string
      profile_version: string
      fidelity: string
    }>()
    expect(binding).toMatchObject({
      id: body.bindingId,
      profile_id: "builtin:idml-roundtrip",
      profile_version: "2",
      fidelity: "content-only",
    })
  })

  it("is idempotent and rejects a caller-supplied mismatched deterministic id", async () => {
    const bytes = new TextEncoder().encode("IDML-BYTES")
    const { db } = await makeTestDb({
      projects: [{ id: "p1", name: "Project", created_by: 1 }],
      files: [{ id: "f1", project_id: "p1", name: "book.idml", event_id: "evt-file", created_by: "1" }],
    })
    const LFS_SRC = makeBucket()
    const SNAPSHOTS = makeBucket()
    LFS_SRC.seed(gitlabLfsKey(OID), bytes)
    const env = {
      AQUILLA_PG: db,
      SNAPSHOTS: SNAPSHOTS as unknown as R2Bucket,
      LFS_SRC: LFS_SRC as unknown as R2Bucket,
      SYNC_SECRET_KEY: SECRET,
    }
    const body = { projectId: "p1", fileId: "f1", oid: OID, size: bytes.byteLength }
    expect((await handleMigrateSourceArtifactCopyRequest(request(body), env))?.status).toBe(200)
    const retry = await handleMigrateSourceArtifactCopyRequest(request(body), env)
    expect(retry?.status).toBe(200)
    expect(await retry?.json()).toMatchObject({ ok: true, copied: false })

    const mismatch = await handleMigrateSourceArtifactCopyRequest(
      request({ ...body, artifactId: "01900000-0000-7000-8000-000000000001" }),
      env,
    )
    expect(mismatch?.status).toBe(409)
  })
})
