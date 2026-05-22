// Tests for POST /api/v1/voice/convert. Mirrors audio.test.ts (stub R2 + direct
// handler invocation) and additionally stubs global fetch to stand in for the
// Seed-VC Modal endpoint.

import { describe, it, expect, afterEach } from "vitest"
import { sign } from "hono/jwt"
import { audioObjectKey } from "../audio"
import { handleVoiceConvertRequest, voiceRefObjectKey } from "../voice-convert"
import type { SyncTokenClaims } from "../auth"

const SECRET = "voice-tests-secret"
const MODAL_URL = "https://acct--seed-vc-web.modal.run/convert"
const MODAL_TOKEN = "modal-shared-secret"

interface StoredObject {
  key: string
  body: ArrayBuffer
  httpMetadata?: { contentType?: string }
}

function makeStubBucket() {
  const store = new Map<string, StoredObject>()
  return {
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return { arrayBuffer: async () => obj.body, httpMetadata: obj.httpMetadata }
    },
    async put(
      key: string,
      value: ArrayBuffer | Uint8Array | string,
      opts?: { httpMetadata?: { contentType?: string } },
    ) {
      const body =
        typeof value === "string"
          ? new TextEncoder().encode(value).buffer
          : value instanceof Uint8Array
            ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
            : value
      store.set(key, { key, body: body as ArrayBuffer, httpMetadata: opts?.httpMetadata })
    },
    _seed(key: string, bytes: Uint8Array, contentType?: string) {
      store.set(key, {
        key,
        body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        httpMetadata: contentType ? { contentType } : undefined,
      })
    },
    _allKeys() {
      return Array.from(store.keys())
    },
    async _bytes(key: string) {
      const obj = store.get(key)
      return obj ? new Uint8Array(obj.body) : null
    },
  }
}

type StubEnv = {
  SNAPSHOTS: ReturnType<typeof makeStubBucket>
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  SEED_VC_URL?: string
  SEED_VC_TOKEN?: string
}

function makeEnv(overrides: Partial<StubEnv> = {}): StubEnv {
  return {
    SNAPSHOTS: makeStubBucket(),
    SYNC_SECRET_KEY: SECRET,
    SEED_VC_URL: MODAL_URL,
    SEED_VC_TOKEN: MODAL_TOKEN,
    ...overrides,
  }
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
    role: 400,
    aud: "sync",
    iat: now,
    exp: now + 900,
    ...partial,
  }
  return sign(claims as unknown as Record<string, unknown>, secret, "HS256")
}

function call(env: StubEnv, req: Request) {
  return handleVoiceConvertRequest(
    req,
    env as unknown as Parameters<typeof handleVoiceConvertRequest>[1],
  )
}

function convertReq(form: FormData, token?: string) {
  return new Request("https://w/api/v1/voice/convert", {
    method: "POST",
    body: form,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

/** Stub global fetch to act as the Modal endpoint; records the last call. */
function stubModal(responder: () => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return responder()
  }) as unknown as typeof fetch
  return calls
}

describe("POST /api/v1/voice/convert", () => {
  it("returns null for unrelated paths", async () => {
    const res = await call(makeEnv(), new Request("https://w/audio/p1/f1/clip.webm"))
    expect(res).toBeNull()
  })

  it("503 when the Seed-VC endpoint isn't configured", async () => {
    const env = makeEnv({ SEED_VC_URL: undefined, SEED_VC_TOKEN: undefined })
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(503)
  })

  it("401 without a valid sync-token", async () => {
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    const res = (await call(makeEnv(), convertReq(form)))!
    expect(res.status).toBe(401)
  })

  it("403 when the token is scoped to a different project", async () => {
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    const token = await makeToken({ projectId: "other" })
    const res = (await call(makeEnv(), convertReq(form, token)))!
    expect(res.status).toBe(403)
  })

  it("400 when required fields are missing", async () => {
    const form = new FormData()
    form.append("projectId", "p1") // fileId + referenceAudioId omitted
    const res = (await call(makeEnv(), convertReq(form, await makeToken())))!
    expect(res.status).toBe(400)
  })

  it("404 when the reference clip is absent", async () => {
    const env = makeEnv()
    stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "missing.wav")
    form.append("source", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(404)
  })

  it("converts an inline source and writes the result to R2", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref1.wav"), new Uint8Array([9, 9]), "audio/wav")
    const converted = new Uint8Array([5, 6, 7, 8])
    const calls = stubModal(() => new Response(converted.buffer, { status: 200 }))

    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    form.append("diffusionSteps", "12")
    form.append("source", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "source")

    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; audioId: string; ext: string; objectName: string; url: string }
    expect(body.ok).toBe(true)
    expect(body.audioId).toMatch(/^audio-clone-/)
    expect(body.ext).toBe("wav")
    expect(body.url).toBe(`frontier-audio://${body.objectName}`)

    // Output landed in R2 under the file-scoped audio path.
    const stored = await env.SNAPSHOTS._bytes(audioObjectKey(env, "p1", "f1", body.objectName))
    expect(stored && Array.from(stored)).toEqual([5, 6, 7, 8])

    // Modal was called with the shared secret and a multipart body.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(MODAL_URL)
    expect((calls[0].init.headers as Record<string, string>)["X-Auth-Token"]).toBe(MODAL_TOKEN)
    const sentForm = calls[0].init.body as unknown as FormData
    expect(sentForm.get("diffusion_steps")).toBe("12")
    expect(sentForm.get("source")).toBeTruthy()
    expect(sentForm.get("reference")).toBeTruthy()
  })

  it("re-voices an existing recording referenced by sourceAudioId", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref1.wav"), new Uint8Array([9]), "audio/wav")
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "rec.webm"), new Uint8Array([4, 4]), "audio/webm")
    stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    form.append("sourceAudioId", "rec.webm")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(200)
  })

  it("400 when neither a source file nor sourceAudioId is given", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref1.wav"), new Uint8Array([9]), "audio/wav")
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(400)
  })

  it("502 when the Modal endpoint errors", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref1.wav"), new Uint8Array([9]), "audio/wav")
    stubModal(() => new Response("boom", { status: 500 }))
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(502)
  })

  it("honors R2_KEY_PREFIX for both reference read and output write", async () => {
    const env = makeEnv({ R2_KEY_PREFIX: "pr-7" })
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref1.wav"), new Uint8Array([9]), "audio/wav")
    stubModal(() => new Response(new Uint8Array([2, 2]).buffer, { status: 200 }))
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { objectName: string }
    expect(env.SNAPSHOTS._allKeys()).toContain(`pr-7/projects/p1/files/f1/audio/${body.objectName}`)
  })
})
