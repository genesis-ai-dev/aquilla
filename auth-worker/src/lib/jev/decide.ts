/**
 * jev/decide.ts — shared server-side Jev decisions
 * (docs/superpowers/specs/2026-09-30-jev-react-decisions-design.md §1).
 *
 * A caller brings its state, its questions, and a fixed-rule fallback with the
 * same keys. decide() never throws and always returns an answer per key: a
 * missing key, the kill switch, the per-project cap, a timeout, or an upstream
 * error all hand back the fallback, and `decidedBy` says which produced what.
 * It stores nothing — each caller records the decision next to the thing it
 * decided.
 *
 * Jev stays outside the credit guard (same call as the seam route): it is not a
 * drafting model and must never become user-selectable. Spend is bounded by a
 * per-project sliding window instead.
 */

import type { Env } from "../../types"
import { countRecentRateLimitEvents, recordRateLimitEvent } from "../../../../db/shared/rate-limit"
import { JEV_MODEL, type JevQuestion } from "../../../../src/lib/completion/seam-request"
import { callJev } from "./client"

export type { JevQuestion }

/** 120 an hour, expressed in the shared limiter's fixed 15-minute window. */
export const JEV_PROJECT_CAP_PER_WINDOW = 30
const RATE_LIMIT_KIND = "jev_decisions"
const DEFAULT_TIMEOUT_MS = 10_000

export type JevPurpose = "react" | "triage"

export type JevAnswer =
  | { kind: "noul"; p: number }
  | { kind: "score"; score: number; probabilities?: Record<string, number> }

export interface DecideInput {
  purpose: JevPurpose
  projectId: string
  state: Record<string, unknown>
  questions: Record<string, JevQuestion>
  fallback: () => Record<string, JevAnswer>
  /** Absolute epoch ms. A sweep shares one budget across its calls. */
  deadline?: number
}

export type DecideReason = "disabled" | "no_key" | "capped" | "timeout" | "upstream" | "partial"

export interface DecideResult {
  answers: Record<string, JevAnswer>
  decidedBy: "model" | "heuristic" | "mixed"
  reason?: DecideReason
  model: string | null
  usage: { input_tokens: number; output_tokens: number } | null
}

function parseAnswer(raw: unknown, question: JevQuestion): JevAnswer | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const a = raw as { noul?: unknown; score?: unknown; probabilities?: unknown }
  if (question.type === "noul") {
    return typeof a.noul === "number" && Number.isFinite(a.noul) ? { kind: "noul", p: a.noul } : undefined
  }
  if (typeof a.score !== "number" || !Number.isFinite(a.score)) return undefined
  const probabilities: Record<string, number> = {}
  if (a.probabilities && typeof a.probabilities === "object") {
    for (const [k, v] of Object.entries(a.probabilities as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) probabilities[k] = v
    }
  }
  return { kind: "score", score: a.score, ...(Object.keys(probabilities).length ? { probabilities } : {}) }
}

function usageOf(body: unknown): DecideResult["usage"] {
  const u = body && typeof body === "object" ? (body as { usage?: unknown }).usage : undefined
  if (!u || typeof u !== "object") return null
  const { input_tokens, output_tokens } = u as Record<string, unknown>
  return typeof input_tokens === "number" && typeof output_tokens === "number"
    ? { input_tokens, output_tokens }
    : null
}

export async function decide(env: Env, input: DecideInput): Promise<DecideResult> {
  const heuristic = (reason: DecideReason): DecideResult => ({
    answers: input.fallback(),
    decidedBy: "heuristic",
    reason,
    model: null,
    usage: null,
  })

  if (input.purpose === "react" && env.JEV_REACT?.trim().toLowerCase() === "off") return heuristic("disabled")
  if (!env.OPENROUTER_API_KEY) return heuristic("no_key")
  const timeoutMs = input.deadline === undefined ? DEFAULT_TIMEOUT_MS : Math.min(DEFAULT_TIMEOUT_MS, input.deadline - Date.now())
  if (timeoutMs <= 0) return heuristic("timeout")

  const identifier = `project:${input.projectId}`
  const recent = await countRecentRateLimitEvents(env.AQUILLA_PG, RATE_LIMIT_KIND, identifier)
  if (recent >= JEV_PROJECT_CAP_PER_WINDOW) return heuristic("capped")
  await recordRateLimitEvent(env.AQUILLA_PG, RATE_LIMIT_KIND, identifier)

  const called = await callJev(env, { model: JEV_MODEL, state: input.state, questions: input.questions }, timeoutMs)
  if (!called.ok) return heuristic(called.reason)

  const raw = (called.body as { answers?: Record<string, unknown> } | null)?.answers ?? {}
  const fallback = input.fallback()
  const answers: Record<string, JevAnswer> = {}
  let fromModel = 0
  for (const [key, question] of Object.entries(input.questions)) {
    const parsed = parseAnswer(raw[key], question)
    if (parsed) fromModel += 1
    answers[key] = parsed ?? fallback[key]
  }
  const total = Object.keys(input.questions).length
  if (fromModel === 0) return heuristic("upstream")
  return {
    answers,
    decidedBy: fromModel === total ? "model" : "mixed",
    ...(fromModel === total ? {} : { reason: "partial" as const }),
    model: JEV_MODEL,
    usage: usageOf(called.body),
  }
}
