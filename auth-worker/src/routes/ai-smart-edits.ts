// POST /api/v1/ai/smart-edits/suggest  — suggestions for one passage
// POST /api/v1/ai/smart-edits/feedback — accept / dismiss a shown suggestion
//
// Smart edits distil what the project's translators have already corrected —
// AI draft → human and human → human — into suggestions for the passage being
// read. Tiers, cheapest first:
//
//   0. memory  (src/lib/smart-edits/suggest.ts) — algorithmic, from
//      smart_edit_observations, with keeps / reverts / dismissals as
//      counter-evidence. Confident ones are shown as they are.
//   1. jev     (src/lib/smart-edits/jev-request.ts) — uncertain tier-0
//      suggestions go to Jev in ONE batched call per passage, which picks
//      "keep" or the wording to emulate. Only a confident pick is shown.
//   2. llm     (POST /llm, src/lib/smart-edits/llm.ts) — one cell, on an
//      explicit click, behind the opt-in `smartEditsLlm` flag. Metered like
//      every other LLM call (runAiGuard + weekly ledger / legacy credits, same
//      path as routes/import-classify.ts), with the team's past corrections as
//      context, and reduced to exact-span edits before anything is returned.
//
// Like the seam route, this never fails its caller: no key, a timeout, an
// upstream error or the rate cap all degrade to tier-0-only suggestions, and
// `jev` in the response says which. Jev stays outside the credit guard for the
// same reason as ai-seams.ts: it is pinned, never user-selectable, and costs
// fractions of a cent; volume is bounded by a per-user window instead.
//
// Kill switch: SMART_EDITS=off answers every request with no suggestions.

import { Hono, type Context } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { ROLE } from "../types"
import { authMiddleware } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../../db/shared/rate-limit"
import { callJev } from "../lib/jev/client"
import { JEV_MODEL } from "../../../src/lib/completion/seam-request"
import {
  findCandidates,
  scoreCandidates,
  selectForDisplay,
  type ScoredSuggestion,
} from "../../../src/lib/smart-edits/suggest"
import {
  buildVerifyRequest,
  KEEP,
  MAX_VERIFY_PER_REQUEST,
  parseVerifyAnswers,
  VERIFY_MIN_PROBABILITY,
} from "../../../src/lib/smart-edits/jev-request"
import { cellKeyOf, minePass } from "../lib/smart-edits/miner"
import { loadObservations, loadScoreInputs, passagePhraseKeys } from "../lib/smart-edits/memory-read"
import { buildLlmMessages, LLM_MAX_TOKENS, parseLlmEdits } from "../../../src/lib/smart-edits/llm"
import { tokenize } from "../../../src/lib/smart-edits/tokens"
import { runAiGuard } from "../lib/ai-budget"
import { creditGuard, recordCredit } from "../lib/credits"
import { countWords } from "../lib/billing/plans"
import { recordWords, wordCapBody, wordGuard } from "../lib/billing/words"
import { admitChatUsage, providerRejectedPreModel, releaseChatUsage, settleChatUsage, type ChatUsage } from "../lib/billing/chat-usage"
import { weeklyUsageActive } from "../lib/billing/usage-mode"
import { getPlatformSettingsCached } from "../lib/platform-settings"
import { openRouterExtras } from "../lib/llm-vendor"
import { DEFAULT_LLM_MODEL_ID } from "../lib/model-defaults"
import type { Observation } from "../../../src/lib/smart-edits/suggest"

type AppEnv = { Bindings: Env; Variables: Variables }
const aiSmartEdits = new Hono<AppEnv>()

const MAX_CELLS = 60
const MAX_CELL_CHARS = 4_000
const SUGGEST_MAX_PER_USER_PER_WINDOW = 400
const JEV_TIMEOUT_MS = 8_000
/** Background mining passes per request after the synchronous one. */
const BACKGROUND_PASSES = 4

const cellSchema = z.object({
  fileId: z.string().trim().min(1).max(255),
  cellId: z.string().trim().min(1).max(255),
  source: z.string().max(MAX_CELL_CHARS),
  target: z.string().max(MAX_CELL_CHARS),
})

const suggestSchema = z.object({
  projectId: z.string().trim().min(1).max(255),
  /** Target lane legacy tag ('' = the file's default lane). */
  lane: z.string().max(64).default(""),
  cells: z.array(cellSchema).min(1).max(MAX_CELLS),
  /** false = tier 0 only (the replay eval's baseline, and a client that wants
   *  zero model spend). Default true. */
  verify: z.boolean().default(true),
})

const feedbackSchema = z.object({
  projectId: z.string().trim().min(1).max(255),
  lane: z.string().max(64).default(""),
  fileId: z.string().trim().min(1).max(255),
  cellId: z.string().trim().min(1).max(255),
  oldNorm: z.string().min(1).max(500),
  newNorm: z.string().max(500),
  action: z.enum(["accept", "dismiss"]),
  tier: z.enum(["memory", "jev", "llm"]),
})

export interface SmartEditSuggestion {
  fileId: string
  cellId: string
  start: number
  end: number
  old: string
  oldNorm: string
  new: string
  newNorm: string
  confidence: number
  tier: "memory" | "jev" | "llm"
  /** LLM tier only: the model's one-sentence reason. */
  reason?: string
  support: ScoredSuggestion["support"]
  examples: { source: string; before: string; after: string; ts: number; fromAiDraft: boolean }[]
}

function runInBackground(c: Context<AppEnv>, task: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    void task
  }
}

async function mineMore(db: Env["AQUILLA_PG"], projectId: string): Promise<void> {
  for (let i = 0; i < BACKGROUND_PASSES; i++) {
    const r = await minePass(db, projectId)
    if (!r.more) return
  }
}

aiSmartEdits.post("/suggest", authMiddleware, zValidator("json", suggestSchema), async (c) => {
  const input = c.req.valid("json")
  const user = c.get("user")
  if (c.env.SMART_EDITS?.trim().toLowerCase() === "off") return c.json({ suggestions: [], disabled: true })

  const role = await resolveProjectRole(c.env, user, input.projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return c.json({ error: "permission_denied", message: "Project access is required." }, 403)
  }

  const db = c.env.AQUILLA_PG
  const identifier = `user:${user.id}`
  const recent = await countRecentRateLimitEvents(db, "ai_smart_edits", identifier)
  if (recent >= SUGGEST_MAX_PER_USER_PER_WINDOW) return c.json({ suggestions: [], rateLimited: true })
  await recordRateLimitEvent(db, "ai_smart_edits", identifier)

  // Fold in edits made since the last request (bounded), then keep going in
  // the background if a backlog remains. A failed pass never blocks reading.
  try {
    const pass = await minePass(db, input.projectId)
    if (pass.more) runInBackground(c, mineMore(db, input.projectId).catch((err) => console.warn("[smart-edits] mine", err)))
  } catch (err) {
    console.warn("[smart-edits] mine pass failed:", err)
  }

  const cellsById = new Map(input.cells.map((cell) => [cellKeyOf(cell.fileId, cell.cellId, input.lane), cell]))
  const passage = [...cellsById.entries()].map(([id, cell]) => ({ id, source: cell.source, target: cell.target }))
  // An unreadable memory (e.g. migration 0130 not yet applied on this
  // database) is "no suggestions", never a 500 — nobody asked for these.
  let observations: Observation[]
  let candidates: ReturnType<typeof findCandidates>
  let scoreInputs: Awaited<ReturnType<typeof loadScoreInputs>>
  try {
    observations = await loadObservations(db, input.projectId, input.lane, passagePhraseKeys(passage.map((p) => p.target)))
    candidates = findCandidates(passage, observations)
    if (candidates.length === 0) return c.json({ suggestions: [], jev: "skipped" })
    scoreInputs = await loadScoreInputs(db, input.projectId, input.lane, candidates, observations)
  } catch (err) {
    console.warn("[smart-edits] memory unavailable:", err)
    return c.json({ suggestions: [], unavailable: true })
  }
  const selected = selectForDisplay(scoreCandidates(candidates, scoreInputs))

  const shown: { s: ScoredSuggestion; tier: "memory" | "jev" }[] = selected
    .filter((s) => s.tier === "show")
    .map((s) => ({ s, tier: "memory" as const }))
  const toVerify = selected.filter((s) => s.tier === "verify").slice(0, MAX_VERIFY_PER_REQUEST)

  let jev: "skipped" | "model" | "no_key" | "timeout" | "upstream" = "skipped"
  if (input.verify && toVerify.length > 0) {
    const request = buildVerifyRequest(JEV_MODEL, passage, toVerify)
    const called = await callJev(c.env, request, JEV_TIMEOUT_MS)
    if (!called.ok) {
      jev = called.reason
    } else {
      jev = "model"
      parseVerifyAnswers(called.body, toVerify.length).forEach((a, i) => {
        if (!a || a.choice === KEEP || a.probability < VERIFY_MIN_PROBABILITY) return
        const s = toVerify[i]
        const pick = a.choice === 0 ? { new: s.new, newNorm: s.newNorm } : s.alternatives[a.choice - 1]
        if (!pick) return
        shown.push({ s: { ...s, new: pick.new, newNorm: pick.newNorm, confidence: a.probability }, tier: "jev" })
      })
    }
  }

  const suggestions: SmartEditSuggestion[] = shown.map(({ s, tier }) => {
    const cell = cellsById.get(s.cellId)!
    return {
      fileId: cell.fileId,
      cellId: cell.cellId,
      start: s.start,
      end: s.end,
      old: s.old,
      oldNorm: s.oldNorm,
      new: s.new,
      newNorm: s.newNorm,
      confidence: s.confidence,
      tier,
      support: s.support,
      examples: s.examples.map((e) => ({
        source: e.sourceText,
        before: e.beforeText,
        after: e.afterText,
        ts: e.ts,
        fromAiDraft: e.beforeOrigin === "ai",
      })),
    }
  })
  return c.json({ suggestions, jev })
})

aiSmartEdits.post("/feedback", authMiddleware, zValidator("json", feedbackSchema), async (c) => {
  const input = c.req.valid("json")
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, input.projectId)
  if (!role || role.level < ROLE.VIEWER) {
    return c.json({ error: "permission_denied", message: "Project access is required." }, 403)
  }
  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO smart_edit_feedback (id, project_id, lane, user_id, file_id, cell_id, old_norm, new_norm, action, tier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      input.projectId,
      input.lane,
      String(user.id),
      input.fileId,
      input.cellId,
      input.oldNorm,
      input.newNorm,
      input.action,
      input.tier,
    )
    .run()
  return c.json({ ok: true })
})

const llmSchema = z.object({
  projectId: z.string().trim().min(1).max(255),
  lane: z.string().max(64).default(""),
  fileId: z.string().trim().min(1).max(255),
  cellId: z.string().trim().min(1).max(255),
  source: z.string().max(MAX_CELL_CHARS),
  target: z.string().min(1).max(MAX_CELL_CHARS),
  neighbors: z.array(z.object({ source: z.string().max(MAX_CELL_CHARS), target: z.string().max(MAX_CELL_CHARS) })).max(6).default([]),
})

/** Past corrections most relevant to this cell: edits of wordings it contains,
 *  ranked by how much of their source overlaps this cell's source. One per
 *  (old → new) so six examples are six different lessons. */
function rankEvidence(observations: readonly Observation[], source: string): Observation[] {
  const src = new Set(tokenize(source).map((t) => t.norm))
  const seen = new Set<string>()
  return [...observations]
    .map((o) => ({ o, overlap: o.sourceNorms.filter((t) => src.has(t)).length }))
    .sort((a, b) => b.overlap - a.overlap || b.o.ts - a.o.ts)
    .filter(({ o }) => {
      const k = `${o.oldNorm}\u0000${o.newNorm}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .map(({ o }) => o)
}

function resolveOpenRouterUrl(env: Env): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"
}

aiSmartEdits.post("/llm", authMiddleware, zValidator("json", llmSchema), async (c) => {
  const input = c.req.valid("json")
  const user = c.get("user")
  if (c.env.SMART_EDITS?.trim().toLowerCase() === "off") return c.json({ suggestions: [], disabled: true })
  // Spends credits and proposes changes: contributors and up.
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

  try {
    await minePass(db, input.projectId)
  } catch (err) {
    console.warn("[smart-edits] mine pass failed:", err)
  }
  // The team's corrections are context, not a precondition: if the memory
  // cannot be read, the model still gets the source and the passage.
  let observations: Observation[] = []
  try {
    observations = await loadObservations(db, input.projectId, input.lane, passagePhraseKeys([input.target]))
  } catch (err) {
    console.warn("[smart-edits] memory unavailable for llm:", err)
  }
  const messages = buildLlmMessages(
    { source: input.source, target: input.target, neighbors: input.neighbors },
    rankEvidence(observations, input.source),
  )

  // Billing: identical to routes/import-classify.ts — weekly ledger when it is
  // active, legacy credit + word guards otherwise.
  let usage: ChatUsage | undefined
  const weekly = weeklyUsageActive(c.env, c.req.url)
  if (weekly === "unavailable") return c.json({ error: "usage_rehearsal_unavailable" }, 503)
  if (weekly === "on") {
    if (orgId <= 0) return c.json({ error: "forbidden" }, 403)
    const suppliedId = c.req.header("Idempotency-Key")
    if (suppliedId && !z.string().uuid().safeParse(suppliedId).success) return c.json({ error: "invalid_request_id" }, 400)
    usage = { orgId, requestId: suppliedId ?? crypto.randomUUID() }
  }
  if (!usage) {
    const credits = await creditGuard(db, c.env, orgId, "llm")
    if (!credits.ok) {
      return c.json({ error: "credit_cap_exceeded", reason: credits.reason, message: "LLM credit cap reached. Contact your org admin." }, 429)
    }
    const words = await wordGuard(db, orgId)
    if (!words.ok) return c.json(wordCapBody(words.reason), 429)
  }
  if (usage) {
    try {
      const created = await admitChatUsage(c.env, {
        ...usage, userId: user.id, projectId: input.projectId, model,
        promptChars: messages.reduce((n, m) => n + m.content.length, 0), maxOutputTokens: LLM_MAX_TOKENS,
      })
      if (!created) return c.json({ error: "usage_request_already_admitted" }, 409)
    } catch (error) {
      if (error instanceof Error && error.message === "Weekly AI allowance exhausted") {
        return c.json({ error: "weekly_ai_allowance_exhausted", message: "This workspace has used its available AI allowance. Try again after the weekly reset or update its plan." }, 429)
      }
      if (error instanceof Error && error.message === "Model price unavailable") return c.json({ error: "model_price_unavailable" }, 503)
      return c.json({ error: "usage_accounting_unavailable" }, 503)
    }
  }

  try {
    const upstream = await fetch(resolveOpenRouterUrl(c.env), {
      method: "POST",
      headers: { Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: LLM_MAX_TOKENS,
        stream: false,
        ...openRouterExtras(c.env.OPENROUTER_BASE_URL),
        response_format: { type: "json_object" },
      }),
      signal: c.req.raw.signal,
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
      await recordWords(db, orgId, user.id, "llm", countWords(input.target))
    }
    const edits = parseLlmEdits(data.choices?.[0]?.message?.content ?? "", input.target)
    const suggestions: SmartEditSuggestion[] = edits.map((e) => ({
      fileId: input.fileId,
      cellId: input.cellId,
      start: e.start,
      end: e.end,
      old: e.old,
      oldNorm: tokenize(e.old).map((t) => t.norm).join(" "),
      new: e.new,
      newNorm: tokenize(e.new).map((t) => t.norm).join(" "),
      confidence: 0,
      tier: "llm",
      reason: e.reason,
      support: { strong: 0, weak: 0, keeps: 0, reverted: 0, conflicts: 0, dismissed: 0 },
      examples: [],
    }))
    return c.json({ suggestions })
  } catch (error) {
    console.error("[smart-edits] llm failed:", error)
    return c.json({ error: "llm_unavailable", message: error instanceof Error ? error.message : String(error) }, 502)
  }
})

export default aiSmartEdits
