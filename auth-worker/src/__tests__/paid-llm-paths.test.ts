// AQU-2063 (unified billing T6): the six auth-worker OpenRouter paths that
// spent the house key with no weekly meter — DraftCells, brief summary, the
// import sandbox's parser model, knowledge indexing, Monday analyze and the
// tools builder (spec §3.2 rows 10, 11, 12, 23, 24, 25).
//
// Why these tests matter: a path that is not metered is a loop a Free org can
// run on our money forever. So for every path we pin the two halves of the
// contract: an org the meter refuses (enforce, already past 100%) gets the
// 402 before ANY provider call, and an admitted call settles the cost the
// provider reported — one ledger row per paid call, never a guessed zero.
// Knowledge indexing runs with no live person, so its rows carry the system
// user (null). The tools builder's repair count comes from the server: a
// client that keeps sending `attempt: 0` still stops after the cap.
import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { resolveOrgPlan } from "../../../db/shared/org-plan"
import { __resetAiSpendCeilingStateForTests } from "../../../db/shared/ai-spend-ceiling"
import { resetRateCardCache } from "../lib/billing/rate-card"
import { createDoc, getDocMeta } from "../../../db/shared/knowledge"
import { indexKnowledgeDoc } from "../lib/knowledge/index-doc"
import { analyzeBoardMapping } from "../lib/monday/analyze"
import { analyzeTableMapping } from "../lib/airtable/analyze"
import type { AirtableTableStructure } from "../lib/airtable/types"
import type { ProjectMetricsSummary } from "../lib/monday/metrics"
import { LlmRefusedError } from "../lib/billing/paid-llm"
import { MAX_REPAIR_ATTEMPTS } from "../lib/tools/builder"
import type { Env } from "../types"
import { DEFAULT_LLM_MODEL_ID } from "../lib/model-defaults"
import { DEFAULT_KB_INDEX_MODEL } from "../lib/knowledge/index-doc"
import { TOOLS_BUILDER_MODEL } from "../lib/tools/builder"

const ORG = 41
const PROJECT = "proj-paid"
const BASE = "https://mock-openrouter"
/** $0.0001 per call = 0.01¢ = 10 000 raw micro-cents on the ledger. */
const CALL_COST_USD = 0.0001
const CALL_RAW_MICRO_CENTS = 10_000

type Meter = "shadow" | "enforce"
const meterEnv = (mode: Meter) => Object.assign(Object.create(env), {
  BILLING_METER_MODE: mode,
  OPENROUTER_API_KEY: "sk-or-house",
  OPENROUTER_BASE_URL: BASE,
  AGENT_SANDBOX_URL: "http://sandbox.test",
  AGENT_SANDBOX_KEY: "sandbox-key",
  AI_BUDGET_ENFORCE: "false",
}) as Env

/** Every provider call, with the key it was sent with. */
let modelCalls: { body: Record<string, unknown>; auth: string | null }[]

/** Every model these paths can pick in the test env, so the rate card prices
 *  it: admission refuses a model it cannot price (paid-call.ts). */
const PRICED_MODELS = [...new Set([
  DEFAULT_LLM_MODEL_ID, DEFAULT_KB_INDEX_MODEL, TOOLS_BUILDER_MODEL,
  env.AGENT_MODEL_DEFAULT, env.AGENT_DRAFT_MODEL_DEFAULT, env.DEFAULT_LLM_MODEL,
].filter((m): m is string => !!m))]
const RATE_CARD = { data: PRICED_MODELS.map((id) => ({ id, pricing: { prompt: "0.000001", completion: "0.000002" } })) }

/** The model answers `reply(n)` for its n-th call; admission reserves from
 *  the rate card and settles the reported cost. Sandbox endpoints answer like
 *  a healthy container. */
function stubProviders(reply: (n: number) => string) {
  modelCalls = []
  let execs = 0
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === `${BASE}/models`) return Response.json(RATE_CARD)
    if (url === `${BASE}/chat/completions`) {
      const headers = new Headers(init?.headers)
      modelCalls.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, auth: headers.get("Authorization") })
      return Response.json({
        id: `gen-${modelCalls.length}`,
        choices: [{ message: { content: reply(modelCalls.length) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: CALL_COST_USD },
      })
    }
    if (url.includes("/fetch-artifact")) return Response.json({ ok: true, bytes: 4 })
    if (url.endsWith("/exec")) {
      execs++
      return Response.json(execs === 1
        ? { ok: true, stdout: JSON.stringify({ isZip: false }), stderr: "", durationMs: 1 }
        : execs === 3 ? { ok: true, stdout: "64", stderr: "", durationMs: 1 }
          : { ok: true, stdout: "", stderr: "", durationMs: 1 })
    }
    if (url.includes("/files?")) return Response.json({ units: [{ sourceText: "In the beginning" }] })
    if (init?.method === "DELETE") return Response.json({ ok: true })
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
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version) VALUES (?, ?, 1)",
  ).bind(PROJECT, JSON.stringify({ smartExtensionsEnabled: true })).run()
  if (!opts.overLimit) return
  // Settled metered usage at 101% of the Free allowance (micro-units = raw µ¢ × 4).
  const plan = (await resolveOrgPlan(env.AQUILLA_PG, ORG))!
  const raw = Math.ceil(plan.weeklyAllowanceUnits! * 1_000_000 * 1.01 / 4)
  await env.AQUILLA_PG.prepare(`INSERT INTO workspace_usage_requests (org_id, request_id, user_id, project_id, rail,
      rate_version, multiplier, period_start, period_end, reserved_micro_units, state, raw_micro_cents,
      settled_micro_units, resolved_at)
    VALUES (?, 'spent', 1, ?, 'llm', '2026-09-cost-v1', 4, ?::timestamptz, ?::timestamptz, ?, 'settled', ?, ?, now())`)
    .bind(ORG, PROJECT, plan.period.start, plan.period.end, raw * 4, raw, raw * 4).run()
}

/** This test's ledger rows (the seeded over-limit row excluded). */
async function ledger() {
  const { results } = await env.AQUILLA_PG.prepare(`SELECT rail, user_id, project_id, mode, state, raw_micro_cents,
      provider_ref FROM workspace_usage_requests WHERE org_id = ? AND request_id <> 'spent' ORDER BY created_at`)
    .bind(ORG).all<{ rail: string; user_id: number | null; project_id: string | null; mode: string
      state: string; raw_micro_cents: number | string | null; provider_ref: string | null }>()
  return results.map((r) => ({ ...r, raw_micro_cents: r.raw_micro_cents === null ? null : Number(r.raw_micro_cents),
    user_id: r.user_id === null ? null : Number(r.user_id) }))
}

const settledRow = (rail: string, userId: number | null) => expect.objectContaining({
  rail, user_id: userId, project_id: PROJECT, mode: "metered", state: "settled", raw_micro_cents: CALL_RAW_MICRO_CENTS,
})

beforeEach(() => {
  __resetAiSpendCeilingStateForTests()
  resetRateCardCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ── the six paths ──────────────────────────────────────────────────────────

const draftCells = (e: Env) => app.request("/api/v1/ai/agent/internal/draft-cells", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SYNC_SECRET_KEY}` },
  body: JSON.stringify({ projectId: PROJECT, userId: 1, fileId: "file-d", cellIds: ["c1"] }),
}, e)

async function seedDraftCell() {
  await env.AQUILLA_PG.prepare("INSERT INTO files (id, project_id, name, event_id) VALUES ('file-d', ?, 'Mark', ?)")
    .bind(PROJECT, crypto.randomUUID()).run()
  await env.AQUILLA_PG.prepare(`INSERT INTO cells (project_id, file_id, cell_id, side, value, event_id, last_edit_at)
    VALUES (?, 'file-d', 'c1', 'source', 'source one', ?, 0)`).bind(PROJECT, crypto.randomUUID()).run()
}

const briefSummary = (e: Env) => app.request("/api/v1/ai/agent/internal/brief-summary", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.SYNC_SECRET_KEY}` },
  body: JSON.stringify({ projectId: PROJECT, userId: 1, l2Markdown: "## Audience\nChildren." }),
}, e)

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
const PROPOSAL = JSON.stringify({
  category: "scripture", confidence: 0.9, explanation: "x", profileName: "p", inputFormat: "bin",
  language: "python", code: "print(1)",
})

const DOC = "77777777-7777-7777-7777-777777777777"
async function seedDoc() {
  await createDoc(env.AQUILLA_PG, {
    id: DOC, scope: { projectId: PROJECT }, name: "g.md", contentType: "text/markdown",
    sizeBytes: 10, sha256: "s", r2Key: `kb/project/${PROJECT}/${DOC}`,
    extractedText: "# A\nalpha body\n# B\nbeta body", createdBy: "alice",
  })
}
const DOC_REPLY = JSON.stringify({ docSummary: "doc", nodes: [{ id: "n1", summary: "a" }, { id: "n2", summary: "b" }] })

const mondayArgs = {
  structure: { columns: [{ id: "num", title: "Progress", type: "numbers" }], groups: [] },
  sampleItems: [],
  summary: { projectId: PROJECT, projectName: "P", project: {}, files: [] } as unknown as ProjectMetricsSummary,
}
const mondayScope = { orgId: ORG, userId: 1, projectId: PROJECT, rail: "llm" as const }
// Airtable's table analysis (AQU-804) reached dev after the spec, through the
// same shared call as Monday (lib/integrations/llm.ts), so it is metered too.
const airtableArgs = {
  structure: {
    fetchedAt: "2026-10-21T00:00:00Z", baseId: "app1", baseName: "B", tableId: "tbl1", tableName: "T",
    primaryFieldId: null, fields: [],
  } satisfies AirtableTableStructure,
  sampleRecords: [],
  summary: mondayArgs.summary,
}

const buildTool = async (e: Env, extra: Record<string, unknown> = {}) => app.request(
  `/api/v2/projects/${PROJECT}/tools/build`,
  {
    method: "POST",
    headers: { ...authHeader(await jwtFor("alice")), "Content-Type": "application/json" },
    body: JSON.stringify({ request: "a word counter", ...extra }),
  },
  e,
)
const REPAIR = { repair: { previousSource: "<p>", previousManifest: "{}", failure: "smoke failed" } }

describe("an org past its allowance is refused before any provider call (enforce)", () => {
  beforeEach(() => seedOrgProject({ overLimit: true }))

  it("DraftCells (#10) answers 402 and drafts nothing", async () => {
    await seedDraftCell()
    stubProviders(() => "[]")
    const res = await draftCells(meterEnv("enforce"))
    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: string }).error).toBe("ai_allowance_exhausted")
    expect(modelCalls).toHaveLength(0)
  })

  it("brief summary (#11) answers 402", async () => {
    stubProviders(() => "summary")
    const res = await briefSummary(meterEnv("enforce"))
    expect(res.status).toBe(402)
    expect(modelCalls).toHaveLength(0)
  })

  it("import sandbox parser model (#12) answers 402", async () => {
    stubProviders(() => PROPOSAL)
    const res = await importParse(meterEnv("enforce"))
    expect(res.status).toBe(402)
    expect(modelCalls).toHaveLength(0)
  })

  it("knowledge indexing (#23) keeps the doc searchable and tells the uploader why", async () => {
    await seedDoc()
    stubProviders(() => DOC_REPLY)
    await indexKnowledgeDoc(meterEnv("enforce"), env.AQUILLA_PG, DOC)
    expect(modelCalls).toHaveLength(0)
    const meta = await getDocMeta(env.AQUILLA_PG, DOC)
    expect(meta?.indexStatus).toBe("ready")
    expect(meta?.indexError).toContain("AI allowance")
  })

  it("Monday analyze (#24) throws the refusal for the route to answer", async () => {
    stubProviders(() => "{}")
    await expect(analyzeBoardMapping(meterEnv("enforce"), mondayScope, mondayArgs)).rejects.toBeInstanceOf(LlmRefusedError)
    expect(modelCalls).toHaveLength(0)
  })

  it("Airtable analyze (shares #24's call) throws the refusal for the route to answer", async () => {
    stubProviders(() => "{}")
    await expect(analyzeTableMapping(meterEnv("enforce"), mondayScope, airtableArgs)).rejects.toBeInstanceOf(LlmRefusedError)
    expect(modelCalls).toHaveLength(0)
  })

  it("tools builder (#25) answers 402", async () => {
    stubProviders(() => "")
    const res = await buildTool(meterEnv("enforce"))
    expect(res.status).toBe(402)
    expect(modelCalls).toHaveLength(0)
  })
})

describe("an admitted call settles the cost the provider reported, one row per call (shadow)", () => {
  beforeEach(() => seedOrgProject({ overLimit: false }))

  it("DraftCells (#10): research + generation are two agent-rail rows as the acting user", async () => {
    await seedDraftCell()
    stubProviders((n) => (n === 1 ? "Evidence." : JSON.stringify([{ i: 1, t: "borrador" }])))
    const res = await draftCells(meterEnv("shadow"))
    expect(res.status).toBe(200)
    expect(modelCalls).toHaveLength(2)
    expect(modelCalls.every((c) => c.auth === "Bearer sk-or-house")).toBe(true)
    expect(await ledger()).toEqual([settledRow("agent", 1), settledRow("agent", 1)])
  })

  it("brief summary (#11): one llm-rail row with the generation id", async () => {
    stubProviders(() => "A brief for children.")
    const res = await briefSummary(meterEnv("shadow"))
    expect(res.status).toBe(200)
    const rows = await ledger()
    expect(rows).toEqual([settledRow("llm", 1)])
    expect(rows[0].provider_ref).toBe("gen-1")
  })

  it("import sandbox parser model (#12): one llm-rail row per parser attempt", async () => {
    stubProviders(() => PROPOSAL)
    const res = await importParse(meterEnv("shadow"))
    expect(res.status).toBe(200)
    expect(modelCalls).toHaveLength(1)
    expect(await ledger()).toEqual([settledRow("llm", 1)])
  })

  it("knowledge indexing (#23): asks for usage.cost and bills the system user", async () => {
    await seedDoc()
    stubProviders(() => DOC_REPLY)
    await indexKnowledgeDoc(meterEnv("shadow"), env.AQUILLA_PG, DOC)
    expect(modelCalls).toHaveLength(1)
    // Without usage.include OpenRouter reports no cost and nothing can settle.
    expect(modelCalls[0].body.usage).toEqual({ include: true })
    expect(await ledger()).toEqual([settledRow("llm", null)])
  })

  it("Monday analyze (#24): keeps the usage.cost it used to throw away", async () => {
    stubProviders(() => JSON.stringify({ mapping: { nonsense: true }, summary: "s" }))
    // The proposal is unusable, but the call was paid for and is on the ledger.
    await expect(analyzeBoardMapping(meterEnv("shadow"), mondayScope, mondayArgs)).rejects.toThrow()
    expect(modelCalls).toHaveLength(1)
    expect(await ledger()).toEqual([settledRow("llm", 1)])
  })

  it("Airtable analyze (shares #24's call): settles the reported cost", async () => {
    stubProviders(() => JSON.stringify({ mapping: { nonsense: true }, summary: "s" }))
    await expect(analyzeTableMapping(meterEnv("shadow"), mondayScope, airtableArgs)).rejects.toThrow()
    expect(modelCalls).toHaveLength(1)
    expect(await ledger()).toEqual([settledRow("llm", 1)])
  })

  it("tools builder (#25): every builder call settles on the llm rail", async () => {
    stubProviders(() => "no tool here")
    const res = await buildTool(meterEnv("shadow"))
    expect(res.status).toBe(200)
    expect(modelCalls).toHaveLength(1)
    expect(await ledger()).toEqual([settledRow("llm", 1)])
  })
})

// The spend ceiling sums both the weekly ledger and the legacy credit ledger,
// so a call written to both would count twice (paid-call.ts, AQU-2062).
describe("one ledger per call", () => {
  beforeEach(() => seedOrgProject({ overLimit: false }))
  const legacyRows = async () => (await env.AQUILLA_PG.prepare(
    "SELECT raw_cost_cents FROM org_credit_usage_daily WHERE org_id = ?",
  ).bind(ORG).all<{ raw_cost_cents: number }>()).results

  it("with the meter on, the call settles on the weekly ledger only", async () => {
    stubProviders(() => "A brief for children.")
    expect((await briefSummary(meterEnv("shadow"))).status).toBe(200)
    expect(await ledger()).toEqual([settledRow("llm", 1)])
    expect(await legacyRows()).toEqual([])
  })

  it("with the meter off, the legacy credit ledger stays the only record", async () => {
    stubProviders(() => "A brief for children.")
    const off = Object.assign(Object.create(meterEnv("shadow")), { BILLING_METER_MODE: "off" }) as Env
    expect((await briefSummary(off)).status).toBe(200)
    expect(await ledger()).toEqual([])
    expect(await legacyRows()).toHaveLength(1)
  })
})

describe("tools builder repair count (#25)", () => {
  beforeEach(() => seedOrgProject({ overLimit: false }))

  it("is counted on the server: a client that always sends attempt 0 still stops at the cap", async () => {
    stubProviders(() => "no tool here")
    for (let i = 0; i < MAX_REPAIR_ATTEMPTS; i++) {
      expect((await buildTool(meterEnv("shadow"), { ...REPAIR, attempt: 0 })).status).toBe(200)
    }
    const over = await buildTool(meterEnv("shadow"), { ...REPAIR, attempt: 0 })
    expect(over.status).toBe(400)
    expect(modelCalls).toHaveLength(MAX_REPAIR_ATTEMPTS)
  })
})
