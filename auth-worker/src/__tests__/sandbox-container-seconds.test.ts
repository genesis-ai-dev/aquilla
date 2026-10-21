// AQU-2066 (unified billing T9): container seconds on the `sandbox` rail for
// the import sandbox (spec §3.2 row 12) and the agent's run_code (row 26).
//
// Why these tests matter: Cloudflare bills us for every second a sandbox
// container runs, and before T9 no ledger saw any of it, so a workspace could
// loop imports or run_code on our money with nothing counting. The contract:
// the meter is asked BEFORE a container can start (an exhausted org never
// reaches the pool); the row carries the seconds that were measured, priced
// from the Containers price card for our instance type; a call the pool
// refused ran nothing, so it is released rather than billed; and the rail
// stays metered for an org that brings its own model keys, because the
// container is ours, not theirs.
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { jwtFor, seedUser } from "./helpers/db"
import { resolveOrgPlan } from "../../../db/shared/org-plan"
import { __resetAiSpendCeilingStateForTests } from "../../../db/shared/ai-spend-ceiling"
import { checkAiEntitlement } from "../../../db/shared/ai-entitlement"
import { resetRateCardCache } from "../lib/billing/rate-card"
import { SANDBOX_PRICE_CARD, containerCents } from "../lib/billing/sandbox-meter"
import { runCode, type HarnessToolCtx } from "../lib/agent/harness-tools"
import type { Env } from "../types"
import { DEFAULT_LLM_MODEL_ID } from "../lib/model-defaults"

const ORG = 52
const PROJECT = "proj-sandbox-time"
const BASE = "https://mock-openrouter"
type Meter = "shadow" | "enforce"
const meterEnv = (mode: Meter) => Object.assign(Object.create(env), {
  BILLING_METER_MODE: mode,
  OPENROUTER_API_KEY: "sk-or-house",
  OPENROUTER_BASE_URL: BASE,
  AGENT_SANDBOX_URL: "http://sandbox.test",
  AGENT_SANDBOX_KEY: "sandbox-key",
  AI_BUDGET_ENFORCE: "false",
}) as Env

/** The parser model must be priced: admission refuses what it cannot price. */
const RATE_CARD = { data: [...new Set([DEFAULT_LLM_MODEL_ID, env.AGENT_MODEL_DEFAULT, env.AGENT_DRAFT_MODEL_DEFAULT,
  env.DEFAULT_LLM_MODEL].filter((m): m is string => !!m))]
  .map((id) => ({ id, pricing: { prompt: "0.000001", completion: "0.000002" } })) }

/** Simulated container run time: each exec advances the clock by this much,
 *  so the measured seconds are known without waiting for them. */
const EXEC_SECONDS = 30
let skewMs = 0
let sandboxCalls: string[]

function stubSandbox(opts: { busy?: boolean } = {}) {
  sandboxCalls = []
  let execs = 0
  const realNow = Date.now.bind(Date)
  skewMs = 0
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs)
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === `${BASE}/models`) return Response.json(RATE_CARD)
    if (url === `${BASE}/chat/completions`) {
      return Response.json({
        id: "gen-1",
        choices: [{ message: { content: JSON.stringify({
          category: "scripture", confidence: 0.9, explanation: "x", profileName: "p", inputFormat: "bin",
          language: "python", code: "print(1)",
        }) } }],
        usage: { cost: 0.0001 },
      })
    }
    if (url.startsWith("http://sandbox.test")) {
      sandboxCalls.push(url)
      if (opts.busy) return Response.json({ error: { code: "pool_busy", message: "every sandbox is busy" } }, { status: 503 })
      if (url.includes("/fetch-artifact")) return Response.json({ ok: true, bytes: 4 })
      if (url.endsWith("/exec")) {
        execs++
        skewMs += EXEC_SECONDS * 1000
        return Response.json(execs === 1
          ? { ok: true, stdout: JSON.stringify({ isZip: false }), stderr: "", durationMs: 1 }
          : execs === 3 ? { ok: true, stdout: "64", stderr: "", durationMs: 1 }
            : { ok: true, stdout: "hi", stderr: "", durationMs: 1 })
      }
      if (url.includes("/files?")) return Response.json({ units: [{ sourceText: "In the beginning" }] })
      if (init?.method === "DELETE") return Response.json({ ok: true })
    }
    throw new Error(`unexpected fetch ${url}`)
  }))
}

async function seedOrgProject(opts: { overLimit: boolean }) {
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id, created_at) VALUES (?, 'o', 1, '2026-10-01T00:00:00Z')",
  ).bind(ORG).run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_billing (org_id, tier) VALUES (?, 'free')").bind(ORG).run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'P', ?, 1)")
    .bind(PROJECT, ORG).run()
  if (!opts.overLimit) return
  const plan = (await resolveOrgPlan(env.AQUILLA_PG, ORG))!
  const raw = Math.ceil(plan.weeklyAllowanceUnits! * 1_000_000 * 1.01 / 4)
  await env.AQUILLA_PG.prepare(`INSERT INTO workspace_usage_requests (org_id, request_id, user_id, project_id, rail,
      rate_version, multiplier, period_start, period_end, reserved_micro_units, state, raw_micro_cents,
      settled_micro_units, resolved_at)
    VALUES (?, 'spent', 1, ?, 'llm', '2026-09-cost-v1', 4, ?::timestamptz, ?::timestamptz, ?, 'settled', ?, ?, now())`)
    .bind(ORG, PROJECT, plan.period.start, plan.period.end, raw * 4, raw, raw * 4).run()
}

async function sandboxRows() {
  const { results } = await env.AQUILLA_PG.prepare(`SELECT user_id, mode, state, raw_micro_cents
      FROM workspace_usage_requests WHERE org_id = ? AND rail = 'sandbox' ORDER BY created_at`)
    .bind(ORG).all<{ user_id: number | string | null; mode: string; state: string; raw_micro_cents: number | string | null }>()
  return results.map((r) => ({ ...r, user_id: r.user_id === null ? null : Number(r.user_id),
    raw_micro_cents: r.raw_micro_cents === null ? null : Number(r.raw_micro_cents) }))
}
const microCents = (seconds: number) => Math.ceil(containerCents(seconds) * 1_000_000)

class FakeBucket {
  async put(): Promise<void> {}
  async delete(): Promise<void> {}
}
const importParse = async (e: Env) => app.request(`/api/v1/import/parse/${PROJECT}`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${await jwtFor("alice")}`,
    "Content-Type": "application/octet-stream",
    "X-Artifact-Name": "legacy.bin",
  },
  body: new Uint8Array([0, 1, 2, 3]),
}, Object.assign(Object.create(e), { SNAPSHOTS: new FakeBucket() }) as Env)

function harnessCtx(e: Env): HarnessToolCtx {
  return {
    env: e, runId: "run-1", sandboxSessionId: "sess-1", sessionId: null, projectId: PROJECT,
    userId: 1, username: "alice", signal: new AbortController().signal, send: () => {},
    memory: { memoryIndex: [] } as unknown as HarnessToolCtx["memory"],
    markUntrusted: () => {}, isUntrustedActive: () => false,
  }
}

beforeEach(() => {
  __resetAiSpendCeilingStateForTests()
  resetRateCardCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("the Containers price card", () => {
  it("prices one second of our standard-1 container from Cloudflare's published rates", () => {
    // ½ vCPU × $0.00002 + 4 GiB × $0.0000025 + 8 GB × $0.00000007 = $0.00002056/s.
    // If wrangler's instance_type changes, this card must change with it.
    expect(SANDBOX_PRICE_CARD.instanceType).toBe("standard-1")
    expect(containerCents(1)).toBeCloseTo(0.002056, 9)
    expect(containerCents(3600)).toBeCloseTo(7.4016, 6)
  })
})

describe("import sandbox container time (#12)", () => {
  it("settles the seconds the container ran, on the sandbox rail, as the importing person", async () => {
    await seedOrgProject({ overLimit: false })
    stubSandbox()
    const res = await importParse(meterEnv("shadow"))
    expect(res.status).toBe(200)
    // Three execs (inspect, parse, size probe) at 30 s each = 90 s measured.
    const rows = await sandboxRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ user_id: 1, mode: "metered", state: "settled" })
    expect(rows[0].raw_micro_cents).toBeGreaterThanOrEqual(microCents(3 * EXEC_SECONDS))
    expect(rows[0].raw_micro_cents).toBeLessThan(microCents(3 * EXEC_SECONDS + 10))
  })

  it("refuses an exhausted org before any container is asked for", async () => {
    await seedOrgProject({ overLimit: true })
    stubSandbox()
    const res = await importParse(meterEnv("enforce"))
    expect(res.status).toBe(402)
    expect(sandboxCalls).toHaveLength(0)
  })
})

describe("agent run_code container time (#26)", () => {
  it("settles the measured seconds of the call", async () => {
    await seedOrgProject({ overLimit: false })
    stubSandbox()
    const out = await runCode({ language: "python", code: "print('hi')" }, harnessCtx(meterEnv("shadow")))
    expect(out).toContain("ok: true")
    const rows = await sandboxRows()
    expect(rows).toEqual([expect.objectContaining({ user_id: 1, mode: "metered", state: "settled" })])
    expect(rows[0].raw_micro_cents).toBeGreaterThanOrEqual(microCents(EXEC_SECONDS))
    expect(rows[0].raw_micro_cents).toBeLessThan(microCents(EXEC_SECONDS + 10))
  })

  it("releases the reservation when the pool refused: no container ran", async () => {
    await seedOrgProject({ overLimit: false })
    stubSandbox({ busy: true })
    const out = await runCode({ language: "python", code: "print('hi')" }, harnessCtx(meterEnv("shadow")))
    expect(out).toContain("busy")
    expect(await sandboxRows()).toEqual([expect.objectContaining({ state: "released", raw_micro_cents: null })])
  })

  it("tells the model the allowance is spent and never calls the sandbox", async () => {
    await seedOrgProject({ overLimit: true })
    stubSandbox()
    const out = await runCode({ language: "python", code: "print('hi')" }, harnessCtx(meterEnv("enforce")))
    expect(out).toMatch(/^error: .*AI allowance/)
    expect(sandboxCalls).toHaveLength(0)
  })
})

describe("BYOK does not cover containers", () => {
  it("meters the sandbox rail on the house key even when the org has its own keys", async () => {
    await seedOrgProject({ overLimit: false })
    const grant = await checkAiEntitlement(env.AQUILLA_PG, meterEnv("shadow"), {
      orgId: ORG, userId: 1, projectId: PROJECT, rail: "sandbox", provider: "cloudflare",
      estimateRawCents: 1, requestId: "byok-sandbox",
    }, { byokKeys: async () => "customer-key" })
    expect(grant.ok && grant.mode).toBe("metered")
    expect(grant.ok && grant.key).toEqual({ provider: "cloudflare", source: "house", apiKey: "sandbox-key" })
  })
})
