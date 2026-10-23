// Tests for the custom (real-speaker) voice routes: consent gate, role floor,
// project scoping, one-clip-at-a-time upload to the forge, and the voice-convert
// refusal of a custom voice from another project.

import { afterEach, describe, expect, it } from "vitest"
import { sign } from "hono/jwt"
import type { SyncTokenClaims } from "../auth"
import {
  CUSTOM_VOICE_CONSENT_STATEMENT,
  CUSTOM_VOICE_CONSENT_VERSION,
  customVoiceConsentKey,
  handleCustomVoiceRequest,
} from "../custom-voice"
import { audioObjectKey } from "../audio"
import { handleVoiceConvertRequest, voiceRefObjectKey } from "../voice-convert"

const SECRET = "custom-voice-tests"
const FORGE = "https://acct--voice-forge-web.modal.run"

function makeBucket() {
  const store = new Map<string, Uint8Array>()
  return {
    async get(key: string) {
      const b = store.get(key)
      if (!b) return null
      return {
        size: b.byteLength,
        blob: async () => new Blob([b]),
        text: async () => new TextDecoder().decode(b),
        arrayBuffer: async () => b.buffer,
        httpMetadata: {},
      }
    },
    async put(key: string, value: string | ArrayBuffer) {
      store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value))
    },
    _seed(key: string, bytes: Uint8Array) { store.set(key, bytes) },
    _text(key: string) { const b = store.get(key); return b ? new TextDecoder().decode(b) : null },
  }
}

const db = {
  prepare(sql: string) {
    return {
      bind() {
        return {
          async first<T>(): Promise<T | null> {
            return (sql.includes("INTO rate_limit_counters") ? { hits: 1 } : null) as T | null
          },
          async run() {},
        }
      },
    }
  },
}

function makeEnv(over: Record<string, unknown> = {}) {
  return {
    SNAPSHOTS: makeBucket(),
    SYNC_SECRET_KEY: SECRET,
    R2_KEY_PREFIX: undefined as string | undefined,
    VOICE_FORGE_URL: `${FORGE}/convert`,
    VOICE_FORGE_TOKEN: "forge-secret",
    AQUILLA_PG: db,
    ...over,
  }
}
type Env = ReturnType<typeof makeEnv>

async function token(partial: Partial<SyncTokenClaims> = {}) {
  const now = Math.floor(Date.now() / 1000)
  return sign({ userId: 7, projectId: "p1", fileId: "f1", role: 600, aud: "sync", iat: now, exp: now + 900, ...partial } as unknown as Record<string, unknown>, SECRET, "HS256")
}

const call = (env: Env, req: Request) =>
  handleCustomVoiceRequest(req, env as unknown as Parameters<typeof handleCustomVoiceRequest>[1])

function startReq(body: unknown, tok?: string) {
  return new Request("https://w/api/v1/voice/custom/p1", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
  })
}

const consent = { confirmed: true, statementVersion: CUSTOM_VOICE_CONSENT_VERSION }

const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch })

function stubForge() {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith("/clips")) return Response.json({ seconds: 300 })
    if (url.endsWith("/train")) return Response.json({ state: "queued" })
    if (url.endsWith("/status")) return Response.json({ state: "training" })
    return new Response("nope", { status: 404 })
  }) as unknown as typeof fetch
  return calls
}

function seedRefs(env: Env, ...ids: string[]) {
  for (const id of ids) env.SNAPSHOTS._seed(voiceRefObjectKey(env, "p1", id), new Uint8Array([1, 2, 3]))
}

describe("POST /api/v1/voice/custom/:projectId", () => {
  it("refuses to train without the org's consent confirmation, and says what to confirm", async () => {
    const env = makeEnv()
    seedRefs(env, "ref-a.webm")
    const calls = stubForge()
    const res = (await call(env, startReq({ speakerName: "Ana", referenceAudioIds: ["ref-a.webm"] }, await token())))!
    expect(res.status).toBe(422)
    const body = (await res.json()) as { statement: string; statementVersion: string }
    expect(body.statement).toBe(CUSTOM_VOICE_CONSENT_STATEMENT)
    expect(body.statement).toMatch(/organization, not Aquilla, is responsible/)
    expect(calls).toHaveLength(0)
  })

  it("refuses an outdated consent statement version", async () => {
    const env = makeEnv()
    seedRefs(env, "ref-a.webm")
    const res = (await call(env, startReq({
      speakerName: "Ana", referenceAudioIds: ["ref-a.webm"], consent: { confirmed: true, statementVersion: "2020-01-01" },
    }, await token())))!
    expect(res.status).toBe(422)
  })

  it("requires maintainer role", async () => {
    const env = makeEnv()
    seedRefs(env, "ref-a.webm")
    const res = (await call(env, startReq({ speakerName: "Ana", referenceAudioIds: ["ref-a.webm"], consent }, await token({ role: 400 }))))!
    expect(res.status).toBe(403)
  })

  it("records consent first, then uploads each recording separately and starts training", async () => {
    const env = makeEnv()
    seedRefs(env, "ref-a.webm", "ref-b.webm")
    const calls = stubForge()
    const res = (await call(env, startReq({ speakerName: " Ana Lima ", referenceAudioIds: ["ref-a.webm", "ref-b.webm"], consent }, await token())))!
    expect(res.status).toBe(200)
    const body = (await res.json()) as { voiceId: string; state: string; audioMinutes: number }
    expect(body.voiceId).toMatch(/^c-[a-f0-9]{16}$/)
    expect(body.state).toBe("queued")
    expect(body.audioMinutes).toBe(10)

    const record = JSON.parse(env.SNAPSHOTS._text(customVoiceConsentKey(env, "p1", body.voiceId))!)
    expect(record).toMatchObject({
      voiceId: body.voiceId, projectId: "p1", speakerName: "Ana Lima", attestedByUserId: 7,
      statementVersion: CUSTOM_VOICE_CONSENT_VERSION, referenceAudioIds: ["ref-a.webm", "ref-b.webm"],
    })
    expect(calls.map((c) => c.url)).toEqual([
      `${FORGE}/voices/${body.voiceId}/clips`,
      `${FORGE}/voices/${body.voiceId}/clips`,
      `${FORGE}/voices/${body.voiceId}/train`,
    ])
    expect((calls[0].init!.headers as Record<string, string>)["X-Auth-Token"]).toBe("forge-secret")
    expect((calls[1].init!.body as FormData).get("index")).toBe("1")
  })

  it("404s a recording that isn't in this project, before billing or uploading", async () => {
    const env = makeEnv()
    const calls = stubForge()
    const res = (await call(env, startReq({ speakerName: "Ana", referenceAudioIds: ["missing.webm"], consent }, await token())))!
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
  })

  it("503 when the voice forge isn't configured", async () => {
    const env = makeEnv({ VOICE_FORGE_URL: undefined })
    const res = (await call(env, startReq({ speakerName: "Ana", referenceAudioIds: ["a.webm"], consent }, await token())))!
    expect(res.status).toBe(503)
  })
})

describe("custom voice status and project scoping", () => {
  it("serves status only for a voice trained in this project", async () => {
    const env = makeEnv()
    stubForge()
    env.SNAPSHOTS._seed(customVoiceConsentKey(env, "p1", "c-0123456789abcdef"), new TextEncoder().encode("{}"))
    const ok = (await call(env, new Request("https://w/api/v1/voice/custom/p1/c-0123456789abcdef/status", {
      headers: { Authorization: `Bearer ${await token({ role: 100 })}` },
    })))!
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ state: "training" })

    const other = (await call(env, new Request("https://w/api/v1/voice/custom/p2/c-0123456789abcdef/status", {
      headers: { Authorization: `Bearer ${await token({ projectId: "p2", role: 600 })}` },
    })))!
    expect(other.status).toBe(404)
  })

  it("voice-convert refuses another project's custom voice before any GPU call", async () => {
    const env = makeEnv()
    env.SNAPSHOTS._seed(customVoiceConsentKey(env, "p-owner", "c-0123456789abcdef"), new TextEncoder().encode("{}"))
    env.SNAPSHOTS._seed(audioObjectKey(env, "p1", "f1", "rec.webm"), new Uint8Array([4]))
    const calls = stubForge()
    const form = new FormData()
    form.append("projectId", "p1")
    form.append("fileId", "f1")
    form.append("libraryVoiceId", "c-0123456789abcdef")
    form.append("sourceAudioId", "rec.webm")
    const res = (await handleVoiceConvertRequest(
      new Request("https://w/api/v1/voice/convert", { method: "POST", body: form, headers: { Authorization: `Bearer ${await token()}` } }),
      env as unknown as Parameters<typeof handleVoiceConvertRequest>[1],
    ))!
    expect(res.status).toBe(404)
    expect(calls).toHaveLength(0)
  })
})
