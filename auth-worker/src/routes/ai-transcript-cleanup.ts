// Two-step transcription, step 2 (docs/superpowers/specs/2026-10-23-transcript-cleanup-design.md §3).
//
//   POST /api/v1/ai/transcript-cleanup
//
// One recording at a time: what ASR heard (after the project's learned word
// fixes), the lane's heard → corrected pairs, corrected-only transcripts, key
// terms and — for a source segment only — its neighbours. Returns the cleaned
// transcript and a note per change. The prompt and the parser live in
// src/lib/transcript-cleanup/prompt.ts, shared with the client's tests.
//
// Billed like every other LLM call: the same gate and fallbacks as the smart
// edits LLM tier (routes/ai-smart-edits.ts `/llm`). Contributors and up, since
// the result lands as a transcript correction.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { ROLE } from "../types"
import { authMiddleware } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import { runAiGuard } from "../lib/ai-budget"
import { creditGuard, recordCredit } from "../lib/credits"
import { countWords } from "../lib/billing/plans"
import { recordWords, wordCapBody, wordGuard } from "../lib/billing/words"
import { openRouterEstimate, providerRejectedPreModel, releaseChatUsage, settleChatUsage } from "../lib/billing/chat-usage"
import { admitPaidCall } from "../lib/billing/paid-call"
import { getPlatformSettingsCached } from "../lib/platform-settings"
import { openRouterExtras } from "../lib/llm-vendor"
import { DEFAULT_LLM_MODEL_ID } from "../lib/model-defaults"
import {
  buildCleanupMessages,
  CLEANUP_MAX_CONTEXT,
  CLEANUP_MAX_PAIRS,
  CLEANUP_MAX_TERMS,
  CLEANUP_MAX_TOKENS,
  parseCleanupResult,
} from "../../../src/lib/transcript-cleanup/prompt"
import {
  logVendorTimeout,
  vendorDeadline,
  vendorTimeoutMessage,
} from "../../../shared/vendor-timeouts"

type AppEnv = { Bindings: Env; Variables: Variables }
const aiTranscriptCleanup = new Hono<AppEnv>()

const MAX_TEXT = 4_000

const cleanupSchema = z.object({
  projectId: z.string().trim().min(1).max(255),
  heard: z.string().trim().min(1).max(MAX_TEXT),
  language: z.string().max(120).nullish(),
  pairs: z.array(z.object({ heard: z.string().max(MAX_TEXT), corrected: z.string().max(MAX_TEXT) }))
    .max(CLEANUP_MAX_PAIRS).default([]),
  correctedOnly: z.array(z.string().max(MAX_TEXT)).max(CLEANUP_MAX_PAIRS).default([]),
  terms: z.array(z.object({ term: z.string().max(200), note: z.string().max(400).optional() }))
    .max(CLEANUP_MAX_TERMS).default([]),
  context: z.array(z.string().max(MAX_TEXT)).max(CLEANUP_MAX_CONTEXT).default([]),
})

function resolveOpenRouterUrl(env: Env): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"
}

aiTranscriptCleanup.post("/", authMiddleware, zValidator("json", cleanupSchema), async (c) => {
  const input = c.req.valid("json")
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, input.projectId)
  if (!role || role.level < ROLE.CONTRIBUTOR) {
    return c.json({ error: "permission_denied", message: "Contributor access is required." }, 403)
  }
  if (!c.env.OPENROUTER_API_KEY) return c.json({ error: "llm_unavailable", message: "AI is not configured" }, 503)

  const db = c.env.AQUILLA_PG
  const settings = await getPlatformSettingsCached(c.env)
  const model = settings.defaultLlmModel || c.env.DEFAULT_LLM_MODEL || DEFAULT_LLM_MODEL_ID
  const aiGuard = await runAiGuard(model, user.id, db, c.env)
  if (!aiGuard.ok) return c.json(aiGuard.body, aiGuard.status)

  const project = await db.prepare("SELECT org_id FROM projects WHERE id = ?").bind(input.projectId).first<{ org_id: number | null }>()
  const orgId = project?.org_id ?? 0

  const messages = buildCleanupMessages({
    heard: input.heard,
    language: input.language ?? null,
    pairs: input.pairs,
    correctedOnly: input.correctedOnly,
    terms: input.terms,
    context: input.context,
  })

  const gate = await admitPaidCall(c.env, {
    orgId, userId: user.id, projectId: input.projectId, rail: "llm",
    requestUrl: c.req.url, idempotencyKey: c.req.header("Idempotency-Key"),
    estimate: openRouterEstimate(c.env, { model,
      promptChars: messages.reduce((n, m) => n + m.content.length, 0), maxOutputTokens: CLEANUP_MAX_TOKENS }),
  })
  if (!gate.ok) return c.json(gate.body, gate.status)
  const { usage, apiKey } = gate
  if (!usage) {
    const credits = await creditGuard(db, c.env, orgId, "llm")
    if (!credits.ok) {
      return c.json({ error: "credit_cap_exceeded", reason: credits.reason, message: "LLM credit cap reached. Contact your org admin." }, 429)
    }
    const words = await wordGuard(db, orgId)
    if (!words.ok) return c.json(wordCapBody(words.reason), 429)
  }

  const deadline = vendorDeadline("openRouterNonStreaming", c.req.raw.signal)
  try {
    const upstream = await fetch(resolveOpenRouterUrl(c.env), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: CLEANUP_MAX_TOKENS,
        stream: false,
        ...openRouterExtras(c.env.OPENROUTER_BASE_URL),
        response_format: { type: "json_object" },
      }),
      signal: deadline.signal,
    })
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "")
      if (usage) {
        c.header("X-Billing-Usage-Status", providerRejectedPreModel(upstream.status, detail)
          ? await releaseChatUsage(c.env, usage)
          : "pending")
      }
      return c.json({ error: "llm_upstream_error", message: detail.slice(0, 500) || `Upstream returned ${upstream.status}` }, 502)
    }
    const data = await upstream.json() as { choices?: { message?: { content?: string } }[]; usage?: { cost?: number } }
    if (usage) c.header("X-Billing-Usage-Status", await settleChatUsage(c.env, usage, data))
    if (!usage) {
      const cost = typeof data.usage?.cost === "number" && data.usage.cost > 0 ? data.usage.cost * 100 : 1
      await recordCredit(db, orgId, user.id, "llm", cost, 1)
      await recordWords(db, orgId, user.id, "llm", countWords(input.heard))
    }
    const result = parseCleanupResult(data.choices?.[0]?.message?.content ?? "", input.heard)
    return c.json({ model, result })
  } catch (error) {
    if (deadline.timedOut()) {
      logVendorTimeout("openRouterNonStreaming", error)
      return c.json({ error: "llm_timeout", message: vendorTimeoutMessage("openRouterNonStreaming") }, 504)
    }
    console.error("[transcript-cleanup] llm failed:", error)
    return c.json({ error: "llm_unavailable", message: "Transcript cleanup is temporarily unavailable" }, 502)
  } finally {
    deadline.clear()
  }
})

export default aiTranscriptCleanup
