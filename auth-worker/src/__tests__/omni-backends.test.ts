// Omnilingual ASR backend order: self-hosted (OMNI_ASR_PRIMARY_URL) first,
// then Modal (lib/omni-asr.ts omniFetch).
//
// Why these matter: the self-hosted box exists to remove Modal's cold GPU
// queue, so a healthy box must take every call. A box that is off, hung or
// failing must cost seconds, not a transcription, before Modal takes over.
// A 4xx must not be retried on Modal: that request is wrong everywhere, and
// a retry would spend GPU time on it twice. And the charge must follow the
// hardware that actually answered.
import { env } from "cloudflare:test"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import app from "../index"
import { resetTranscriptionRateCache } from "../lib/billing/transcription-usage"
import { readUsageTotals } from "../lib/billing/workspace-usage"
import { readBillingWorkspace } from "../lib/billing/workspace"
import { OMNI_PRIMARY_PROBE_TIMEOUT_MS } from "../lib/omni-asr"
import { OMNI_GPU_CENTS_PER_SEC } from "../../../db/shared/omni-asr-cost"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { completedPayment, config } from "./helpers/workspace-billing"

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetTranscriptionRateCache() })

const MODAL = "https://omni.example"
const PRIMARY = "https://omni-asr.selfhost.example"
const projectId = "omni-project"

type Producer = (samples: Float32Array, projectId: string, language?: string) =>
  Promise<{ input_audio: { data: string; format: "wav" } }>
let buildTranscriptionRequest: Producer
beforeAll(async () => {
  const producerPath = new URL("../../../src/lib/audio/transcription-request.ts", import.meta.url).pathname
  ;({ buildTranscriptionRequest } = await import(producerPath))
})

const settings = (overrides: Record<string, unknown> = {}) => Object.assign(Object.create(env), {
  OPENROUTER_API_KEY: "platform-secret",
  OPENROUTER_BASE_URL: "https://upstream.example/api/v1",
  OMNI_ASR_PRIMARY_URL: `${PRIMARY}/`,
  OMNI_ASR_MODAL_URL: `${MODAL}/`,
  OMNI_SHARED_SECRET: "omni-secret",
  ...overrides,
})

const reply = (gpu: string) => ({
  text: "ami", words: [{ text: "ami", start: 0, end: 1 }], gpuSeconds: 4, gpu, timingsApproximate: false,
})

type Primary = "up" | "down" | "hung" | { status: number }
/** Stub both backends. `primary` decides what the self-hosted box does. */
function stubBackends(primary: Primary) {
  const calls: string[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.startsWith(PRIMARY)) {
      calls.push(url.replace(PRIMARY, "primary"))
      if (primary === "down") throw new TypeError("Network connection lost")
      if (primary === "hung") {
        // Never answers; only the caller's timeout ends it.
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
      }
      if (url.endsWith("/healthz")) return Response.json({ ok: true, models: ["ctc", "zs"] })
      if (typeof primary === "object") return Response.json({ detail: "nope" }, { status: primary.status })
      if (url.endsWith("/warm")) return Response.json({ state: "ready" })
      return Response.json(reply("NVIDIA GeForce RTX 4090"))
    }
    if (url.startsWith(MODAL)) {
      calls.push(url.replace(MODAL, "modal"))
      if (url.endsWith("/warm")) return Response.json({ state: "starting" })
      return Response.json(reply("NVIDIA L4"))
    }
    throw new Error(`unexpected fetch ${url}`)
  })
  return calls
}

async function owner() {
  await seedUser(1, "omni-owner")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Omni Org', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Omni', 1, 1)")
    .bind(projectId).run()
  return jwtFor("omni-owner")
}

async function transcribe(overrides: Record<string, unknown> = {}) {
  const jwt = await owner()
  const body = await buildTranscriptionRequest(new Float32Array(2 * 16000), projectId, "tpi")
  return app.request("/api/v1/audio/transcriptions", {
    method: "POST", headers: authHeader(jwt), body: JSON.stringify(body),
  }, settings(overrides))
}

async function billedRawCents() {
  const row = await env.AQUILLA_PG.prepare("SELECT raw_cost_cents FROM org_credit_usage_daily")
    .first<{ raw_cost_cents: number }>()
  return row?.raw_cost_cents
}

describe("Omnilingual backend order", () => {
  it("sends a call to a healthy self-hosted box and bills its RTX 4090, never touching Modal", async () => {
    const calls = stubBackends("up")
    const response = await transcribe()
    expect(response.status).toBe(200)
    expect(response.headers.get("X-Transcription-Backend")).toBe("primary")
    expect(calls).toEqual(["primary/healthz", "primary/transcribe"])
    expect(await billedRawCents()).toBeCloseTo(4 * OMNI_GPU_CENTS_PER_SEC["NVIDIA GeForce RTX 4090"] * 1.5, 9)
  })

  it("falls back to Modal when the box is unreachable, and bills Modal's GPU", async () => {
    const calls = stubBackends("down")
    const response = await transcribe()
    expect(response.status).toBe(200)
    expect(response.headers.get("X-Transcription-Backend")).toBe("modal")
    expect(calls).toEqual(["primary/healthz", "modal/transcribe"])
    expect(await billedRawCents()).toBeCloseTo(4 * OMNI_GPU_CENTS_PER_SEC["NVIDIA L4"] * 1.5, 9)
  })

  it("gives up on a hung box after the short probe timeout, not the transcription timeout", async () => {
    const calls = stubBackends("hung")
    const started = Date.now()
    const response = await transcribe()
    expect(response.status).toBe(200)
    expect(calls).toEqual(["primary/healthz", "modal/transcribe"])
    expect(Date.now() - started).toBeLessThan(OMNI_PRIMARY_PROBE_TIMEOUT_MS + 5000)
  }, 15000)

  it("falls back to Modal on a 5xx from the box, and bills only the answer it used", async () => {
    const calls = stubBackends({ status: 503 })
    const response = await transcribe()
    expect(response.status).toBe(200)
    expect(calls).toEqual(["primary/healthz", "primary/transcribe", "modal/transcribe"])
    expect(await billedRawCents()).toBeCloseTo(4 * OMNI_GPU_CENTS_PER_SEC["NVIDIA L4"] * 1.5, 9)
  })

  it("does not retry a 4xx on Modal", async () => {
    const calls = stubBackends({ status: 400 })
    const response = await transcribe()
    expect(response.status).toBe(502)
    expect(calls).toEqual(["primary/healthz", "primary/transcribe"])
    expect(await billedRawCents()).toBeUndefined()
  })

  it("serves from the box alone when Modal is not configured", async () => {
    const calls = stubBackends("up")
    const response = await transcribe({ OMNI_ASR_MODAL_URL: undefined })
    expect(response.status).toBe(200)
    // The only backend is called directly: there is nothing to fall back to.
    expect(calls).toEqual(["primary/transcribe"])
  })
})

describe("warm-up answered by the self-hosted box", () => {
  it("releases the reservation: the models are always loaded, so no GPU started", async () => {
    const paid = await completedPayment("team", "month", undefined, "personal")
    expect((await paid.send()).status).toBe(200)
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Omni', 1, 1)")
      .bind(projectId).run()
    const calls = stubBackends("up")
    const response = await app.request("http://127.0.0.1/api/v1/audio/transcriptions/warm", {
      method: "POST", headers: authHeader(await jwtFor("alice")), body: JSON.stringify({ projectId, model: "zs" }),
    // Rehearsal metering only runs against a loopback OpenRouter base.
    }, { ...config(), ...settings(), OPENROUTER_BASE_URL: "http://127.0.0.1:9999/v1", BILLING_CHAT_USAGE_REHEARSAL: "true" })
    expect(response.status).toBe(202)
    expect(calls).toEqual(["primary/healthz", "primary/warm"])
    const plan = (await readBillingWorkspace(env.AQUILLA_PG, 1))!.entitlement!
    const totals = await readUsageTotals(env.AQUILLA_PG, 1, { start: plan.usagePeriodStart, end: plan.usagePeriodEnd })
    expect(totals).toEqual({ reserved: 0, settled: 0, committed: 0 })
  })
})
