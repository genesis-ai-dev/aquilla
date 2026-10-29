// Tests for POST /api/v1/voice/convert. Mirrors audio.test.ts (stub R2 + direct
// handler invocation) and additionally stubs global fetch to stand in for the
// voice forge Modal endpoint.

import { describe, it, expect, afterEach } from "vitest"
import { sign } from "hono/jwt"
import { audioObjectKey } from "../audio"
import {
  MAX_VOICE_CLIP_BYTES,
  VOICE_CONVERT_MAX_PER_USER_PER_WINDOW,
  VOICE_CONVERT_REQUEST_TIMEOUT_MS,
  handleVoiceConvertRequest,
  handleVoiceReferenceRequest,
  libraryVoiceKey,
  voiceRefObjectKey,
  voiceReferenceFingerprint,
} from "../voice-convert"
import type { SyncTokenClaims } from "../auth"

const SECRET = "voice-tests-secret"
const FORGE_URL = "https://acct--voice-forge-web.modal.run/convert"
const FORGE_TOKEN = "forge-shared-secret"

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
      // R2Object exposes `size` without reading the body, and R2ObjectBody
      // exposes blob() — voice-convert uses both (AQU-1854) so the stub must too.
      return {
        size: obj.body.byteLength,
        arrayBuffer: async () => obj.body,
        blob: async () =>
          new Blob([obj.body], { type: obj.httpMetadata?.contentType ?? "audio/wav" }),
        httpMetadata: obj.httpMetadata,
      }
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

/**
 * Minimal `AquillaDb` stand-in for the per-user conversion throttle (AQU-1854).
 * It understands the one statement db/shared/rate-limit.ts issues (AQU-1843):
 * the `INSERT … ON CONFLICT DO UPDATE … RETURNING hits` upsert, whose
 * post-increment `hits` is this call's ordinal in the window. `recorded` starts
 * at `seedRecorded` so a test can place a user already at the cap without
 * firing N requests. Any other read (the AQU-1869 spend-ceiling snapshot)
 * answers with no row.
 */
function makeRateLimitDb(seedRecorded = 0) {
  const state = { recorded: seedRecorded, inserts: [] as string[] }
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const upsert = () => {
            state.recorded += 1
            state.inserts.push(String(args[0]))
            return state.recorded
          }
          return {
            async first<T>(): Promise<T | null> {
              if (!sql.includes("INTO rate_limit_counters")) return null
              return { hits: upsert() } as unknown as T
            },
            async run() {
              if (sql.includes("INTO rate_limit_counters")) upsert()
            },
          }
        },
      }
    },
  }
  return { db, state }
}

type StubEnv = {
  SNAPSHOTS: ReturnType<typeof makeStubBucket>
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  VOICE_FORGE_URL?: string
  VOICE_FORGE_TOKEN?: string
  AQUILLA_PG?: unknown
}

function makeEnv(overrides: Partial<StubEnv> = {}): StubEnv {
  return {
    SNAPSHOTS: makeStubBucket(),
    SYNC_SECRET_KEY: SECRET,
    VOICE_FORGE_URL: FORGE_URL,
    VOICE_FORGE_TOKEN: FORGE_TOKEN,
    AQUILLA_PG: makeRateLimitDb().db,
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

  it("503 when the voice forge endpoint isn't configured", async () => {
    const env = makeEnv({ VOICE_FORGE_URL: undefined, VOICE_FORGE_TOKEN: undefined })
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(503)
  })

  it("401 without a valid sync-token", async () => {
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    const res = (await call(makeEnv(), convertReq(form)))!
    expect(res.status).toBe(401)
  })

  it("403 when the token is scoped to a different project", async () => {
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    const token = await makeToken({ projectId: "other" })
    const res = (await call(makeEnv(), convertReq(form, token)))!
    expect(res.status).toBe(403)
  })

  it("400 when required fields are missing", async () => {
    const form = new FormData()
    form.append("projectId", "p1") // fileId + libraryVoiceId omitted
    const res = (await call(makeEnv(), convertReq(form, await makeToken())))!
    expect(res.status).toBe(400)
  })

  it("400 when fileId contains a path separator", async () => {
    // WHY: fileId is interpolated straight into the R2 key (audioObjectKey);
    // a `/` here would let a caller aim the write outside this file's key
    // namespace. The mint endpoint (auth-worker sync-token.ts) blocks this
    // too, but this route must not rely on that alone.
    const fileId = "../other-file"
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", fileId)
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const token = await makeToken({ fileId })
    const res = (await call(makeEnv(), convertReq(form, token)))!
    expect(res.status).toBe(400)
  })

  it("400 when projectId contains a path separator", async () => {
    const projectId = "p1/../p2"
    const form = new FormData()
    form.append("projectId", projectId)
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const token = await makeToken({ projectId })
    const res = (await call(makeEnv(), convertReq(form, token)))!
    expect(res.status).toBe(400)
  })

  it("403 when the token is viewer-role (conversion requires CONTRIBUTOR+)", async () => {
    const env = makeEnv()
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const viewerToken = await makeToken({ role: 100 })
    const res = (await call(env, convertReq(form, viewerToken)))!
    expect(res.status).toBe(403)
  })

  // AQU-2291: the voice forge is the only conversion path, so the voice is
  // mandatory — there is no reference-clip fallback any more.
  it("400 naming libraryVoiceId when no voice is sent", async () => {
    const calls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const res = (await call(makeEnv(), convertReq(form, await makeToken())))!
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/libraryVoiceId/)
    expect(calls).toHaveLength(0)
  })

  // AQU-2291: short-clip clone voices were removed. A stale client still
  // sending one is told what to do instead, and no GPU is started.
  it("400 telling the caller to train a custom voice when referenceAudioId is sent", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref1.wav"), new Uint8Array([9]), "audio/wav")
    const calls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("referenceAudioId", "ref1.wav")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(400)
    expect(await res.text()).toMatch(/clone voices were removed; train a custom voice/)
    expect(calls).toHaveLength(0)
  })

  it("converts an inline source and writes the result to R2", async () => {
    const env = makeEnv()
    const converted = new Uint8Array([5, 6, 7, 8])
    const calls = stubModal(() => new Response(converted.buffer, { status: 200 }))

    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
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
    expect(calls[0].url).toBe(FORGE_URL)
    expect((calls[0].init.headers as Record<string, string>)["X-Auth-Token"]).toBe(FORGE_TOKEN)
    const sentForm = calls[0].init.body as unknown as FormData
    expect(sentForm.get("voice_id")).toBe("narrator-hearth")
    expect(sentForm.get("source")).toBeTruthy()
    // AQU-2291: nothing Seed-VC-shaped goes upstream any more.
    expect(sentForm.get("reference")).toBeNull()
    expect(sentForm.get("diffusion_steps")).toBeNull()
  })

  it("re-voices an existing recording referenced by sourceAudioId", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "rec.webm"), new Uint8Array([4, 4]), "audio/webm")
    stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("sourceAudioId", "rec.webm")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(200)
  })

  // AQU-1109: Change voice. The client reads the voice fingerprint and the
  // cell seed back out of this id (src/lib/audio/change-voice.ts). AQU-2291:
  // no `-q<steps>-` quality stamp — that was a Seed-VC diffusion-step count.
  it("names a cellId conversion vc-<voice fingerprint>-audio-<cell>-…", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "rec.webm"), new Uint8Array([4, 4]), "audio/webm")
    stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("sourceAudioId", "rec.webm")
    form.append("cellId", "GEN 1:1")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { objectName: string; url: string }
    const fp = voiceReferenceFingerprint(libraryVoiceKey("narrator-hearth"))
    expect(body.objectName).toMatch(new RegExp(`^vc-${fp}-audio-GEN_1_1-\\d+-[0-9a-f]{8}\\.wav$`))
    expect(body.url).toBe(`frontier-audio://${body.objectName}`)
    expect(env.SNAPSHOTS._allKeys()).toContain(audioObjectKey(env, "p1", "f1", body.objectName))
  })

  it("keeps the legacy audio-clone- name when no cellId is sent", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "rec.webm"), new Uint8Array([4, 4]), "audio/webm")
    stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("sourceAudioId", "rec.webm")
    const res = (await call(env, convertReq(form, await makeToken())))!
    const body = (await res.json()) as { objectName: string }
    expect(body.objectName).toMatch(/^audio-clone-\d+-[0-9a-f]{8}\.wav$/)
  })

  it("fingerprints reference ids with FNV-1a, matching the client", () => {
    expect(voiceReferenceFingerprint("ref1.wav")).toBe("a8dcd319")
    expect(voiceReferenceFingerprint("ref-1700000000000-abc123def.webm")).toBe("4583a16c")
  })

  // [Pen test] API security & data exposure (2026-08-27): sourceAudioId is a
  // form field that lands directly in an R2 key (audioObjectKey) — it must be
  // rejected if it could act as a path separator, matching the isPathSafeId
  // check already enforced on projectId/fileId a few lines above it.
  it("rejects a sourceAudioId that could smuggle a path separator", async () => {
    const env = makeEnv()
    const modalCalls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("sourceAudioId", "../other-project/secret.webm")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(400)
    expect(modalCalls).toHaveLength(0)
  })

  it("400 when neither a source file nor sourceAudioId is given", async () => {
    const env = makeEnv()
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(400)
  })

  it("502 when the Modal endpoint errors", async () => {
    const env = makeEnv()
    stubModal(() => new Response("boom", { status: 500 }))
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(502)
  })

  // --- AQU-1854: bounded inputs, bounded rate, bounded upstream wait ----------
  //
  // Conversion holds several clips at once (source up to Modal, converted wav
  // back), so an unbounded input here is a Worker-memory failure rather than a
  // slow request, and an unbounded call rate is unmetered GPU spend. Each test below pins one of those bounds.

  function sizedBlob(bytes: number): Blob {
    return new Blob([new Uint8Array(bytes)], { type: "audio/wav" })
  }

  function baseForm(): FormData {
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    return form
  }

  it("413 for an inline source clip over MAX_VOICE_CLIP_BYTES, before calling Modal", async () => {
    const env = makeEnv()
    const modalCalls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = baseForm()
    form.append("source", sizedBlob(MAX_VOICE_CLIP_BYTES + 1), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(413)
    const body = (await res.json()) as { error: string; input: string; maxBytes: number; message: string }
    expect(body.error).toBe("audio too large")
    expect(body.maxBytes).toBe(MAX_VOICE_CLIP_BYTES)
    expect(body.message).toMatch(/too large for voice conversion/i)
    // The whole point: no GPU was started for a clip we were always going to reject.
    expect(modalCalls).toHaveLength(0)
  })

  it("413 for a stored sourceAudioId recording over the cap, without buffering it", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(
      audioObjectKey(env, "p1", "f1", "rec.webm"),
      new Uint8Array(MAX_VOICE_CLIP_BYTES + 1),
      "audio/webm",
    )
    const modalCalls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = baseForm()
    form.append("sourceAudioId", "rec.webm")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(413)
    expect(((await res.json()) as { input: string }).input).toBe("stored source recording")
    expect(modalCalls).toHaveLength(0)
  })

  it("413 on the declared Content-Length before the multipart body is parsed", async () => {
    const env = makeEnv()
    const modalCalls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))
    // No Authorization header and nothing seeded: a 413 here proves the size
    // check ran before parsing, auth, or any R2 read.
    const req = new Request("https://w/api/v1/voice/convert", {
      method: "POST",
      body: "x",
      headers: { "Content-Length": String(MAX_VOICE_CLIP_BYTES * 4) },
    })
    const res = (await call(env, req))!
    expect(res.status).toBe(413)
    expect(modalCalls).toHaveLength(0)
  })

  it("429 once the user is at the per-window conversion cap, and spends no GPU", async () => {
    const { db, state } = makeRateLimitDb(VOICE_CONVERT_MAX_PER_USER_PER_WINDOW)
    const env = makeEnv({ AQUILLA_PG: db })
    const modalCalls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = baseForm()
    form.append("source", sizedBlob(16), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(429)
    expect((await res.json()) as { error: string }).toEqual({
      error: "rate_limited",
      message: "Too many requests, slow down.",
    })
    expect(modalCalls).toHaveLength(0)
    // AQU-1843: the check and the count are one upsert, so a throttled call is
    // counted too — hammering while blocked never frees budget inside the window.
    expect(state.recorded).toBe(VOICE_CONVERT_MAX_PER_USER_PER_WINDOW + 1)
  })

  it("records one throttle event per accepted conversion, keyed by user", async () => {
    const { db, state } = makeRateLimitDb()
    const env = makeEnv({ AQUILLA_PG: db })
    stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = baseForm()
    form.append("source", sizedBlob(16), "source")
    const res = (await call(env, convertReq(form, await makeToken({ userId: 42 }))))!
    expect(res.status).toBe(200)
    expect(state.recorded).toBe(1)
    expect(state.inserts).toEqual(["voice_convert"])
  })

  it("500 rather than unmetered GPU spend when the throttle's database is unbound", async () => {
    const env = makeEnv({ AQUILLA_PG: undefined })
    const modalCalls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))

    const form = baseForm()
    form.append("source", sizedBlob(16), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(500)
    expect(modalCalls).toHaveLength(0)
  })

  it("504 when the voice forge call blows its deadline, and passes a timeout signal", async () => {
    const env = makeEnv()
    const calls = stubModal(() => {
      // What AbortSignal.timeout rejects a fetch with once the deadline passes.
      const err = new Error("The operation was aborted due to timeout")
      err.name = "TimeoutError"
      throw err
    })

    const form = baseForm()
    form.append("source", sizedBlob(16), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    // 504, not the 502 a genuinely unreachable upstream gets — the user is told
    // the request was cancelled and is retryable, not that the box is down.
    expect(res.status).toBe(504)
    expect(await res.text()).toMatch(/did not respond within 240s/)
    expect(calls).toHaveLength(1)
    expect((calls[0].init as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal)
  })

  it("keeps the voice-convert deadline under the client's own 90s..300s retry window", () => {
    expect(VOICE_CONVERT_REQUEST_TIMEOUT_MS).toBeGreaterThan(60_000)
    expect(VOICE_CONVERT_REQUEST_TIMEOUT_MS).toBeLessThan(300_000)
  })

  it("honors R2_KEY_PREFIX for the output write", async () => {
    const env = makeEnv({ R2_KEY_PREFIX: "pr-7" })
    stubModal(() => new Response(new Uint8Array([2, 2]).buffer, { status: 200 }))
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("source", new Blob([new Uint8Array([1])], { type: "audio/wav" }), "source")
    const res = (await call(env, convertReq(form, await makeToken())))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { objectName: string }
    expect(env.SNAPSHOTS._allKeys()).toContain(`pr-7/projects/p1/files/f1/audio/${body.objectName}`)
  })
})

describe("POST /api/v1/voice/convert with a library voice", () => {
  function libraryForm(extra: Record<string, string> = {}) {
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "narrator-hearth")
    form.append("sourceAudioId", "rec.webm")
    for (const [k, v] of Object.entries(extra)) form.append(k, v)
    return form
  }

  it("re-voices a recording through the voice forge with no reference clip", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "rec.webm"), new Uint8Array([4, 4]), "audio/webm")
    const calls = stubModal(() => new Response(new Uint8Array([7, 7]).buffer, { status: 200 }))

    const res = (await call(env, convertReq(libraryForm({ cellId: "c1" }), await makeToken())))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { audioId: string; objectName: string }
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(FORGE_URL)
    expect((calls[0].init.headers as Record<string, string>)["X-Auth-Token"]).toBe(FORGE_TOKEN)
    const sent = calls[0].init.body as unknown as FormData
    expect(sent.get("voice_id")).toBe("narrator-hearth")
    expect(sent.get("source")).toBeTruthy()
    expect(sent.get("reference")).toBeNull()
    // Fingerprinted over the namespaced library key, so the client can tell a
    // take made by this voice from one made by any other (including legacy
    // clone-voice takes fingerprinted over a reference clip id).
    const fp = voiceReferenceFingerprint(libraryVoiceKey("narrator-hearth"))
    expect(body.audioId.startsWith(`vc-${fp}-`)).toBe(true)
    const stored = await env.SNAPSHOTS._bytes(audioObjectKey(env, "p1", "f1", body.objectName))
    expect(stored && Array.from(stored)).toEqual([7, 7])
  })

  it("400 for a libraryVoiceId that isn't a plain voice id", async () => {
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "../../etc")
    form.append("sourceAudioId", "rec.webm")
    const res = (await call(makeEnv(), convertReq(form, await makeToken())))!
    expect(res.status).toBe(400)
  })

  it("400 when referenceAudioId rides along with a libraryVoiceId", async () => {
    const calls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))
    const res = (await call(makeEnv(), convertReq(libraryForm({ referenceAudioId: "ref1.wav" }),
      await makeToken())))!
    expect(res.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it("403 for a viewer-role token, before any GPU call", async () => {
    const calls = stubModal(() => new Response(new Uint8Array([1]).buffer, { status: 200 }))
    const res = (await call(makeEnv(), convertReq(libraryForm(), await makeToken({ role: 100 }))))!
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})

describe("GET/PUT /api/v1/voice/reference/:projectId/:referenceAudioId", () => {
  function refReq(method: "GET" | "PUT", refId: string, token?: string, body?: Uint8Array) {
    return new Request(`https://w/api/v1/voice/reference/p1/${refId}`, {
      method,
      body,
      headers: token
        ? { Authorization: `Bearer ${token}`, "Content-Type": "audio/webm" }
        : {},
    })
  }
  const callRef = (env: StubEnv, req: Request) =>
    handleVoiceReferenceRequest(req, env as unknown as Parameters<typeof handleVoiceReferenceRequest>[1])

  it("returns null for unrelated paths", async () => {
    expect(await callRef(makeEnv(), new Request("https://w/audio/p1/f1/x.webm"))).toBeNull()
  })

  it("401 without a valid token", async () => {
    const res = (await callRef(makeEnv(), refReq("PUT", "ref1.webm", undefined, new Uint8Array([1]))))!
    expect(res.status).toBe(401)
  })

  it("PUT then GET round-trips a project-scoped reference clip", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const put = (await callRef(env, refReq("PUT", "ref1.webm", token, new Uint8Array([3, 3, 3]))))!
    expect(put.status).toBe(200)
    expect(env.SNAPSHOTS._allKeys()).toContain(voiceRefObjectKey(env, "p1", "ref1.webm"))

    const get = (await callRef(env, refReq("GET", "ref1.webm", token)))!
    expect(get.status).toBe(200)
    expect(Array.from(new Uint8Array(await get.arrayBuffer()))).toEqual([3, 3, 3])
  })

  it("rejects PUT (overwrite) from a viewer-role token", async () => {
    const env = makeEnv()
    const viewerToken = await makeToken({ role: 100 })
    const res = (await callRef(env, refReq("PUT", "ref1.webm", viewerToken, new Uint8Array([3]))))!
    expect(res.status).toBe(403)
    expect(env.SNAPSHOTS._allKeys()).not.toContain(voiceRefObjectKey(env, "p1", "ref1.webm"))
  })

  it("accepts a file-scoped token (project-level auth) and 404s missing clips", async () => {
    const env = makeEnv()
    // token carries a different fileId, but project matches — project-scoped
    // auth must still allow it.
    const token = await makeToken({ fileId: "some-other-file" })
    const res = (await callRef(env, refReq("GET", "missing.webm", token)))!
    expect(res.status).toBe(404)
  })

  it("403 for a token scoped to a different project", async () => {
    const env = makeEnv()
    const token = await makeToken({ projectId: "other" })
    const res = (await callRef(env, refReq("GET", "ref1.webm", token)))!
    expect(res.status).toBe(403)
  })

  // AQU-1854: this PUT buffered the whole body with no size check — the last
  // unbounded audio write in the worker, and the one that feeds conversion.
  it("413 for a reference clip over MAX_VOICE_CLIP_BYTES", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const res = (await callRef(
      env,
      refReq("PUT", "ref-big.webm", token, new Uint8Array(MAX_VOICE_CLIP_BYTES + 1)),
    ))!
    expect(res.status).toBe(413)
    expect(((await res.json()) as { input: string }).input).toBe("reference clip")
    // Nothing was written, so the project's existing clip can't be clobbered by an
    // oversize upload that was going to be rejected anyway.
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("413 on a declared Content-Length over the cap, before buffering the body", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const req = new Request("https://w/api/v1/voice/reference/p1/ref-big.webm", {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "audio/webm",
        "Content-Length": String(MAX_VOICE_CLIP_BYTES * 4),
      },
    })
    const res = (await callRef(env, req))!
    expect(res.status).toBe(413)
    expect(env.SNAPSHOTS._allKeys()).toEqual([])
  })

  it("coerces a declared text/html Content-Type to a safe type", async () => {
    const env = makeEnv()
    const token = await makeToken()
    const put = (await callRef(
      env,
      new Request("https://w/api/v1/voice/reference/p1/evil.html", {
        method: "PUT",
        body: new TextEncoder().encode("<script>alert(1)</script>"),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/html" },
      }),
    ))!
    expect(put.status).toBe(200)

    const get = (await callRef(env, refReq("GET", "evil.html", token)))!
    expect(get.status).toBe(200)
    expect(get.headers.get("Content-Type")).toBe("application/octet-stream")
    expect(get.headers.get("X-Content-Type-Options")).toBe("nosniff")
  })
})
