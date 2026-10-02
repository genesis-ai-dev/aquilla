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
//   2. llm     — not here: opt-in, on click, client-initiated.
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
  tier: "memory" | "jev"
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
  const observations = await loadObservations(db, input.projectId, input.lane, passagePhraseKeys(passage.map((p) => p.target)))
  const candidates = findCandidates(passage, observations)
  if (candidates.length === 0) return c.json({ suggestions: [], jev: "skipped" })

  const scoreInputs = await loadScoreInputs(db, input.projectId, input.lane, candidates, observations)
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

export default aiSmartEdits
