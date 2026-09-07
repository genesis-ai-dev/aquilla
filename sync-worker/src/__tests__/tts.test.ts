// Tests for POST /api/v1/voice/tts — Inworld TTS 2 Flash (AQU-1189).
//
// WHY these tests matter:
//   - The route holds the Inworld API key; a bad token must never reach Inworld.
//   - WAV duration is the metering unit — misreading it means the budget
//     counter is wrong (either too lenient or too strict).
//   - The WAV must land in R2 under the file's audio path so the returned
//     audioId is a valid R2 key the client can attach or pass to /voice/convert.
//   - An Inworld failure must NOT record any seconds; recording on failure
//     would wrongly drain the user's budget for audio they never received.

import { describe, it, expect, afterEach } from "vitest"
import { sign } from "hono/jwt"
import { audioObjectKey } from "../audio"
import { handleTtsRequest } from "../tts"
import { bytesToBase64 } from "../inworld-tts"
import type { SyncTokenClaims } from "../auth"

const SECRET = "tts-tests-secret"
const INWORLD_API_KEY = "dGVzdDprZXk=" // base64("test:key")
const INWORLD_API_BASE = "https://api.inworld.ai"

function makeWav(durationSeconds: number, sampleRate = 24000): Uint8Array {
  const samples = Math.max(1, Math.round(durationSeconds * sampleRate))
  const dataSize = samples * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  write(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  write(8, "WAVE")
  write(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, "data")
  view.setUint32(40, dataSize, true)
  return new Uint8Array(buf)
}

// ── Stub R2 bucket (mirrors voice-convert.test.ts) ───────────────────────────

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
      return {
        arrayBuffer: async () => obj.body,
        text: async () => new TextDecoder().decode(obj.body),
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

// ── Minimal AquillaDb stub ───────────────────────────────────────────────────

interface UsageRow {
  user_id: number
  org_id: number
  date_utc: string
  request_count: number
  audio_seconds: number
}

function makeStubDb(projectOrgId: number | null = 5) {
  const usageRows: UsageRow[] = []

  return {
    db: {
      prepare(sql: string) {
        let boundArgs: unknown[] = []
        const stmt = {
          bind(...args: unknown[]) {
            boundArgs = args
            return stmt
          },
          async first<T = unknown>(): Promise<T | null> {
            if (sql.includes("FROM projects")) {
              return (projectOrgId != null ? { org_id: projectOrgId } : null) as unknown as T
            }
            if (sql.includes("SUM(audio_seconds)")) {
              const [userId, dateUtc] = boundArgs as [number, string]
              const total = usageRows
                .filter((r) => r.user_id === userId && r.date_utc === dateUtc)
                .reduce((s, r) => s + r.audio_seconds, 0)
              return { total_seconds: total } as unknown as T
            }
            return null
          },
          async run() {
            if (sql.includes("INSERT INTO tts_usage_daily")) {
              const [userId, orgId, dateUtc, audioSeconds] = boundArgs as [
                number,
                number,
                string,
                number,
              ]
              const existing = usageRows.find(
                (r) => r.user_id === userId && r.org_id === orgId && r.date_utc === dateUtc,
              )
              if (existing) {
                existing.request_count += 1
                existing.audio_seconds += audioSeconds
              } else {
                usageRows.push({
                  user_id: userId,
                  org_id: orgId,
                  date_utc: dateUtc,
                  request_count: 1,
                  audio_seconds: audioSeconds,
                })
              }
            }
            return { results: [], success: true as const, meta: {} as never }
          },
          async all() {
            return { results: [], success: true as const, meta: {} as never }
          },
          async raw() {
            return []
          },
        }
        return stmt
      },
      async batch() {
        return []
      },
      async exec() {
        return { count: 0, duration: 0 }
      },
      async close() {},
    } as unknown as AquillaDb,
    usageRows,
  }
}

// ── Env builder ──────────────────────────────────────────────────────────────

type StubEnv = {
  SNAPSHOTS: ReturnType<typeof makeStubBucket>
  SYNC_SECRET_KEY?: string
  R2_KEY_PREFIX?: string
  INWORLD_API_KEY?: string
  INWORLD_API_BASE?: string
  INWORLD_TTS_MODEL?: string
  INWORLD_DEFAULT_VOICE?: string
  TTS_USER_DAILY_SECONDS_LIMIT?: string
  TTS_BUDGET_ENFORCE?: string
  AQUILLA_PG?: AquillaDb
}

function makeEnv(
  dbStub: AquillaDb,
  overrides: Partial<StubEnv> = {},
): StubEnv {
  return {
    SNAPSHOTS: makeStubBucket(),
    SYNC_SECRET_KEY: SECRET,
    INWORLD_API_KEY,
    INWORLD_API_BASE,
    AQUILLA_PG: dbStub,
    ...overrides,
  }
}

async function makeToken(
  partial: Partial<SyncTokenClaims> = {},
  secret = SECRET,
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

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

interface InworldCallRecord {
  url: string
  headers: Record<string, string>
  body: unknown
}

function stubInworld(opts: {
  wav: Uint8Array
  status?: number
  cloneVoiceId?: string
  cloneStatus?: number
}): InworldCallRecord[] {
  const calls: InworldCallRecord[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const bodyText = typeof init.body === "string" ? init.body : ""
    calls.push({
      url: url as string,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: bodyText ? JSON.parse(bodyText) : init.body,
    })
    const path = String(url)
    if (path.includes("voices:clone")) {
      if (opts.cloneStatus && opts.cloneStatus !== 200) {
        return new Response("clone error", { status: opts.cloneStatus })
      }
      return Response.json({ voice: { voiceId: opts.cloneVoiceId ?? "cloned-1" } })
    }
    if (opts.status && opts.status !== 200) {
      return new Response("inworld error", { status: opts.status })
    }
    return Response.json({ audioContent: bytesToBase64(opts.wav.buffer as ArrayBuffer) })
  }) as unknown as typeof fetch
  return calls
}

function ttsReq(
  body: Record<string, unknown>,
  token?: string,
): Request {
  return new Request("https://w/api/v1/voice/tts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  })
}

function call(env: StubEnv, req: Request) {
  return handleTtsRequest(req, env as unknown as Parameters<typeof handleTtsRequest>[1])
}

describe("POST /api/v1/voice/tts", () => {
  it("returns null for unrelated paths", async () => {
    const { db } = makeStubDb()
    const res = await call(makeEnv(db), new Request("https://w/audio/p1/f1/x.wav"))
    expect(res).toBeNull()
  })

  it("503 when Inworld API key is not configured", async () => {
    const { db } = makeStubDb()
    const env = makeEnv(db, { INWORLD_API_KEY: undefined })
    const res = (await call(env, ttsReq({ projectId: "p1", fileId: "f1", text: "hello" }, await makeToken())))!
    expect(res.status).toBe(503)
  })

  it("401 without a valid sync-token", async () => {
    const { db } = makeStubDb()
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "hello" })))!
    expect(res.status).toBe(401)
  })

  it("403 when the token fileId doesn't match the request", async () => {
    const { db } = makeStubDb()
    const token = await makeToken({ fileId: "other-file" })
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "hi" }, token)))!
    expect(res.status).toBe(403)
  })

  it("403 when the token projectId doesn't match the request", async () => {
    const { db } = makeStubDb()
    const token = await makeToken({ projectId: "other-project" })
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "hi" }, token)))!
    expect(res.status).toBe(403)
  })

  it("400 when required fields are missing", async () => {
    const { db } = makeStubDb()
    const token = await makeToken()
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1" }, token)))!
    expect(res.status).toBe(400)
  })

  it("400 when fileId contains a path separator", async () => {
    const { db } = makeStubDb()
    const fileId = "../other-file"
    const token = await makeToken({ fileId })
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId, text: "hi" }, token)))!
    expect(res.status).toBe(400)
  })

  it("400 when projectId contains a path separator", async () => {
    const { db } = makeStubDb()
    const projectId = "p1/../p2"
    const token = await makeToken({ projectId })
    const res = (await call(makeEnv(db), ttsReq({ projectId, fileId: "f1", text: "hi" }, token)))!
    expect(res.status).toBe(400)
  })

  it("calls Inworld with Basic auth and model inworld-tts-2-flash; writes WAV to R2", async () => {
    const { db } = makeStubDb()
    const env = makeEnv(db)
    const wav = makeWav(1)
    const calls = stubInworld({ wav })
    const token = await makeToken()

    const res = (await call(env, ttsReq({ projectId: "p1", fileId: "f1", text: "Hello world", voiceId: "Sarah" }, token)))!
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      audioId: string
      durationSeconds: number
      objectName: string
      url: string
    }
    expect(body.audioId).toMatch(/^audio-tts-/)
    expect(body.durationSeconds).toBeCloseTo(1, 5)
    expect(body.url).toBe(`frontier-audio://${body.objectName}`)

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${INWORLD_API_BASE}/tts/v1/voice`)
    expect(calls[0].headers.Authorization).toBe(`Basic ${INWORLD_API_KEY}`)
    expect(calls[0].body).toEqual(expect.objectContaining({
      text: "Hello world",
      voiceId: "Sarah",
      modelId: "inworld-tts-2-flash",
    }))

    const stored = await env.SNAPSHOTS._bytes(audioObjectKey(env, "p1", "f1", body.objectName))
    expect(stored && stored.byteLength).toBe(wav.byteLength)
  })

  it("records durationSeconds to the budget counter after success", async () => {
    const { db, usageRows } = makeStubDb()
    stubInworld({ wav: makeWav(2) })
    const token = await makeToken()
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "go" }, token)))!
    expect(res.status).toBe(200)
    const userRow = usageRows.find((r) => r.user_id === 1 && r.org_id !== 0)
    expect(userRow?.audio_seconds).toBeCloseTo(2)
  })

  it("records seconds to the global sentinel row (user_id=0, org_id=0)", async () => {
    const { db, usageRows } = makeStubDb()
    stubInworld({ wav: makeWav(1) })
    const token = await makeToken()
    await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "hi" }, token))
    const sentinel = usageRows.find((r) => r.user_id === 0 && r.org_id === 0)
    expect(sentinel?.audio_seconds).toBeCloseTo(1)
  })

  it("does NOT record any seconds on an Inworld failure (502)", async () => {
    const { db, usageRows } = makeStubDb()
    stubInworld({ wav: makeWav(1), status: 500 })
    const token = await makeToken()
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "fail" }, token)))!
    expect(res.status).toBe(502)
    expect(usageRows).toHaveLength(0)
  })

  it("attributes recorded seconds to the project's org_id", async () => {
    const { db, usageRows } = makeStubDb(42)
    stubInworld({ wav: makeWav(1) })
    const token = await makeToken()
    await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "org test" }, token))
    const userRow = usageRows.find((r) => r.user_id === 1 && r.org_id !== 0)
    expect(userRow?.org_id).toBe(42)
  })

  it("honors R2_KEY_PREFIX for the output audio write", async () => {
    const { db } = makeStubDb()
    const env = makeEnv(db, { SNAPSHOTS: makeStubBucket(), R2_KEY_PREFIX: "pr-99" })
    stubInworld({ wav: makeWav(1) })
    const token = await makeToken()
    const res = (await call(env, ttsReq({ projectId: "p1", fileId: "f1", text: "prefix" }, token)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { objectName: string }
    expect(env.SNAPSHOTS._allKeys()).toContain(`pr-99/projects/p1/files/f1/audio/${body.objectName}`)
  })

  it("clones from referenceAudioId then synthesizes with the cloned voiceId", async () => {
    const { db } = makeStubDb()
    const env = makeEnv(db)
    const refBytes = new Uint8Array([9, 9, 9])
    env.SNAPSHOTS._seed("projects/p1/voices/ref1.wav", refBytes, "audio/wav")
    const calls = stubInworld({ wav: makeWav(1), cloneVoiceId: "ws__ref_clone" })
    const token = await makeToken()

    const res = (await call(
      env,
      ttsReq({ projectId: "p1", fileId: "f1", text: "cloned", referenceAudioId: "ref1.wav" }, token),
    ))!
    expect(res.status).toBe(200)
    expect(calls.map((c) => c.url)).toEqual([
      `${INWORLD_API_BASE}/voices/v1/voices:clone`,
      `${INWORLD_API_BASE}/tts/v1/voice`,
    ])
    expect((calls[1].body as { voiceId: string }).voiceId).toBe("ws__ref_clone")
    expect(env.SNAPSHOTS._allKeys()).toContain("projects/p1/voices/ref1.wav.inworld.json")
  })

  it("reuses a cached Inworld clone id and does not clone again", async () => {
    const { db } = makeStubDb()
    const env = makeEnv(db)
    env.SNAPSHOTS._seed(
      "projects/p1/voices/ref1.wav.inworld.json",
      new TextEncoder().encode(JSON.stringify({ voiceId: "cached-voice" })),
      "application/json",
    )
    const calls = stubInworld({ wav: makeWav(1) })
    const token = await makeToken()
    const res = (await call(
      env,
      ttsReq({ projectId: "p1", fileId: "f1", text: "cached", referenceAudioId: "ref1.wav" }, token),
    ))!
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${INWORLD_API_BASE}/tts/v1/voice`)
    expect((calls[0].body as { voiceId: string }).voiceId).toBe("cached-voice")
  })

  it("404 when referenceAudioId is given but the clip is absent from R2", async () => {
    const { db } = makeStubDb()
    stubInworld({ wav: makeWav(1) })
    const token = await makeToken()
    const res = (await call(
      makeEnv(db),
      ttsReq({ projectId: "p1", fileId: "f1", text: "missing ref", referenceAudioId: "gone.wav" }, token),
    ))!
    expect(res.status).toBe(404)
  })
})
