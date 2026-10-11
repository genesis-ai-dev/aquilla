// Tests for the direct-to-R2 multipart upload phases on /audio/* (AQU-1853).
//
// Same shape as audio.test.ts: a stub R2 bucket plus direct invocation of the
// route handler, no miniflare. The stub models the parts of R2's multipart
// contract the handler depends on — an unknown uploadId throws, a part's etag
// must match on complete, and completing assembles the parts in part-number
// order into one object.

import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { handleAudioRequest } from "../audio"
import {
  AUDIO_UPLOAD_PART_BYTES,
  MAX_AUDIO_MULTIPART_BYTES,
  MAX_AUDIO_PART_BYTES,
  parseAudioMultipartPhase,
} from "../audio-multipart"
import type { SyncTokenClaims } from "../auth"

const SECRET = "audio-multipart-tests-secret"
const VIEWER_ROLE = 100
const CONTRIBUTOR_ROLE = 400

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (typeof value === "string") return new TextEncoder().encode(value)
  throw new Error(`stub uploadPart: unsupported value ${typeof value}`)
}

/** etag the stub derives from a part, so `complete` can verify it. */
const partEtag = (partNumber: number, bytes: Uint8Array) =>
  `etag-${partNumber}-${bytes.byteLength}`

function makeMultipartBucket() {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>()
  const uploads = new Map<
    string,
    { key: string; parts: Map<number, Uint8Array>; contentType?: string }
  >()
  let seq = 0

  const resume = (key: string, uploadId: string) => ({
    key,
    uploadId,
    async uploadPart(partNumber: number, value: unknown) {
      const upload = uploads.get(uploadId)
      if (!upload || upload.key !== key) throw new Error("unknown multipart upload")
      const bytes = toBytes(value)
      upload.parts.set(partNumber, bytes)
      return { partNumber, etag: partEtag(partNumber, bytes) }
    },
    async complete(parts: { partNumber: number; etag: string }[]) {
      const upload = uploads.get(uploadId)
      if (!upload || upload.key !== key) throw new Error("unknown multipart upload")
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber)
      const chunks: Uint8Array[] = []
      for (const part of ordered) {
        const stored = upload.parts.get(part.partNumber)
        if (!stored) throw new Error(`missing part ${part.partNumber}`)
        if (partEtag(part.partNumber, stored) !== part.etag) throw new Error("etag mismatch")
        chunks.push(stored)
      }
      const size = chunks.reduce((n, c) => n + c.byteLength, 0)
      const body = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        body.set(chunk, offset)
        offset += chunk.byteLength
      }
      store.set(key, { body, contentType: upload.contentType })
      uploads.delete(uploadId)
      return { key, size, httpMetadata: { contentType: upload.contentType } }
    },
    async abort() {
      if (!uploads.has(uploadId)) throw new Error("unknown multipart upload")
      uploads.delete(uploadId)
    },
  })

  return {
    async createMultipartUpload(
      key: string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      const uploadId = `up-${++seq}`
      uploads.set(uploadId, {
        key,
        parts: new Map(),
        contentType: opts?.httpMetadata?.contentType,
      })
      return resume(key, uploadId)
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      return resume(key, uploadId)
    },
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { size: obj.body.byteLength, body: new Response(obj.body).body }
    },
    async head(key: string) {
      const obj = store.get(key)
      return obj ? { size: obj.body.byteLength } : null
    },
    async put() {
      throw new Error("single-shot put not expected in these tests")
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k)
    },
    _object(key: string) {
      return store.get(key)
    },
    _openUploads() {
      return uploads.size
    },
  }
}

type StubEnv = {
  SNAPSHOTS: ReturnType<typeof makeMultipartBucket>
  SYNC_SECRET_KEY?: string
}

const makeEnv = (): StubEnv => ({
  SNAPSHOTS: makeMultipartBucket(),
  SYNC_SECRET_KEY: SECRET,
})

async function makeToken(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: 1,
    projectId: "p1",
    fileId: "f1",
    role: CONTRIBUTOR_ROLE,
    aud: "sync",
    iat: now,
    exp: now + 900,
    ...partial,
  }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

const OBJECT = "audio-c1-1-abc.webm"
const KEY = "projects/p1/files/f1/audio/audio-c1-1-abc.webm"

function phaseUrl(params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString()
  return `https://sync.test/audio/p1/f1/${OBJECT}?${query}`
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (request: Request, env: StubEnv) => handleAudioRequest(request, env as any)

async function createUpload(
  env: StubEnv,
  token: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const res = await call(
    new Request(phaseUrl({ multipart: "create" }), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, ...headers },
    }),
    env,
  )
  expect(res!.status).toBe(200)
  const body = (await res!.json()) as { uploadId: string }
  return body.uploadId
}

async function putPart(
  env: StubEnv,
  token: string,
  uploadId: string,
  partNumber: number,
  bytes: Uint8Array,
): Promise<Response> {
  return (await call(
    new Request(phaseUrl({ multipart: "part", uploadId, partNumber: String(partNumber) }), {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}` },
      body: bytes,
    }),
    env,
  ))!
}

describe("parseAudioMultipartPhase", () => {
  it("accepts the four phases and rejects anything else", () => {
    for (const phase of ["create", "part", "complete", "abort"] as const) {
      expect(parseAudioMultipartPhase(phase)).toBe(phase)
    }
    expect(parseAudioMultipartPhase("CREATE")).toBeNull()
    expect(parseAudioMultipartPhase("finish")).toBeNull()
    expect(parseAudioMultipartPhase(null)).toBeNull()
  })
})

describe("multipart upload round trip", () => {
  it("assembles the parts into one object and reports its real size", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token, { "X-Upload-Content-Type": "video/mp4" })

    const first = new Uint8Array(40).fill(7)
    const second = new Uint8Array(15).fill(9)
    const ackFirst = await putPart(env, token, uploadId, 1, first)
    const ackSecond = await putPart(env, token, uploadId, 2, second)
    expect(ackFirst.status).toBe(200)
    expect(ackSecond.status).toBe(200)
    const parts = [
      (await ackFirst.json()) as { partNumber: number; etag: string },
      (await ackSecond.json()) as { partNumber: number; etag: string },
    ]

    const res = (await call(
      new Request(phaseUrl({ multipart: "complete", uploadId }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ parts, sizeBytes: 55 }),
      }),
      env,
    ))!
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, key: KEY, bytes: 55 })

    const stored = env.SNAPSHOTS._object(KEY)!
    expect(stored.body.byteLength).toBe(55)
    expect(Array.from(stored.body.slice(0, 2))).toEqual([7, 7])
    expect(Array.from(stored.body.slice(40, 42))).toEqual([9, 9])
    // The final object carries the media type from `create`, not the type of
    // the (JSON / octet-stream) phase requests.
    expect(stored.contentType).toBe("video/mp4")
    expect(env.SNAPSHOTS._openUploads()).toBe(0)
  })

  it("tells the client what part size to use", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await call(
      new Request(phaseUrl({ multipart: "create" }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(await res.json()).toMatchObject({
      partSizeBytes: AUDIO_UPLOAD_PART_BYTES,
      maxBytes: MAX_AUDIO_MULTIPART_BYTES,
      key: KEY,
    })
  })

  it("aborts cleanly, leaving neither parts nor an object", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    await putPart(env, token, uploadId, 1, new Uint8Array(8).fill(1))
    expect(env.SNAPSHOTS._openUploads()).toBe(1)

    const res = (await call(
      new Request(phaseUrl({ multipart: "abort", uploadId }), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(res.status).toBe(200)
    expect(env.SNAPSHOTS._openUploads()).toBe(0)
    expect(env.SNAPSHOTS._object(KEY)).toBeUndefined()
  })

  it("treats aborting an already-gone upload as success", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await call(
      new Request(phaseUrl({ multipart: "abort", uploadId: "never-existed" }), {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(res.status).toBe(200)
  })
})

describe("multipart auth", () => {
  it("rejects every phase without a token", async () => {
    const env = makeEnv()
    for (const [phase, method] of [
      ["create", "POST"],
      ["part", "PUT"],
      ["complete", "POST"],
      ["abort", "DELETE"],
    ] as const) {
      const res = (await call(
        new Request(phaseUrl({ multipart: phase, uploadId: "u", partNumber: "1" }), { method }),
        env,
      ))!
      expect(res.status, phase).toBe(401)
    }
  })

  it("denies a viewer-role token an upload URL", async () => {
    const env = makeEnv()
    const token = await makeToken({ role: VIEWER_ROLE })
    const res = (await call(
      new Request(phaseUrl({ multipart: "create" }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(res.status).toBe(403)
    expect(await res.text()).toBe("insufficient role")
  })

  it("denies a viewer a part even when they hold a valid uploadId", async () => {
    // An upload id is not a bearer token: the role floor is re-checked on
    // every phase, not just at create.
    const env = makeEnv()
    const writer = await makeToken()
    const uploadId = await createUpload(env, writer)
    const viewer = await makeToken({ role: VIEWER_ROLE })
    const res = await putPart(env, viewer, uploadId, 1, new Uint8Array(4))
    expect(res.status).toBe(403)
  })

  it("rejects a token scoped to another project", async () => {
    const env = makeEnv()
    const token = await makeToken({ projectId: "other" })
    const res = (await call(
      new Request(phaseUrl({ multipart: "create" }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
    ))!
    expect(res.status).toBe(403)
    expect(await res.text()).toBe("token scoped to different project")
  })

  it("requires the right method per phase", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await call(
      new Request(phaseUrl({ multipart: "create" }), {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
        body: new Uint8Array(4),
      }),
      env,
    ))!
    expect(res.status).toBe(405)
  })
})

describe("multipart validation", () => {
  it("rejects an unknown phase", async () => {
    const env = makeEnv()
    const res = (await call(
      new Request(phaseUrl({ multipart: "finish" }), { method: "POST" }),
      env,
    ))!
    expect(res.status).toBe(400)
    expect(await res.text()).toBe("unknown multipart phase")
  })

  it("refuses an oversize object at create, before any bytes are stored", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await call(
      new Request(phaseUrl({ multipart: "create" }), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Upload-Total-Bytes": String(MAX_AUDIO_MULTIPART_BYTES + 1),
        },
      }),
      env,
    ))!
    expect(res.status).toBe(413)
    expect(await res.json()).toMatchObject({ maxBytes: MAX_AUDIO_MULTIPART_BYTES })
    expect(env.SNAPSHOTS._openUploads()).toBe(0)
  })

  it("rejects a non-numeric declared total", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await call(
      new Request(phaseUrl({ multipart: "create" }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "X-Upload-Total-Bytes": "lots" },
      }),
      env,
    ))!
    expect(res.status).toBe(400)
  })

  it("rejects an out-of-range part number", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    for (const partNumber of ["0", "-1", "10001", "1.5", "abc"]) {
      const res = (await call(
        new Request(phaseUrl({ multipart: "part", uploadId, partNumber }), {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: new Uint8Array(4),
        }),
        env,
      ))!
      expect(res.status, partNumber).toBe(400)
    }
  })

  it("rejects a part larger than the per-part cap on its declared length", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    const res = (await call(
      new Request(phaseUrl({ multipart: "part", uploadId, partNumber: "1" }), {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Length": String(MAX_AUDIO_PART_BYTES + 1),
        },
        body: new Uint8Array(8),
      }),
      env,
    ))!
    expect(res.status).toBe(413)
  })

  it("rejects an empty part", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    const res = await putPart(env, token, uploadId, 1, new Uint8Array(0))
    expect(res.status).toBe(400)
  })

  it("rejects a missing or malformed uploadId", async () => {
    const env = makeEnv()
    const token = await makeToken()
    for (const params of [
      { multipart: "part", partNumber: "1" },
      { multipart: "part", uploadId: "has space", partNumber: "1" },
      { multipart: "part", uploadId: "has\tcontrol", partNumber: "1" },
      { multipart: "part", uploadId: "x".repeat(1025), partNumber: "1" },
    ]) {
      const res = (await call(
        new Request(phaseUrl(params), {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}` },
          body: new Uint8Array(4),
        }),
        env,
      ))!
      expect(res.status).toBe(400)
    }
  })

  it("accepts an upload id containing base64 punctuation", async () => {
    // Real R2/S3 multipart upload ids contain "/", "+" and "=". Rejecting
    // those would break every large upload, so this is a guard, not a nicety.
    const env = makeEnv()
    const token = await makeToken()
    const res = await putPart(env, token, "ab/cd+ef==", 1, new Uint8Array(4))
    // Reaches R2 (and 409s because the stub has no such upload) rather than
    // being turned away as malformed.
    expect(res.status).toBe(409)
  })

  it("reports a stale uploadId as a conflict rather than a server error", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = await putPart(env, token, "up-does-not-exist", 1, new Uint8Array(4))
    expect(res.status).toBe(409)
  })

  it("rejects a complete with no parts", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    const res = (await call(
      new Request(phaseUrl({ multipart: "complete", uploadId }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ parts: [] }),
      }),
      env,
    ))!
    expect(res.status).toBe(400)
  })

  it("rejects a complete with a malformed part entry", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    for (const parts of [[{ partNumber: 1 }], [{ etag: "e" }], [{ partNumber: 0, etag: "e" }]]) {
      const res = (await call(
        new Request(phaseUrl({ multipart: "complete", uploadId }), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          body: JSON.stringify({ parts }),
        }),
        env,
      ))!
      expect(res.status).toBe(400)
    }
  })

  it("rejects invalid JSON on complete", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    const res = (await call(
      new Request(phaseUrl({ multipart: "complete", uploadId }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: "{not json",
      }),
      env,
    ))!
    expect(res.status).toBe(400)
  })

  it("requires a sha256 when the upload carries artifact provenance", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    const bytes = new Uint8Array(8).fill(3)
    const ack = await putPart(env, token, uploadId, 1, bytes)
    const parts = [await ack.json()]
    const res = (await call(
      new Request(phaseUrl({ multipart: "complete", uploadId }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          parts,
          artifactId: "0198abc1-2345-7def-89ab-0123456789ab",
        }),
      }),
      env,
    ))!
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/sha256 is required/)
  })

  it("rejects a malformed sha256", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    const ack = await putPart(env, token, uploadId, 1, new Uint8Array(8))
    const res = (await call(
      new Request(phaseUrl({ multipart: "complete", uploadId }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ parts: [await ack.json()], sha256: "nope" }),
      }),
      env,
    ))!
    expect(res.status).toBe(400)
  })

  it("rejects an artifactId that is not a uuid", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    const ack = await putPart(env, token, uploadId, 1, new Uint8Array(8))
    const res = (await call(
      new Request(phaseUrl({ multipart: "complete", uploadId }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ parts: [await ack.json()], artifactId: "not-a-uuid" }),
      }),
      env,
    ))!
    expect(res.status).toBe(400)
  })

  it("verifies the assembled size against what the client declared", async () => {
    // The one thing the server can always check cheaply: a dropped part or a
    // mis-declared length is caught, and the bad object is removed.
    const env = makeEnv()
    const token = await makeToken()
    const uploadId = await createUpload(env, token)
    const ack = await putPart(env, token, uploadId, 1, new Uint8Array(10).fill(1))
    const res = (await call(
      new Request(phaseUrl({ multipart: "complete", uploadId }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ parts: [await ack.json()], sizeBytes: 999 }),
      }),
      env,
    ))!
    expect(res.status).toBe(409)
    expect(await res.text()).toMatch(/10 bytes, client declared 999/)
    expect(env.SNAPSHOTS._object(KEY)).toBeUndefined()
  })

  it("reports a complete against an unknown upload as a conflict", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await call(
      new Request(phaseUrl({ multipart: "complete", uploadId: "up-gone" }), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ parts: [{ partNumber: 1, etag: "e" }] }),
      }),
      env,
    ))!
    expect(res.status).toBe(409)
  })

  it("answers a CORS preflight advertising the POST phases", async () => {
    const env = makeEnv()
    const res = (await call(
      new Request(phaseUrl({ multipart: "create" }), { method: "OPTIONS" }),
      env,
    ))!
    expect(res.status).toBe(204)
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST")
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Upload-Content-Type")
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("X-Upload-Total-Bytes")
  })
})
