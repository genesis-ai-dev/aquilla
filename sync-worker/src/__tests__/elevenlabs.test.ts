// Tests for /api/v1/elevenlabs/* — ElevenLabs as a BYOK voice engine (AQU-2299).
//
// WHY these tests matter:
//   - The user's key must reach ElevenLabs as `xi-api-key` and nowhere else:
//     never in a log line, never in an R2 object.
//   - ElevenLabs' error envelope has to land on the four failures the UI can
//     explain (bad key, out of characters, plan can't clone, rate limited).
//   - A generated clip must follow /voice/tts's storage + response contract,
//     and a converted one /voice/convert's (vc-<fingerprint>-audio-<cell>…),
//     or the client's attach and take-lineage code would not recognise them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sign } from "hono/jwt"
import { audioObjectKey } from "../audio"
import type { SyncTokenClaims } from "../auth"
import { CUSTOM_VOICE_CONSENT_VERSION } from "../custom-voice"
import { voiceRefObjectKey, voiceReferenceFingerprint } from "../voice-convert"
import { elevenLabsConsentKey, elevenLabsVoiceKey, handleElevenLabsRequest } from "../elevenlabs"
import { mapElevenLabsError } from "../elevenlabs-api"

const SECRET = "elevenlabs-tests-secret"
const KEY = "sk_test_byok_7f3a9c"
const BASE = "https://el.mock"

function makeStubBucket() {
  const store = new Map<string, { body: ArrayBuffer; contentType?: string }>()
  return {
    async get(key: string) {
      const obj = store.get(key)
      if (!obj) return null
      return {
        size: obj.body.byteLength,
        arrayBuffer: async () => obj.body,
        blob: async () => new Blob([obj.body], { type: obj.contentType ?? "audio/webm" }),
        httpMetadata: { contentType: obj.contentType },
      }
    },
    async put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }) {
      const body = typeof value === "string" ? (new TextEncoder().encode(value).buffer as ArrayBuffer) : value
      store.set(key, { body, contentType: opts?.httpMetadata?.contentType })
    },
    _seed(key: string, bytes: Uint8Array, contentType = "audio/webm") {
      store.set(key, { body: bytes.slice().buffer as ArrayBuffer, contentType })
    },
    _keys: () => Array.from(store.keys()),
    _text: (key: string) => {
      const obj = store.get(key)
      return obj ? new TextDecoder().decode(obj.body) : null
    },
    _contentType: (key: string) => store.get(key)?.contentType,
  }
}

/** Understands only the rate limiter's upsert (see voice-convert.test.ts). */
function makeRateLimitDb() {
  let hits = 0
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first<T>(): Promise<T | null> {
              if (!sql.includes("INTO rate_limit_counters")) return null
              hits += 1
              return { hits } as unknown as T
            },
          }
        },
      }
    },
  }
}

function makeEnv() {
  return {
    SNAPSHOTS: makeStubBucket(),
    SYNC_SECRET_KEY: SECRET,
    AQUILLA_PG: makeRateLimitDb(),
    ELEVENLABS_BASE_URL: BASE,
    R2_KEY_PREFIX: undefined as string | undefined,
  }
}
type Env = ReturnType<typeof makeEnv>

async function token(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: 7, projectId: "p1", fileId: "f1", role: 600, aud: "sync", iat: now, exp: now + 900, ...partial,
  }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

function call(env: Env, req: Request) {
  return handleElevenLabsRequest(req, env as unknown as Parameters<typeof handleElevenLabsRequest>[1])
}

interface UpstreamCall { url: string; method: string; headers: Headers; body: BodyInit | null | undefined }
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function stubUpstream(responder: (url: string) => Response) {
  const calls: UpstreamCall[] = []
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body })
    return responder(url)
  }) as unknown as typeof fetch
  return calls
}

const mp3 = (n = 16000) => new Uint8Array(n).fill(0xff)
const elError = (status: number, code: string) =>
  Response.json({ detail: { type: "x", code, status: code, message: code } }, { status })

/** Every console line written during the test, joined — the key must never be in it. */
let logged: string[] = []
beforeEach(() => {
  logged = []
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.name} ${a.message}` : String(a))).join(" "))
    })
  }
})

async function get(env: Env, path: string, headers: Record<string, string>) {
  return (await call(env, new Request(`https://w/api/v1/elevenlabs/${path}`, { headers })))!
}

describe("ElevenLabs reads", () => {
  it("ignores unrelated paths", async () => {
    expect(await call(makeEnv(), new Request("https://w/api/v1/voice/tts"))).toBeNull()
  })

  it("forwards the caller's key as xi-api-key and maps the subscription", async () => {
    const calls = stubUpstream(() => Response.json({
      tier: "creator", character_count: 12_340, character_limit: 100_000,
      can_use_instant_voice_cloning: true, next_character_count_reset_unix: 1_800_000_000,
    }))
    const env = makeEnv()
    const res = await get(env, "user?projectId=p1", { Authorization: `Bearer ${await token()}`, "X-ElevenLabs-Key": KEY })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      tier: "creator", characterCount: 12_340, characterLimit: 100_000, canClone: true, resetAtUnix: 1_800_000_000,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE}/v1/user/subscription`)
    expect(calls[0].headers.get("xi-api-key")).toBe(KEY)
    expect(calls[0].url).not.toContain(KEY)
  })

  it("refuses before calling upstream without a key or a sync token", async () => {
    const calls = stubUpstream(() => Response.json({}))
    const env = makeEnv()
    const noKey = await get(env, "user?projectId=p1", { Authorization: `Bearer ${await token()}` })
    expect(noKey.status).toBe(400)
    expect(((await noKey.json()) as { error: string }).error).toBe("elevenlabs_key_missing")
    const noToken = await get(env, "user?projectId=p1", { "X-ElevenLabs-Key": KEY })
    expect(noToken.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it("lists voices with search + category and normalizes rows", async () => {
    const calls = stubUpstream(() => Response.json({
      voices: [
        { voice_id: "v1", name: "Rachel", category: "premade", labels: { accent: "american", gender: "female" }, preview_url: "https://p/1.mp3", description: "calm" },
        { voice_id: "v2", name: "Fame", category: "famous", labels: {}, preview_url: null },
        { name: "no id" },
      ],
      has_more: true,
      next_page_token: "tok2",
    }))
    const res = await get(makeEnv(), "voices?projectId=p1&search=ra&category=premade", {
      Authorization: `Bearer ${await token()}`, "X-ElevenLabs-Key": KEY,
    })
    const body = (await res.json()) as { voices: { id: string; category: string }[]; nextPageToken: string | null }
    expect(body.voices.map((v) => [v.id, v.category])).toEqual([["v1", "premade"], ["v2", "premade"]])
    expect(body.nextPageToken).toBe("tok2")
    const upstreamUrl = new URL(calls[0].url)
    expect(upstreamUrl.pathname).toBe("/v2/voices")
    expect(upstreamUrl.searchParams.get("search")).toBe("ra")
    expect(upstreamUrl.searchParams.get("category")).toBe("premade")
  })

  it("offers only the curated TTS models the account has", async () => {
    stubUpstream(() => Response.json([
      { model_id: "eleven_flash_v2_5", can_do_text_to_speech: true },
      { model_id: "eleven_multilingual_v2", can_do_text_to_speech: true },
      { model_id: "eleven_multilingual_sts_v2", can_do_text_to_speech: false },
      { model_id: "eleven_monolingual_v1", can_do_text_to_speech: true },
    ]))
    const res = await get(makeEnv(), "models?projectId=p1", { Authorization: `Bearer ${await token()}`, "X-ElevenLabs-Key": KEY })
    const body = (await res.json()) as { models: { id: string }[] }
    expect(body.models.map((m) => m.id)).toEqual(["eleven_multilingual_v2", "eleven_flash_v2_5"])
  })
})

describe("mapElevenLabsError", () => {
  it("maps the envelope onto the failures the UI explains", () => {
    const cases: [number, string, "tts" | "clone", number, string][] = [
      [401, "invalid_api_key", "tts", 401, "elevenlabs_invalid_key"],
      [401, "quota_exceeded", "tts", 402, "elevenlabs_quota_exceeded"],
      [402, "insufficient_credits", "tts", 402, "elevenlabs_quota_exceeded"],
      [403, "feature_not_available", "clone", 403, "elevenlabs_clone_not_allowed"],
      [400, "can_not_use_instant_voice_cloning", "clone", 403, "elevenlabs_clone_not_allowed"],
      [429, "concurrent_limit_exceeded", "tts", 429, "elevenlabs_rate_limited"],
      [404, "voice_not_found", "tts", 404, "elevenlabs_failed"],
      [500, "internal_error", "tts", 502, "elevenlabs_failed"],
    ]
    for (const [upstream, code, context, status, mapped] of cases) {
      const err = mapElevenLabsError(upstream, JSON.stringify({ detail: { code, status: code, message: code } }), context)
      expect([err.status, err.code], `${upstream} ${code}`).toEqual([status, mapped])
    }
  })

  it("surfaces a mapped error as JSON with the same status", async () => {
    stubUpstream(() => elError(401, "invalid_api_key"))
    const res = await get(makeEnv(), "user?projectId=p1", { Authorization: `Bearer ${await token()}`, "X-ElevenLabs-Key": KEY })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe("elevenlabs_invalid_key")
    expect(logged.join("\n")).not.toContain(KEY)
  })
})

function ttsReq(body: Record<string, unknown>, tok: string, key: string | null = KEY) {
  return new Request("https://w/api/v1/elevenlabs/tts", {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...(key ? { "X-ElevenLabs-Key": key } : {}) },
    body: JSON.stringify(body),
  })
}

describe("POST /api/v1/elevenlabs/tts", () => {
  it("stores the mp3 under the file's audio path and returns the /voice/tts contract", async () => {
    const calls = stubUpstream(() => new Response(mp3(32_000), { headers: { "Content-Type": "audio/mpeg" } }))
    const env = makeEnv()
    const res = (await call(env, ttsReq({
      projectId: "p1", fileId: "f1", cellId: "c1", text: "In the beginning", voiceId: "v1",
      modelId: "eleven_flash_v2_5", languageCode: "es",
      voiceSettings: { stability: 2, similarityBoost: 0.8, style: 0.1, speed: 1.1, speakerBoost: false },
    }, await token())))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { audioId: string; objectName: string; url: string; durationSeconds: number }
    expect(body.objectName).toBe(`${body.audioId}.mp3`)
    expect(body.url).toBe(`frontier-audio://${body.objectName}`)
    expect(body.durationSeconds).toBeCloseTo(2, 5) // 32 000 bytes at 128 kbps
    const key = audioObjectKey(env, "p1", "f1", body.objectName)
    expect(env.SNAPSHOTS._keys()).toEqual([key])
    expect(env.SNAPSHOTS._contentType(key)).toBe("audio/mpeg")

    const upstreamUrl = new URL(calls[0].url)
    expect(upstreamUrl.pathname).toBe("/v1/text-to-speech/v1")
    expect(upstreamUrl.searchParams.get("output_format")).toBe("mp3_44100_128")
    expect(calls[0].headers.get("xi-api-key")).toBe(KEY)
    expect(JSON.parse(String(calls[0].body))).toEqual({
      text: "In the beginning",
      model_id: "eleven_flash_v2_5",
      language_code: "es",
      voice_settings: { stability: 1, similarity_boost: 0.8, style: 0.1, speed: 1.1, use_speaker_boost: false },
    })
    // The key is never stored or logged.
    for (const k of env.SNAPSHOTS._keys()) expect(env.SNAPSHOTS._text(k)).not.toContain(KEY)
    expect(logged.join("\n")).not.toContain(KEY)
  })

  it("preview returns the audio itself and writes nothing", async () => {
    stubUpstream(() => new Response(mp3(100)))
    const env = makeEnv()
    const res = (await call(env, ttsReq({ projectId: "p1", fileId: "f1", text: "Hello", voiceId: "v1", preview: true }, await token())))!
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg")
    expect((await res.arrayBuffer()).byteLength).toBe(100)
    expect(env.SNAPSHOTS._keys()).toEqual([])
  })

  it("passes an out-of-characters account through as 402 and stores nothing", async () => {
    stubUpstream(() => elError(401, "quota_exceeded"))
    const env = makeEnv()
    const res = (await call(env, ttsReq({ projectId: "p1", fileId: "f1", text: "Hi", voiceId: "v1" }, await token())))!
    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: string }).error).toBe("elevenlabs_quota_exceeded")
    expect(env.SNAPSHOTS._keys()).toEqual([])
  })

  it("rejects a token for another file", async () => {
    const calls = stubUpstream(() => new Response(mp3()))
    const res = (await call(makeEnv(), ttsReq({ projectId: "p1", fileId: "f2", text: "Hi", voiceId: "v1" }, await token())))!
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})

describe("POST /api/v1/elevenlabs/sts", () => {
  function stsReq(form: FormData, tok: string) {
    return new Request("https://w/api/v1/elevenlabs/sts", {
      method: "POST", body: form, headers: { Authorization: `Bearer ${tok}`, "X-ElevenLabs-Key": KEY },
    })
  }
  function stsForm(extra: Record<string, string> = {}) {
    const form = new FormData()
    for (const [k, v] of Object.entries({ projectId: "p1", fileId: "f1", cellId: "GEN 1:1", voiceId: "v9", ...extra })) form.append(k, v)
    return form
  }

  it("re-voices a stored take into a vc- take with /voice/convert's contract", async () => {
    const calls = stubUpstream(() => new Response(mp3(4000)))
    const env = makeEnv()
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "take.webm"), new Uint8Array([1, 2, 3]))
    const res = (await call(env, stsReq(stsForm({ sourceAudioId: "take.webm" }), await token())))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { audioId: string; ext: string; objectName: string; url: string; bytes: number }
    expect(elevenLabsVoiceKey("v9")).toBe("elevenlabs:v9") // mirrored by change-voice.ts voiceConversionKey
    expect(body.audioId.startsWith(`vc-${voiceReferenceFingerprint(elevenLabsVoiceKey("v9"))}-audio-GEN_1_1-`)).toBe(true)
    expect(body).toMatchObject({ ok: true, ext: "mp3", objectName: `${body.audioId}.mp3`, bytes: 4000 })
    expect(env.SNAPSHOTS._keys()).toContain(audioObjectKey(env, "p1", "f1", body.objectName))

    expect(new URL(calls[0].url).pathname).toBe("/v1/voice-changer/v9")
    const sent = calls[0].body as FormData
    expect(sent.get("model_id")).toBe("eleven_multilingual_sts_v2")
    expect(sent.get("audio")).toBeInstanceOf(Blob)
    expect(calls[0].headers.get("xi-api-key")).toBe(KEY)
  })

  it("holds the contributor floor before calling upstream", async () => {
    const calls = stubUpstream(() => new Response(mp3()))
    const env = makeEnv()
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "take.webm"), new Uint8Array([1]))
    const res = (await call(env, stsReq(stsForm({ sourceAudioId: "take.webm" }), await token({ role: 200 }))))!
    expect(res.status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})

describe("POST /api/v1/elevenlabs/clone", () => {
  function cloneReq(body: Record<string, unknown>, tok: string) {
    return new Request("https://w/api/v1/elevenlabs/clone", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", "X-ElevenLabs-Key": KEY },
      body: JSON.stringify(body),
    })
  }
  const consent = { confirmed: true, statementVersion: CUSTOM_VOICE_CONSENT_VERSION }

  it("needs the consent confirmation and the maintainer role", async () => {
    const calls = stubUpstream(() => Response.json({ voice_id: "new" }))
    const env = makeEnv()
    const base = { projectId: "p1", name: "Maria", referenceAudioIds: ["ref-1.webm"] }
    expect((await call(env, cloneReq(base, await token())))!.status).toBe(422)
    expect((await call(env, cloneReq({ ...base, consent }, await token({ role: 400 }))))!.status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it("uploads the project's reference clips as multipart and records consent", async () => {
    const calls = stubUpstream(() => Response.json({ voice_id: "cloned123", requires_verification: false }))
    const env = makeEnv()
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref-1.webm"), new Uint8Array(10))
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref-2.webm"), new Uint8Array(20))
    const res = (await call(env, cloneReq({
      projectId: "p1", name: "Maria", referenceAudioIds: ["ref-1.webm", "ref-2.webm"],
      removeBackgroundNoise: true, labels: { accent: "andalusian", favourite: "x" }, consent,
    }, await token())))!
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ voiceId: "cloned123", requiresVerification: false, statementVersion: CUSTOM_VOICE_CONSENT_VERSION })

    expect(new URL(calls[0].url).pathname).toBe("/v1/voices/add")
    const sent = calls[0].body as FormData
    expect(sent.get("name")).toBe("Maria")
    expect(sent.getAll("files")).toHaveLength(2)
    expect(sent.get("remove_background_noise")).toBe("true")
    expect(JSON.parse(String(sent.get("labels")))).toEqual({ accent: "andalusian" })

    const record = JSON.parse(env.SNAPSHOTS._text(elevenLabsConsentKey(env, "p1", "cloned123"))!) as Record<string, unknown>
    expect(record).toMatchObject({ provider: "elevenlabs", attestedByUserId: 7, referenceAudioIds: ["ref-1.webm", "ref-2.webm"] })
    expect(JSON.stringify(record)).not.toContain(KEY)
  })

  it("says the plan can't clone", async () => {
    stubUpstream(() => elError(403, "feature_not_available"))
    const env = makeEnv()
    env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", "ref-1.webm"), new Uint8Array(10))
    const res = (await call(env, cloneReq({ projectId: "p1", name: "M", referenceAudioIds: ["ref-1.webm"], consent }, await token())))!
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toBe("elevenlabs_clone_not_allowed")
  })
})
