// Omnilingual ASR routing, gating and billing on POST /api/v1/audio/transcriptions
// (spec docs/superpowers/specs/2026-10-16-omnilingual-asr.md §3).
//
// Why these matter: Whisper must keep serving every language it supports
// exactly as before (it is cheaper and proven), the GPU service must only be
// reached for languages Whisper lacks or on the zero-shot opt-in, an org admin's
// "off" must actually stop zero-shot, and metered GPU time must always charge.
import { env } from "cloudflare:test"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import app from "../index"
import { resetTranscriptionRateCache } from "../lib/billing/transcription-usage"
import { readUsageTotals } from "../lib/billing/workspace-usage"
import { readBillingWorkspace } from "../lib/billing/workspace"
import { OMNI_FALLBACK_CENTS_PER_SEC, OMNI_GPU_CENTS_PER_SEC, OMNI_MIN_GPU_SECONDS } from "../../../db/shared/omni-asr-cost"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { completedPayment, config } from "./helpers/workspace-billing"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTranscriptionRateCache() })

const MODAL = "https://omni.example"
const SYNC = "https://sync.example/sync"
const exampleUrl = `${SYNC}/api/v1/transcription-examples/audio?p=omni-project&f=f1&a=a.webm&exp=1&sig=00`
const projectId = "omni-project"

type Producer = (samples: Float32Array, projectId: string, language?: string) =>
  Promise<{ input_audio: { data: string; format: "wav" } }>
let buildTranscriptionRequest: Producer
beforeAll(async () => {
  // The SPA's own WAV producer, so the Worker is tested on real client bytes.
  const producerPath = new URL("../../../src/lib/audio/transcription-request.ts", import.meta.url).pathname
  ;({ buildTranscriptionRequest } = await import(producerPath))
})

const settings = (overrides: Record<string, unknown> = {}) => Object.assign(Object.create(env), {
  OPENROUTER_API_KEY: "platform-secret",
  OPENROUTER_BASE_URL: "https://upstream.example/api/v1",
  OMNI_ASR_MODAL_URL: `${MODAL}/`,
  OMNI_SHARED_SECRET: "omni-secret",
  SYNC_WORKER_URL: SYNC,
  ...overrides,
})

async function audio(seconds: number, language?: string) {
  return (await buildTranscriptionRequest(new Float32Array(Math.round(seconds * 16000)), projectId, language))
}

async function owner(orgSettings?: Record<string, unknown>) {
  await seedUser(1, "omni-owner")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Omni Org', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Omni', 1, 1)")
    .bind(projectId).run()
  if (orgSettings) {
    await env.AQUILLA_PG.prepare("INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 0, 1)")
      .bind(JSON.stringify(orgSettings)).run()
  }
  return jwtFor("omni-owner")
}

interface Calls { whisper: Record<string, unknown>[]; modal: { url: string; headers: Headers; body: Record<string, unknown> }[] }
function stubProviders(modalReply: Record<string, unknown> = {
  text: "ami ya", words: [{ text: "ami", start: 0, end: 0.4 }, { text: "ya", start: 0.5, end: 0.8 }],
  gpuSeconds: 2, gpu: "NVIDIA L4", timingsApproximate: false,
}): Calls {
  const calls: Calls = { whisper: [], modal: [] }
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.includes("/models?")) {
      return Response.json({ data: [{ id: "openai/whisper-1", pricing: { prompt: "0.0001" } }] })
    }
    if (url.startsWith("https://upstream.example")) {
      calls.whisper.push(JSON.parse(String(init?.body)))
      return Response.json({ text: "bonjour", words: [{ word: "bonjour", start: 0, end: 0.5 }], usage: { cost: 0.001 } })
    }
    if (url.startsWith(MODAL)) {
      calls.modal.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) })
      return Response.json(modalReply)
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return calls
}

const post = async (jwt: string, body: unknown, overrides: Record<string, unknown> = {}) =>
  app.request("/api/v1/audio/transcriptions", {
    method: "POST", headers: authHeader(jwt), body: JSON.stringify(body),
  }, settings(overrides))

describe("auto routing", () => {
  it("keeps Whisper for a supported BCP-47 tag, sending its two-letter code", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    const response = await post(jwt, await audio(1, "fr-CA"))
    expect(response.status).toBe(200)
    expect(calls.modal).toHaveLength(0)
    expect(calls.whisper).toHaveLength(1)
    expect(calls.whisper[0]).toMatchObject({ model: "openai/whisper-1", language: "fr" })
    expect(await response.json()).toEqual({ text: "bonjour", chunks: [{ text: "bonjour", start: 0, end: 0.5 }],
      model: "whisper", timingsApproximate: false, granularity: "word" })
  })

  it("keeps Whisper auto-detect when the client sends no language", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    expect((await post(jwt, await audio(1))).status).toBe(200)
    expect(calls.modal).toHaveLength(0)
    expect(calls.whisper[0].language).toBeUndefined()
  })

  it("sends a language Whisper lacks to Omnilingual CTC with the secret and mapped lang", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    const request = await audio(2, "tpi")
    const response = await post(jwt, request)
    expect(response.status).toBe(200)
    expect(calls.whisper).toHaveLength(0)
    expect(calls.modal).toHaveLength(1)
    expect(calls.modal[0].url).toBe(`${MODAL}/transcribe`)
    expect(calls.modal[0].headers.get("X-Omni-Secret")).toBe("omni-secret")
    expect(calls.modal[0].body).toEqual({ model: "ctc", audio: request.input_audio.data, lang: "tpi_Latn" })
    expect(await response.json()).toEqual({ text: "ami ya", chunks: [
      { text: "ami", start: 0, end: 0.4 }, { text: "ya", start: 0.5, end: 0.8 },
    ], model: "omni-ctc", timingsApproximate: false, granularity: "word" })
  })

  it("omits lang when the script cannot be known, and flags approximate timings", async () => {
    const jwt = await owner()
    const calls = stubProviders({ text: "x", words: [{ text: "x", start: 0, end: 1 }], gpuSeconds: 1, gpu: "NVIDIA L4", timingsApproximate: true })
    const response = await post(jwt, await audio(1, "qxy"))
    expect(response.status).toBe(200)
    expect(calls.modal[0].body).not.toHaveProperty("lang")
    expect(await response.json()).toMatchObject({ timingsApproximate: true })
  })

  it("rejects Omnilingual audio of 40 s or more before calling the GPU", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    const response = await post(jwt, await audio(40, "tpi"))
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "omnilingual_audio_too_long" })
    expect(calls.modal).toHaveLength(0)
  })

  // Shipping this code before the Modal deploy must not break projects in
  // languages Whisper lacks: they got Whisper auto-detect before, and still do.
  it("falls back to Whisper auto-detect for a non-Whisper language when Modal is not configured", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    const response = await post(jwt, await audio(1, "tpi"), { OMNI_ASR_MODAL_URL: undefined })
    expect(response.status).toBe(200)
    expect(calls.modal).toHaveLength(0)
    expect(calls.whisper).toHaveLength(1)
    expect(calls.whisper[0].language).toBeUndefined()
  })

  it("still refuses an explicit Omnilingual choice with 503 when Modal is not configured", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    const response = await post(jwt, { ...(await audio(1, "tpi")), model: "omni-ctc" }, { OMNI_ASR_MODAL_URL: undefined })
    expect(response.status).toBe(503)
    expect(calls.modal).toHaveLength(0)
    expect(calls.whisper).toHaveLength(0)
  })
})

describe("zero-shot", () => {
  const zs = async (examples?: unknown) => ({
    ...(await audio(2, "tpi")), model: "omni-zs", ...(examples === undefined ? {} : { examples }),
  })

  it("forwards the examples to the ZS model", async () => {
    const jwt = await owner()
    const calls = stubProviders({ text: "ami", words: [{ text: "ami", start: 0, end: 1 }], gpuSeconds: 3, gpu: "NVIDIA L40S" })
    const response = await post(jwt, await zs([{ url: exampleUrl, text: "ami ya" }]))
    expect(response.status).toBe(200)
    expect(calls.modal[0].body).toMatchObject({ model: "zs", lang: "tpi_Latn", examples: [{ url: exampleUrl, text: "ami ya" }] })
  })

  it("is refused with 403 when the org has turned it off", async () => {
    const jwt = await owner({ transcription: { zeroShotEnabled: false } })
    const calls = stubProviders()
    const response = await post(jwt, await zs([{ url: exampleUrl, text: "ami" }]))
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "zero_shot_disabled" })
    expect(calls.modal).toHaveLength(0)
  })

  it("stays allowed when the org setting is absent", async () => {
    const jwt = await owner({ transcription: {} })
    stubProviders()
    expect((await post(jwt, await zs([{ url: exampleUrl, text: "ami" }]))).status).toBe(200)
  })

  it("requires at least one example", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    for (const examples of [undefined, []]) {
      const response = await post(jwt, await zs(examples))
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: "zs_no_examples" })
    }
    expect(calls.modal).toHaveLength(0)
  })

  it("refuses example URLs that are not our signed example-audio route", async () => {
    // Otherwise any caller could make the GPU box fetch an arbitrary URL.
    const jwt = await owner()
    const calls = stubProviders()
    for (const url of [
      "https://evil.example/api/v1/transcription-examples/audio?x=1",
      `${SYNC}/audio/p/f/a.webm`,
      `https://user:pw@sync.example/sync/api/v1/transcription-examples/audio?x=1`,
    ]) {
      expect((await post(jwt, await zs([{ url, text: "ami" }]))).status).toBe(400)
    }
    expect(calls.modal).toHaveLength(0)
  })
})

describe("Omnilingual billing", () => {
  it("records gpuSeconds × rate × amortization on the legacy credit rail", async () => {
    const jwt = await owner()
    stubProviders({ text: "ami", words: [{ text: "ami", start: 0, end: 1 }], gpuSeconds: 4, gpu: "NVIDIA L4" })
    expect((await post(jwt, await audio(2.5, "tpi"), { OMNI_ASR_AMORTIZATION: "2" })).status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT raw_cost_cents, units FROM org_credit_usage_daily")
      .first<{ raw_cost_cents: number; units: number }>()
    expect(row?.units).toBe(3)
    expect(row?.raw_cost_cents).toBeCloseTo(4 * OMNI_GPU_CENTS_PER_SEC["NVIDIA L4"] * 2, 9)
  })

  it("charges a minimum, never zero, when the service reports 0 GPU seconds", async () => {
    const jwt = await owner()
    stubProviders({ text: "", words: [], gpuSeconds: 0, gpu: "NVIDIA L4" })
    expect((await post(jwt, await audio(1, "tpi"))).status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT raw_cost_cents FROM org_credit_usage_daily")
      .first<{ raw_cost_cents: number }>()
    expect(row?.raw_cost_cents).toBeGreaterThan(0)
    expect(row?.raw_cost_cents).toBeCloseTo(OMNI_MIN_GPU_SECONDS * OMNI_GPU_CENTS_PER_SEC["NVIDIA L4"] * 1.5, 9)
  })

  it("settles the weekly reservation at metered GPU cost with the ×4 markup", async () => {
    const paid = await completedPayment("pro", "month")
    expect((await paid.send()).status).toBe(200)
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Omni', 1, 1)")
      .bind(projectId).run()
    stubProviders({ text: "ami", words: [{ text: "ami", start: 0, end: 1 }], gpuSeconds: 10, gpu: "NVIDIA L40S" })
    const response = await app.request("http://127.0.0.1/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { ...authHeader(await jwtFor("alice")), "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(await audio(2, "tpi")),
    // Rehearsal metering only runs against a loopback OpenRouter base.
    }, { ...config(), ...settings(), OPENROUTER_BASE_URL: "http://127.0.0.1:9999/v1", BILLING_CHAT_USAGE_REHEARSAL: "true" })
    expect(response.status).toBe(200)
    expect(response.headers.get("X-Billing-Usage-Status")).toBe("settled")
    const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
    const totals = await readUsageTotals(env.AQUILLA_PG, 1, { start: plan.usagePeriodStart, end: plan.usagePeriodEnd })
    const rawMicroCents = Math.ceil(10 * OMNI_GPU_CENTS_PER_SEC["NVIDIA L40S"] * 1.5 * 1_000_000)
    expect(totals).toEqual({ reserved: 0, settled: rawMicroCents * 4, committed: rawMicroCents * 4 })
  })
})

describe("Omnilingual billing — edge replies", () => {
  async function weekly(reply: Record<string, unknown>) {
    const paid = await completedPayment("pro", "month")
    expect((await paid.send()).status).toBe(200)
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Omni', 1, 1)")
      .bind(projectId).run()
    stubProviders(reply)
    const response = await app.request("http://127.0.0.1/api/v1/audio/transcriptions", {
      method: "POST",
      headers: { ...authHeader(await jwtFor("alice")), "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify(await audio(2, "tpi")),
    }, { ...config(), ...settings(), OPENROUTER_BASE_URL: "http://127.0.0.1:9999/v1", BILLING_CHAT_USAGE_REHEARSAL: "true" })
    const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
    const totals = await readUsageTotals(env.AQUILLA_PG, 1, { start: plan.usagePeriodStart, end: plan.usagePeriodEnd })
    return { response, totals }
  }

  it("bills an unrecognised GPU name at the dearest known rate, not zero", async () => {
    const { response, totals } = await weekly({ text: "ami", words: [{ text: "ami", start: 0, end: 1 }], gpuSeconds: 10, gpu: "NVIDIA H200" })
    expect(response.status).toBe(200)
    const rawMicroCents = Math.ceil(10 * OMNI_FALLBACK_CENTS_PER_SEC * 1.5 * 1_000_000)
    expect(totals.settled).toBe(rawMicroCents * 4)
    expect(OMNI_FALLBACK_CENTS_PER_SEC).toBe(Math.max(...Object.values(OMNI_GPU_CENTS_PER_SEC)))
  })

  it("answers a cold ZS container with 503 asr_warming and releases the reservation", async () => {
    // No GPU ran, so the caller must not be charged; the client retries after warm-up.
    const { response, totals } = await weekly({ warming: true })
    expect(response.status).toBe(503)
    expect(response.headers.get("Retry-After")).toBe("10")
    expect(await response.json()).toEqual({ error: "asr_warming" })
    expect(totals).toEqual({ reserved: 0, settled: 0, committed: 0 })
  })

  it("ignores the service's diagnostic fields", async () => {
    const { response } = await weekly({ text: "ami", words: [{ text: "ami", start: 0, end: 1 }],
      gpuSeconds: 1, gpu: "NVIDIA L4", peakMemGiB: 3.1, loadSec: 12 })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ text: "ami", chunks: [{ text: "ami", start: 0, end: 1 }],
      model: "omni-ctc", timingsApproximate: false, granularity: "word" })
  })
})

describe("warm-up and status proxies", () => {
  it("passes status through for a project member", async () => {
    const jwt = await owner()
    const calls = stubProviders({ state: "starting", estGpuSecPerAudioSec: 0.2 })
    const response = await app.request(`/api/v1/audio/transcriptions/status?projectId=${projectId}&model=zs`,
      { headers: authHeader(jwt) }, settings())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: "starting", estGpuSecPerAudioSec: 0.2 })
    expect(calls.modal[0].url).toBe(`${MODAL}/status?model=zs`)
    expect(calls.modal[0].headers.get("X-Omni-Secret")).toBe("omni-secret")
  })

  it("warms the requested model", async () => {
    const jwt = await owner()
    const calls = stubProviders({ ok: true })
    const response = await app.request("/api/v1/audio/transcriptions/warm", {
      method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId, model: "omni-zs" }),
    }, settings())
    expect(response.status).toBe(202)
    expect(calls.modal[0]).toMatchObject({ url: `${MODAL}/warm`, body: { model: "zs" } })
  })

  it("does not let a non-member warm the GPU", async () => {
    await owner()
    await seedUser(2, "stranger")
    const calls = stubProviders({ ok: true })
    const response = await app.request("/api/v1/audio/transcriptions/warm", {
      method: "POST", headers: authHeader(await jwtFor("stranger")), body: JSON.stringify({ projectId, model: "omni-zs" }),
    }, settings())
    expect(response.status).toBe(403)
    expect(calls.modal).toHaveLength(0)
  })

  it("does not warm zero-shot for an org that turned it off", async () => {
    const jwt = await owner({ transcription: { zeroShotEnabled: false } })
    const calls = stubProviders({ ok: true })
    const response = await app.request("/api/v1/audio/transcriptions/warm", {
      method: "POST", headers: authHeader(jwt), body: JSON.stringify({ projectId, model: "omni-zs" }),
    }, settings())
    expect(response.status).toBe(403)
    expect(calls.modal).toHaveLength(0)
  })
})

describe("org admins control transcription.zeroShotEnabled", () => {
  async function seedOrgRoles() {
    await seedUser(2, "mara") // maintainer
    await seedUser(3, "leo")  // project lead
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1,1,700,1), (1,2,600,1), (1,3,500,1)",
    ).run()
  }
  const patch = async (username: string, transcription: unknown) =>
    app.request("/api/v2/orgs/1/settings", {
      method: "PATCH", headers: authHeader(await jwtFor(username)),
      body: JSON.stringify({ settings: { transcription }, ifMatchVersion: 0 }),
    }, env)

  it("a maintainer's off switch stops zero-shot runs", async () => {
    const jwt = await owner({})
    await seedOrgRoles()
    expect((await patch("mara", { zeroShotEnabled: false })).status).toBe(200)
    const calls = stubProviders()
    const response = await post(jwt, { ...(await audio(2, "tpi")), model: "omni-zs", examples: [{ url: exampleUrl, text: "ami" }] })
    expect(response.status).toBe(403)
    expect(calls.modal).toHaveLength(0)
  })

  it("members below maintainer cannot change it", async () => {
    await owner({})
    await seedOrgRoles()
    expect((await patch("leo", { zeroShotEnabled: false })).status).toBe(403)
  })

  it("rejects a non-boolean rather than storing a value that would read as on", async () => {
    await owner({})
    await seedOrgRoles()
    expect((await patch("mara", { zeroShotEnabled: "false" })).status).toBe(400)
    expect((await patch("mara", "off")).status).toBe(400)
  })
})

describe("Qwen3-ASR for Chinese varieties", () => {
  it("routes Cantonese to qwen/qwen3-asr-1.7b through the OpenRouter path", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes("/models?")) return Response.json({ data: [{ id: "qwen/qwen3-asr-1.7b", pricing: { prompt: "0.0000075" } }] })
      calls.whisper.push(JSON.parse(String(init?.body)))
      return Response.json({ text: "你好", words: [{ word: "你好", start: 0, end: 0.5 }], usage: { cost: 0.0001 } })
    })
    const response = await post(jwt, await audio(1, "yue-HK"))
    expect(response.status).toBe(200)
    expect(calls.whisper[0]).toMatchObject({ model: "qwen/qwen3-asr-1.7b", language: "yue" })
    expect(await response.json()).toMatchObject({ model: "qwen3-asr" })
  })

  it("lets a user force Whisper even for a Chinese tag", async () => {
    const jwt = await owner()
    const calls = stubProviders()
    expect((await post(jwt, { ...(await audio(1, "zh-CN")), model: "whisper" })).status).toBe(200)
    expect(calls.whisper[0]).toMatchObject({ model: "openai/whisper-1", language: "zh" })
  })
})

describe("internal route for Agent API tools", () => {
  const internal = async (body: Record<string, unknown>, secret = "sync-secret", path = "/api/v1/audio/internal/transcriptions") =>
    app.request(path, {
      method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, settings({ SYNC_SECRET_KEY: "sync-secret" }))
  const webm = { data: btoa("not-really-webm-bytes"), format: "webm", durationMs: 5000 }

  it("refuses callers without the shared secret", async () => {
    await owner()
    const calls = stubProviders()
    expect((await internal({ projectId, userId: 1, audio: webm, language: "tpi" }, "wrong")).status).toBe(401)
    expect(calls.modal).toHaveLength(0)
  })

  it("re-checks the user's live project role", async () => {
    await owner()
    await seedUser(2, "stranger")
    const calls = stubProviders()
    expect((await internal({ projectId, userId: 2, audio: webm, language: "tpi" })).status).toBe(403)
    expect(calls.modal).toHaveLength(0)
  })

  it("forwards a stored webm take to Omnilingual and reports credits charged", async () => {
    await owner()
    const calls = stubProviders({ text: "ami", words: [{ text: "ami", start: 0, end: 1 }], gpuSeconds: 2, gpu: "NVIDIA L4" })
    const response = await internal({ projectId, userId: 1, audio: webm, language: "tpi" })
    expect(response.status).toBe(200)
    expect(calls.modal[0].body).toMatchObject({ model: "ctc", audio: webm.data })
    const body = await response.json() as { model: string; creditsCharged: number }
    expect(body.model).toBe("omni-ctc")
    expect(body.creditsCharged).toBeCloseTo(2 * OMNI_GPU_CENTS_PER_SEC["NVIDIA L4"] * 1.5 * 4, 9)
  })

  it("applies the same org zero-shot gate as the app", async () => {
    await owner({ transcription: { zeroShotEnabled: false } })
    const calls = stubProviders()
    const response = await internal({ projectId, userId: 1, audio: webm, language: "tpi", model: "omni-zs",
      examples: [{ url: exampleUrl, text: "ami" }] })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: "zero_shot_disabled" })
    expect(calls.modal).toHaveLength(0)
  })

  it("refuses a webm take for Whisper, which OpenRouter does not document", async () => {
    await owner()
    const calls = stubProviders()
    const response = await internal({ projectId, userId: 1, audio: webm, language: "fr" })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "audio_format_unsupported_for_model" })
    expect(calls.whisper).toHaveLength(0)
  })

  it("warms then reports status for an agent", async () => {
    await owner()
    const calls = stubProviders({ state: "starting", estGpuSecPerAudioSec: 0.5 })
    const response = await internal({ projectId, userId: 1, model: "omni-zs", action: "warm" },
      "sync-secret", "/api/v1/audio/internal/transcriptions/status")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ state: "starting", estGpuSecPerAudioSec: 0.5 })
    expect(calls.modal.map(call => call.url)).toEqual([`${MODAL}/warm`, `${MODAL}/status?model=zs`])
  })
})
