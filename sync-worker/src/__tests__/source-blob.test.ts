// Tests for the source-blob R2 endpoint (FRO-156).
// Mirrors the audio.test.ts pattern: stub R2 bucket + direct handler invocation.

import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleSourceBlobRequest, sourceBlobKey } from "../source-blob"
import type { SyncTokenClaims } from "../auth"

const SECRET = "source-blob-tests-secret"

function makeStubBucket() {
  const store = new Map<string, { body: ArrayBuffer; contentType?: string }>()
  return {
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return {
        arrayBuffer: async () => obj.body,
        httpMetadata: { contentType: obj.contentType },
      }
    },
    async put(
      key: string,
      value: ArrayBuffer,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      store.set(key, { body: value, contentType: opts?.httpMetadata?.contentType })
    },
    async delete(_key: string) {},
    _has(key: string) { return store.has(key) },
    _get(key: string) { return store.get(key) },
  }
}

type StubEnv = {
  SNAPSHOTS: ReturnType<typeof makeStubBucket>
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
}

async function makeToken(
  partial: Partial<SyncTokenClaims> = {},
  secret: string = SECRET,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: 1,
    projectId: "p1",
    fileId: "f1",
    role: 600,
    aud: "sync",
    iat: now,
    exp: now + 900,
    ...partial,
  }
  return sign(claims as unknown as Record<string, unknown>, secret, "HS256")
}

describe("sourceBlobKey", () => {
  it("builds the correct R2 key", () => {
    const env = { SNAPSHOTS: makeStubBucket(), R2_KEY_PREFIX: "test" }
    expect(sourceBlobKey(env, "p1", "f1")).toBe("test/projects/p1/files/f1/source")
  })

  it("omits the prefix when R2_KEY_PREFIX is empty", () => {
    const env = { SNAPSHOTS: makeStubBucket() }
    expect(sourceBlobKey(env, "proj", "file")).toBe("projects/proj/files/file/source")
  })
})

describe("handleSourceBlobRequest — PUT", () => {
  it("stores the blob and returns r2Key + bytes", async () => {
    const bucket = makeStubBucket()
    const env: StubEnv = { SNAPSHOTS: bucket, SYNC_SECRET_KEY: SECRET }
    const token = await makeToken({ projectId: "p1", fileId: "f1" })
    const bytes = new Uint8Array([1, 2, 3, 4]).buffer

    const req = new Request("http://worker/source-blob/p1/f1", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      },
      body: bytes,
    })

    const res = await handleSourceBlobRequest(req, env as any)
    expect(res?.status).toBe(200)
    const body = await res!.json() as { ok: boolean; r2Key: string; bytes: number }
    expect(body.ok).toBe(true)
    expect(body.bytes).toBe(4)
    expect(body.r2Key).toContain("projects/p1/files/f1/source")
    expect(bucket._has(body.r2Key)).toBe(true)
  })

  it("returns 401 when no token provided", async () => {
    const bucket = makeStubBucket()
    const env: StubEnv = { SNAPSHOTS: bucket, SYNC_SECRET_KEY: SECRET }
    const req = new Request("http://worker/source-blob/p1/f1", {
      method: "PUT",
      body: new Uint8Array([1]).buffer,
    })
    const res = await handleSourceBlobRequest(req, env as any)
    expect(res?.status).toBe(401)
  })

  it("returns 403 when token's projectId doesn't match URL", async () => {
    const bucket = makeStubBucket()
    const env: StubEnv = { SNAPSHOTS: bucket, SYNC_SECRET_KEY: SECRET }
    // token is scoped to "other-project", but URL says "p1"
    const token = await makeToken({ projectId: "other-project", fileId: "f1" })
    const req = new Request("http://worker/source-blob/p1/f1", {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: new Uint8Array([1]).buffer,
    })
    const res = await handleSourceBlobRequest(req, env as any)
    expect(res?.status).toBe(403)
  })
})

describe("handleSourceBlobRequest — GET", () => {
  it("retrieves a previously stored blob", async () => {
    const bucket = makeStubBucket()
    const env: StubEnv = { SNAPSHOTS: bucket, SYNC_SECRET_KEY: SECRET }
    const token = await makeToken({ projectId: "p2", fileId: "f2" })
    const original = new Uint8Array([10, 20, 30])
    const key = sourceBlobKey({ R2_KEY_PREFIX: env.R2_KEY_PREFIX }, "p2", "f2")
    await bucket.put(key, original.buffer as ArrayBuffer)

    const req = new Request("http://worker/source-blob/p2/f2", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = await handleSourceBlobRequest(req, env as any)
    expect(res?.status).toBe(200)
    const buf = await res!.arrayBuffer()
    expect(new Uint8Array(buf)).toEqual(original)
  })

  it("returns 404 when blob not found", async () => {
    const bucket = makeStubBucket()
    const env: StubEnv = { SNAPSHOTS: bucket, SYNC_SECRET_KEY: SECRET }
    const token = await makeToken({ projectId: "p3", fileId: "f3" })
    const req = new Request("http://worker/source-blob/p3/f3", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = await handleSourceBlobRequest(req, env as any)
    expect(res?.status).toBe(404)
  })
})

describe("handleSourceBlobRequest — routing", () => {
  it("returns null for non-matching paths", async () => {
    const env: StubEnv = { SNAPSHOTS: makeStubBucket(), SYNC_SECRET_KEY: SECRET }
    const req = new Request("http://worker/audio/p/f/clip.webm", { method: "GET" })
    const res = await handleSourceBlobRequest(req, env as any)
    expect(res).toBeNull()
  })

  it("returns 405 for unsupported methods", async () => {
    const env: StubEnv = { SNAPSHOTS: makeStubBucket(), SYNC_SECRET_KEY: SECRET }
    const token = await makeToken({ projectId: "p4", fileId: "f4" })
    const req = new Request("http://worker/source-blob/p4/f4", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    })
    const res = await handleSourceBlobRequest(req, env as any)
    expect(res?.status).toBe(405)
  })
})
