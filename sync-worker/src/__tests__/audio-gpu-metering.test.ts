// AQU-2065 (unified billing T8): TTS, voice design/publish, diarization and
// voice-convert go through checkAiEntitlement.
//
// WHY these tests matter:
//   - Shadow mode is two weeks of evidence for enforcement (spec §5.4, Q12).
//     A path that writes no row in shadow is invisible to that evidence, so
//     each path must leave exactly one row, and it must carry the cost we
//     measured (characters sent, GPU seconds), not a flat guess. TTS used to
//     record a flat 2¢ per call; the others recorded nothing at all.
//   - Diarization is async: the reservation is made at /start and must be
//     settled by the callback, or every job would count at its worst case.
//   - Enforce must refuse a GPU job BEFORE Modal starts: a refusal after the
//     container is up costs the money it was meant to save.
//   - Off must write nothing, so deploying this changes nothing until T13.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { sign } from "hono/jwt"
import type { SyncTokenClaims } from "../auth"
import { handleTtsRequest, type TtsEnv } from "../tts"
import { handleDiarizationRequest, type DiarizationEnv, DIARIZATION_MAX_GPU_SECONDS } from "../diarization"
import { handleVoiceConvertRequest, voiceRefObjectKey, type VoiceConvertEnv } from "../voice-convert"
import { bytesToBase64, INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT } from "../inworld-tts"
import { __resetAiSpendCeilingStateForTests } from "../../../db/shared/ai-spend-ceiling"
import {
  DIARIZATION_GPU, inworldTtsRawCents, modalGpuRawCents, VOICE_CONVERT_GPU,
} from "../../../db/shared/audio-price-card"
import { resolveOrgPlan } from "../../../db/shared/org-plan"
import { makeTestDb, type TestDb } from "./helpers/pg-test-db"

const SECRET = "metering-tests-secret"
const ORG = 1
let t: TestDb

// Loading the whole schema into PGlite is slow on a busy machine.
beforeAll(async () => {
  t = await makeTestDb()
}, 120_000)
afterAll(async () => {
  await t.close()
})
beforeEach(async () => {
  await t.reset()
  __resetAiSpendCeilingStateForTests()
  await t.pg.exec(`INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'a@x', 'x');
    INSERT INTO organizations (id, name, owner_user_id) VALUES (${ORG}, 'o', 1);
    INSERT INTO projects (id, name, org_id, created_by) VALUES ('p1', 'P', ${ORG}, 1)`)
})
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

interface UsageRow {
  request_id: string; rail: string; mode: string; decision: string; state: string
  raw_micro_cents: string | null; reserved_micro_units: string; multiplier: number
}
const usageRows = () => t.rows<UsageRow>("workspace_usage_requests")
/** The settled raw cost of a row, in cents. The ledger stores whole
 *  micro-cents, so compare against the card with a 1e-6¢ tolerance. */
const rawCents = (row: UsageRow) => Number(row.raw_micro_cents) / 1_000_000
/** The reservation a row was admitted with, in raw cents. */
const reservedCents = (row: UsageRow) => Number(row.reserved_micro_units) / row.multiplier / 1_000_000

async function token(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: 1, projectId: "p1", fileId: "f1", role: 400, aud: "sync", iat: now, exp: now + 900, ...partial,
  }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

function bucket() {
  const store = new Map<string, ArrayBuffer>()
  return {
    async get(key: string) {
      const body = store.get(key)
      if (!body) return null
      return {
        size: body.byteLength, body,
        arrayBuffer: async () => body,
        text: async () => new TextDecoder().decode(body),
        blob: async () => new Blob([body], { type: "audio/wav" }),
        httpMetadata: { contentType: "audio/wav" },
      }
    },
    async put(key: string, value: ArrayBuffer | string) {
      store.set(key, typeof value === "string" ? new TextEncoder().encode(value).buffer as ArrayBuffer : value)
    },
  }
}

function wav(seconds: number): ArrayBuffer {
  const dataSize = Math.round(seconds * 24000) * 2
  const buf = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buf)
  const write = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
  write(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); write(8, "WAVE"); write(12, "fmt ")
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true)
  view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, dataSize, true)
  return buf
}

const json = (body: unknown, auth: string) => ({
  method: "POST", body: JSON.stringify(body),
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth}` },
})

// ── TTS (Inworld) ────────────────────────────────────────────────────────────

function ttsEnv(mode: string): TtsEnv {
  return {
    SNAPSHOTS: bucket() as unknown as R2Bucket, SYNC_SECRET_KEY: SECRET, INWORLD_API_KEY: "inworld-house",
    AQUILLA_PG: t.db, ENVIRONMENT: "test", BILLING_METER_MODE: mode,
  }
}

function stubInworld() {
  const calls: string[] = []
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url))
    if (String(url).includes("voices:design")) {
      return Response.json({ previewVoices: [{ voiceId: "ws__v1", previewText: "Hi", previewAudio: "UklGRQ==" }] })
    }
    if (String(url).includes(":publish")) return Response.json({ voice: { voiceId: "ws__v1" } })
    return Response.json({ audioContent: bytesToBase64(wav(2)) })
  }) as unknown as typeof fetch
  return calls
}

describe("TTS synthesis (#13)", () => {
  it("shadow: one settled tts row, priced by the characters sent at the model used", async () => {
    stubInworld()
    const text = "In the beginning was the Word.".repeat(10)
    const res = (await handleTtsRequest(new Request("https://w/api/v1/voice/tts",
      json({ projectId: "p1", fileId: "f1", text, audioQuality: "standard" }, await token())), ttsEnv("shadow")))!
    expect(res.status).toBe(200)

    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rail: "tts", mode: "metered", decision: "allow", state: "settled" })
    // Flash ("standard") is cheaper than the dearest-rate bound it reserved.
    expect(rawCents(rows[0])).toBeCloseTo(inworldTtsRawCents(text.length, "inworld-tts-2-flash"), 6)
    expect(reservedCents(rows[0])).toBeCloseTo(inworldTtsRawCents(text.length), 6)
    // Never both ledgers: the platform ceiling sums them.
    expect(await t.rows("org_credit_usage_daily")).toHaveLength(0)
  })

  it("off: no meter row; the legacy credit ledger still gets the measured cost", async () => {
    stubInworld()
    const res = (await handleTtsRequest(new Request("https://w/api/v1/voice/tts",
      json({ projectId: "p1", fileId: "f1", text: "hello" }, await token())), ttsEnv("off")))!
    expect(res.status).toBe(200)
    expect(await usageRows()).toHaveLength(0)
    const [credit] = await t.rows<{ raw_cost_cents: number }>("org_credit_usage_daily")
    expect(Number(credit.raw_cost_cents)).toBeCloseTo(inworldTtsRawCents(5, "inworld-tts-2"), 6)
  })
})

describe("voice design and publish (#14)", () => {
  it("shadow: design records the preview characters for every sample it synthesizes", async () => {
    stubInworld()
    const res = (await handleTtsRequest(new Request("https://w/api/v1/voice/tts/design", json({
      projectId: "p1", designPrompt: "A warm, low, unhurried storyteller voice with a slight rasp.", numberOfSamples: 2,
    }, await token())), ttsEnv("shadow")))!
    expect(res.status).toBe(200)
    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rail: "tts", state: "settled" })
    expect(rawCents(rows[0])).toBeCloseTo(inworldTtsRawCents(INWORLD_DESIGN_DEFAULT_PREVIEW_TEXT.length * 2), 6)
  })

  it("shadow: publish leaves a row, settled at the card's price", async () => {
    stubInworld()
    const res = (await handleTtsRequest(new Request("https://w/api/v1/voice/tts/publish",
      json({ projectId: "p1", voiceId: "ws__v1" }, await token())), ttsEnv("shadow")))!
    expect(res.status).toBe(200)
    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rail: "tts", state: "settled" })
    expect(rawCents(rows[0])).toBe(0)
  })
})

// ── Diarization (Modal pyannote, async) ──────────────────────────────────────

function diarizationEnv(mode: string): DiarizationEnv {
  return {
    SNAPSHOTS: bucket() as unknown as R2Bucket, AQUILLA_PG: t.db, SYNC_SECRET_KEY: SECRET,
    DIARIZATION_MODAL_URL: "https://modal/start", DIARIZATION_SHARED_SECRET: "modal-secret",
    DIARIZATION_PUBLIC_BASE: "https://sync.example.com", ENVIRONMENT: "test", BILLING_METER_MODE: mode,
  }
}

async function startDiarization(env: DiarizationEnv) {
  return (await handleDiarizationRequest(new Request("https://w/api/v1/diarization/start",
    json({ projectId: "p1", fileId: "f1", audioObject: "clip.webm" }, await token())), env))!
}

describe("diarization (#15)", () => {
  it("shadow: /start reserves the worst case and the callback settles the measured GPU time", async () => {
    let modalCalls = 0
    globalThis.fetch = (async () => { modalCalls++; return Response.json({ ok: true }) }) as unknown as typeof fetch
    const env = diarizationEnv("shadow")
    const started = await startDiarization(env)
    expect(started.status).toBe(200)
    const { jobId } = (await started.json()) as { jobId: string }
    expect(modalCalls).toBe(1)

    let [row] = await usageRows()
    expect(row).toMatchObject({ request_id: jobId, rail: "gpu", mode: "metered", state: "reserved" })
    expect(reservedCents(row)).toBeCloseTo(modalGpuRawCents(DIARIZATION_GPU, DIARIZATION_MAX_GPU_SECONDS), 6)

    // The job ran for two minutes before Modal called back.
    await t.pg.query(`UPDATE diarization_jobs SET created_at = $1 WHERE id = $2`, [Date.now() - 120_000, jobId])
    const cb = (await handleDiarizationRequest(new Request("https://w/api/v1/diarization/callback", {
      method: "POST", body: JSON.stringify({ jobId, status: "succeeded", turns: [] }),
      headers: { "X-Diarization-Secret": "modal-secret" },
    }), env))!
    expect(cb.status).toBe(200)

    ;[row] = await usageRows()
    expect(row.state).toBe("settled")
    expect(rawCents(row)).toBeGreaterThanOrEqual(modalGpuRawCents(DIARIZATION_GPU, 120) - 1e-6)
    expect(rawCents(row)).toBeLessThan(modalGpuRawCents(DIARIZATION_GPU, 130))
  })

  it("enforce: an org past its allowance is refused with 402 before Modal starts", async () => {
    const plan = (await resolveOrgPlan(t.db, ORG))!
    const spent = Math.ceil(plan.weeklyAllowanceUnits! * 1_000_000 * 1.01 / 4)
    await t.pg.query(`INSERT INTO workspace_usage_requests (org_id, request_id, user_id, project_id, rail, rate_version,
        multiplier, period_start, period_end, reserved_micro_units, state, raw_micro_cents, settled_micro_units, resolved_at)
      VALUES ($1, 'spent', 1, 'p1', 'llm', '2026-09-cost-v1', 4, $2, $3, $4, 'settled', $5, $4, now())`,
    [ORG, plan.period.start, plan.period.end, spent * 4, spent])
    let modalCalls = 0
    globalThis.fetch = (async () => { modalCalls++; return Response.json({ ok: true }) }) as unknown as typeof fetch

    const res = await startDiarization(diarizationEnv("enforce"))
    expect(res.status).toBe(402)
    expect(await res.json()).toMatchObject({ error: "ai_allowance_exhausted" })
    expect(modalCalls).toBe(0)
  })
})

// ── Voice-convert (Modal Seed-VC, synchronous) ───────────────────────────────

describe("voice-convert (#16)", () => {
  it("shadow: one settled gpu row at the GPU seconds the call took", async () => {
    const env: VoiceConvertEnv = {
      SNAPSHOTS: bucket() as unknown as R2Bucket, SYNC_SECRET_KEY: SECRET,
      SEED_VC_URL: "https://modal/convert", SEED_VC_TOKEN: "seed-secret",
      AQUILLA_PG: t.db, ENVIRONMENT: "test", BILLING_METER_MODE: "shadow",
    }
    await env.SNAPSHOTS.put(voiceRefObjectKey(env, "p1", "ref1.wav"), wav(1))
    // The conversion takes 5 s of wall clock.
    const realNow = Date.now.bind(Date)
    let offset = 0
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset)
    let sentToken = ""
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sentToken = (init.headers as Record<string, string>)["X-Auth-Token"]
      offset += 5_000
      return new Response(wav(1), { status: 200 })
    }) as unknown as typeof fetch

    const form = new FormData()
    form.append("projectId", "p1"); form.append("fileId", "f1"); form.append("referenceAudioId", "ref1.wav")
    form.append("source", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }), "source")
    const res = (await handleVoiceConvertRequest(new Request("https://w/api/v1/voice/convert", {
      method: "POST", body: form, headers: { Authorization: `Bearer ${await token()}` },
    }), env))!
    expect(res.status).toBe(200)
    // The key the check chose is the one sent to Modal.
    expect(sentToken).toBe("seed-secret")

    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ rail: "gpu", mode: "metered", state: "settled" })
    expect(rawCents(rows[0])).toBeGreaterThanOrEqual(modalGpuRawCents(VOICE_CONVERT_GPU, 5) - 1e-6)
    expect(rawCents(rows[0])).toBeLessThan(modalGpuRawCents(VOICE_CONVERT_GPU, 6))
  })
})
