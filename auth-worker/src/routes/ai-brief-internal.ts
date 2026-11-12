// POST /api/v1/ai/agent/internal/brief-summary — server-to-server L1 brief
// render (AQU-1282 §2).
//
// The external Agent API's `SetBrief` writes the brief's sections into
// `settings.translationBrief`, but the copilot reads only the rendered L1
// summary (`translationBrief.l1Summary`), which until now only the in-app
// brief builder produced through an LLM call. So an agent-written brief was
// invisible to the AI until a human clicked "Regenerate summary". This
// endpoint renders that summary on the server, with the SAME prompt and cap
// the builder uses (db/shared/brief.ts mirrors src/lib/brief/brief-generator.ts),
// so sync-worker's RegenerateBriefSummary command and the SetBrief auto-render
// can produce it with no in-app step.
//
// Like draft-cells this endpoint NEVER writes: it returns `{ summary, model }`
// and the caller owns the version-guarded settings write.
//
// Cost rails (identical to ai-draft-internal.ts): the model allowlist + AI
// budget (runAiGuard), creditGuard on the `agent` rail BEFORE the paid call,
// recordCredit after it. AQU-2063: the call is admitted by checkAiEntitlement
// on the `llm` rail (spec §3.2 row 11), which also runs the platform spend
// ceiling, and settles its reported usage.cost on the weekly meter.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { secureCompare } from "../utils/secure-compare"
import { runAiGuard } from "../lib/ai-budget"
import { getPlatformSettingsCached } from "../lib/platform-settings"
import { creditGuard, recordCredit } from "../lib/credits"
import { DEFAULT_LLM_MODEL_ID } from "../lib/model-defaults"
import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import { BRIEF_L1_MAX_CHARS, BRIEF_L1_SYSTEM_PROMPT } from "../../../db/shared/brief"
import { admitLlmCall, legacyLedgers, projectOrgId } from "../lib/billing/paid-llm"
import { providerRejectedPreModel } from "../lib/billing/chat-usage"
import {
  logVendorTimeout,
  vendorDeadline,
  vendorTimeoutMessage,
} from "../../../shared/vendor-timeouts"

const aiBriefInternal = new Hono<{ Bindings: Env; Variables: Variables }>()

/** SetBrief's floor — the brief is a MAINTAINER-only settings key. */
const REQUIRED_ROLE_BRIEF = 600

/** Generous ceiling over 11 × 4000-char sections + 8000-char notes. */
const L2_MAX_CHARS = 60_000

/** Output cap — also the bound the meter reserves against. */
const BRIEF_MAX_TOKENS = 1024

const bodySchema = z.object({
  projectId: z.string().min(1),
  /** The user the render acts as — role is resolved live, never trusted. */
  userId: z.union([z.string().min(1), z.number()]),
  l2Markdown: z.string().min(1).max(L2_MAX_CHARS),
})

interface UpstreamJson {
  choices?: { message?: { content?: string | null } }[]
  usage?: { cost?: number }
  error?: { message?: string }
}

function resolveOpenRouterUrl(env: Env): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"
}

aiBriefInternal.post("/internal/brief-summary", zValidator("json", bodySchema), async (c) => {
  const authHeader = c.req.header("Authorization")
  if (!c.env.SYNC_SECRET_KEY || !secureCompare(authHeader ?? "", `Bearer ${c.env.SYNC_SECRET_KEY}`)) {
    return c.json({ error: "unauthorized" }, 401)
  }

  const body = c.req.valid("json")
  const db = c.env.AQUILLA_PG
  if (!db) return c.json({ error: "job_failed", message: "AQUILLA_PG not configured" }, 500)

  const role = await resolveProjectRoleShared(db, { id: String(body.userId) }, body.projectId)
  if (!role || role.level < REQUIRED_ROLE_BRIEF) {
    return c.json({ error: "permission_denied", message: "rendering the brief summary needs the maintainer role" }, 403)
  }

  const platformSettings = await getPlatformSettingsCached(c.env)
  const model = platformSettings.agentModel || c.env.AGENT_MODEL_DEFAULT || DEFAULT_LLM_MODEL_ID

  const guard = await runAiGuard(model, Number(body.userId), db, c.env)
  if (!guard.ok) return c.json(guard.body, guard.status)

  let projectOrg: number | null = null
  try {
    projectOrg = await projectOrgId(db, body.projectId)
  } catch {
    /* best-effort — degrade to org-less so spend is still recorded */
  }
  const orgId = projectOrg ?? 0
  // One ledger per call (paid-call.ts): legacy credits only while the meter is off.
  const legacy = legacyLedgers(c.env, c.req.url)

  const creditCheck = legacy ? await creditGuard(db, c.env, orgId, "agent") : { ok: true as const }
  if (!creditCheck.ok) {
    return c.json(
      {
        error: "credit_cap_exceeded",
        reason: creditCheck.reason,
        message: "Agent credit cap reached. Contact your org admin.",
      },
      429,
    )
  }

  const userContent = `Summarize this translation brief:\n\n${body.l2Markdown}`
  const call = await admitLlmCall(
    db, c.env,
    { orgId: projectOrg, userId: Number(body.userId), projectId: body.projectId, rail: "llm" },
    { model, promptChars: BRIEF_L1_SYSTEM_PROMPT.length + userContent.length, maxOutputTokens: BRIEF_MAX_TOKENS },
    { requestUrl: c.req.url },
  )
  if (!call.ok) return c.json(call.body, call.status)

  // AQU-1849: deadline on the provider's answer (`stream: false`, so the
  // headers wait for the whole completion), linked to the caller's signal.
  // This runs behind sync-worker's brief-summary bridge, so an unbounded call
  // held BOTH workers' invocations open on one hung provider.
  const deadline = vendorDeadline("openRouterNonStreaming", c.req.raw.signal)
  let res: Response
  try {
    res = await fetch(resolveOpenRouterUrl(c.env), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${call.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: BRIEF_L1_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        stream: false,
        usage: { include: true },
        temperature: 0.2,
        max_tokens: BRIEF_MAX_TOKENS,
      }),
      signal: deadline.signal,
    })
  } catch (err) {
    if (deadline.timedOut()) {
      logVendorTimeout("openRouterNonStreaming", err)
      return c.json({ error: "job_failed", message: vendorTimeoutMessage("openRouterNonStreaming") }, 504)
    }
    return c.json({ error: "job_failed", message: "brief summary model unreachable" }, 502)
  } finally {
    deadline.clear()
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    // A gateway-side 4xx proves no generation ran; anything else stays held.
    if (providerRejectedPreModel(res.status, text)) await call.release()
    return c.json({ error: "job_failed", message: `brief summary model failed (${res.status}): ${text.slice(0, 300)}` }, 502)
  }
  let data: UpstreamJson
  try {
    data = (await res.json()) as UpstreamJson
  } catch {
    return c.json({ error: "job_failed", message: "brief summary model returned an unreadable response" }, 502)
  }

  // Meter whatever was spent, success or failure. Never throws.
  const costCents = (await call.settleFrom(data)) ?? 0
  if (legacy && costCents > 0) await recordCredit(db, orgId, Number(body.userId), "agent", costCents, 1)

  if (data.error?.message) {
    return c.json({ error: "job_failed", message: `brief summary model: ${data.error.message}` }, 502)
  }

  const text = (data.choices?.[0]?.message?.content ?? "").trim()
  if (!text) {
    return c.json({ error: "job_failed", message: "brief summary model returned no text" }, 502)
  }
  // AQU-1323: the caller cannot infer the cap from the returned length (the
  // slice is trimEnd'd, so a truncated summary can come back under the cap).
  // Report the fact, so a receipt can say "the summary dropped content" rather
  // than presenting a clipped L1 as a clean render.
  const truncated = text.length > BRIEF_L1_MAX_CHARS
  const summary = truncated ? text.slice(0, BRIEF_L1_MAX_CHARS).trimEnd() : text

  return c.json({ summary, model, truncated })
})

export default aiBriefInternal
