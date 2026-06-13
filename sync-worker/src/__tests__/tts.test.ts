// Tests for POST /api/v1/voice/tts — intent-encoding per Rule 9.
//
// WHY these tests matter:
//   - The route holds the Modal secret; a bad token must never reach GPU.
//   - The X-Audio-Duration-Seconds header is the metering unit — misreading it
//     means the budget counter is wrong (either too lenient or too strict).
//   - The WAV must land in R2 under the file's audio path so the returned
//     audioId is a valid R2 key the client can attach or pass to /voice/convert.
//   - A Modal failure must NOT record any seconds; recording on failure would
//     wrongly drain the user's budget for audio they never received.

import { describe, it, expect, afterEach } from "vitest"
import { sign } from "hono/jwt"
import { audioObjectKey } from "../audio"
import { handleTtsRequest } from "../tts"
import type { SyncTokenClaims } from "../auth"

const SECRET = "tts-tests-secret"
const OMNIVOICE_URL = "https://acct--omnivoice-web.modal.run"
const OMNIVOICE_TOKEN = "omnivoice-shared-secret"

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
              // Bind params: (user_id, org_id, date_utc, audio_seconds)
              // request_count is a literal 1 in the SQL — NOT a bind param.
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
  OMNIVOICE_URL?: string
  OMNIVOICE_TOKEN?: string
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
    OMNIVOICE_URL: OMNIVOICE_URL,
    OMNIVOICE_TOKEN: OMNIVOICE_TOKEN,
    AQUILLA_PG: dbStub,
    ...overrides,
  }
}

// ── Token helpers ────────────────────────────────────────────────────────────

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

// ── Modal fetch stub ─────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

interface ModalCallRecord {
  url: string
  headers: Record<string, string>
  body: FormData
}

function stubModal(
  wavBytes: Uint8Array,
  durationSeconds: number,
  status = 200,
): ModalCallRecord[] {
  const calls: ModalCallRecord[] = []
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: url as string,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body as FormData,
    })
    if (status !== 200) {
      return new Response("modal error", { status })
    }
    return new Response(wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength) as ArrayBuffer, {
      status: 200,
      headers: { "X-Audio-Duration-Seconds": String(durationSeconds) },
    })
  }) as unknown as typeof fetch
  return calls
}

// ── Request builder ──────────────────────────────────────────────────────────

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

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/v1/voice/tts", () => {
  it("returns null for unrelated paths", async () => {
    const { db } = makeStubDb()
    const res = await call(makeEnv(db), new Request("https://w/audio/p1/f1/x.wav"))
    expect(res).toBeNull()
  })

  it("503 when OmniVoice endpoint is not configured", async () => {
    const { db } = makeStubDb()
    const env = makeEnv(db, { OMNIVOICE_URL: undefined, OMNIVOICE_TOKEN: undefined })
    const res = (await call(env, ttsReq({ projectId: "p1", fileId: "f1", text: "hello" }, await makeToken())))!
    expect(res.status).toBe(503)
  })

  it("401 without a valid sync-token", async () => {
    // WHY: the Modal secret must never be exposed to an unauthenticated caller
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
    // text is missing
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1" }, token)))!
    expect(res.status).toBe(400)
  })

  it("calls Modal with X-Auth-Token and sends text; writes WAV to R2; returns audioId + durationSeconds", async () => {
    // WHY: this is the core happy-path contract — the returned audioId must be
    // a valid R2 key (for cell attachment) and durationSeconds must reflect the
    // actual audio length (for budget metering)
    const { db } = makeStubDb()
    const env = makeEnv(db)
    const wav = new Uint8Array([82, 73, 70, 70]) // "RIFF"
    const calls = stubModal(wav, 7.5)
    const token = await makeToken()

    const res = (await call(env, ttsReq({ projectId: "p1", fileId: "f1", text: "Hello world" }, token)))!
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      audioId: string
      durationSeconds: number
      objectName: string
      url: string
    }
    expect(body.audioId).toMatch(/^audio-tts-/)
    expect(body.durationSeconds).toBe(7.5)
    expect(body.url).toBe(`frontier-audio://${body.objectName}`)

    // Modal was called correctly.
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${OMNIVOICE_URL}/synthesize`)
    expect(calls[0].headers["X-Auth-Token"]).toBe(OMNIVOICE_TOKEN)

    // WAV landed in R2 under the file-scoped audio path.
    const stored = await env.SNAPSHOTS._bytes(audioObjectKey(env, "p1", "f1", body.objectName))
    expect(stored && Array.from(stored)).toEqual([82, 73, 70, 70])
  })

  it("parses X-Audio-Duration-Seconds header correctly", async () => {
    // WHY: this header is the sole source of the metering unit; a missing or
    // misread header would silently corrupt the user's budget counter
    const { db } = makeStubDb()
    stubModal(new Uint8Array([1, 2]), 123.456)
    const token = await makeToken()
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "test" }, token)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { durationSeconds: number }
    expect(body.durationSeconds).toBeCloseTo(123.456)
  })

  it("records durationSeconds to the budget counter after success", async () => {
    // WHY: if seconds aren't recorded, the budget guard never accumulates and
    // a user could generate unlimited audio
    const { db, usageRows } = makeStubDb()
    stubModal(new Uint8Array([1]), 30)
    const token = await makeToken()
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "go" }, token)))!
    expect(res.status).toBe(200)
    const userRow = usageRows.find((r) => r.user_id === 1 && r.org_id !== 0)
    expect(userRow?.audio_seconds).toBeCloseTo(30)
  })

  it("records seconds to the global sentinel row (user_id=0, org_id=0)", async () => {
    // WHY: the sentinel gives an O(1) platform total; missing it means ops
    // can't see platform-wide TTS spend
    const { db, usageRows } = makeStubDb()
    stubModal(new Uint8Array([1]), 15)
    const token = await makeToken()
    await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "hi" }, token))
    const sentinel = usageRows.find((r) => r.user_id === 0 && r.org_id === 0)
    expect(sentinel?.audio_seconds).toBeCloseTo(15)
  })

  it("records 0 seconds when X-Audio-Duration-Seconds header is absent", async () => {
    // WHY: an absent header (Modal bug or old version) must degrade to 0, not NaN
    const { db, usageRows } = makeStubDb()
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([1]).buffer, { status: 200 })) as unknown as typeof fetch
    const token = await makeToken()
    await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "x" }, token))
    const userRow = usageRows.find((r) => r.user_id === 1)
    expect(userRow?.audio_seconds ?? 0).toBe(0)
  })

  it("does NOT record any seconds on a Modal failure (502)", async () => {
    // WHY: recording seconds for failed syntheses would drain the user's budget
    // for audio they never received — a subtle correctness bug
    const { db, usageRows } = makeStubDb()
    stubModal(new Uint8Array([1]), 30, 500)
    const token = await makeToken()
    const res = (await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "fail" }, token)))!
    expect(res.status).toBe(502)
    // No usage rows should have been written.
    expect(usageRows).toHaveLength(0)
  })

  it("attributes recorded seconds to the project's org_id", async () => {
    // WHY: org_id attribution is what powers the org Overview dashboard;
    // wrong org_id means the wrong org sees the usage
    const { db, usageRows } = makeStubDb(42) // org 42
    stubModal(new Uint8Array([1]), 20)
    const token = await makeToken()
    await call(makeEnv(db), ttsReq({ projectId: "p1", fileId: "f1", text: "org test" }, token))
    const userRow = usageRows.find((r) => r.user_id === 1 && r.org_id !== 0)
    expect(userRow?.org_id).toBe(42)
  })

  it("honors R2_KEY_PREFIX for the output audio write", async () => {
    const { db } = makeStubDb()
    const env = makeEnv(db, { SNAPSHOTS: makeStubBucket(), R2_KEY_PREFIX: "pr-99" })
    stubModal(new Uint8Array([7, 8]), 5)
    const token = await makeToken()
    const res = (await call(env, ttsReq({ projectId: "p1", fileId: "f1", text: "prefix" }, token)))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { objectName: string }
    expect(env.SNAPSHOTS._allKeys()).toContain(`pr-99/projects/p1/files/f1/audio/${body.objectName}`)
  })

  it("resolves a referenceAudioId from R2 and sends it to Modal as voice_ref", async () => {
    // WHY: voice-cloned TTS requires the reference clip to reach Modal;
    // a missing reference means the output won't sound like the target voice
    const { db } = makeStubDb()
    const env = makeEnv(db)
    const refBytes = new Uint8Array([9, 9, 9])
    const refKey = `projects/p1/voices/ref1.wav`
    env.SNAPSHOTS._seed(refKey, refBytes, "audio/wav")
    const calls = stubModal(new Uint8Array([1]), 5)
    const token = await makeToken()

    const res = (await call(
      env,
      ttsReq({ projectId: "p1", fileId: "f1", text: "cloned", referenceAudioId: "ref1.wav" }, token),
    ))!
    expect(res.status).toBe(200)

    // Modal must have received a voice_ref field.
    const sentForm = calls[0].body as FormData
    expect(sentForm.get("voice_ref")).toBeTruthy()
  })

  it("404 when referenceAudioId is given but the clip is absent from R2", async () => {
    const { db } = makeStubDb()
    stubModal(new Uint8Array([1]), 5)
    const token = await makeToken()
    const res = (await call(
      makeEnv(db),
      ttsReq({ projectId: "p1", fileId: "f1", text: "missing ref", referenceAudioId: "gone.wav" }, token),
    ))!
    expect(res.status).toBe(404)
  })
})
