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
/**
 * AQU-1690: autopilot's Bible data questions — one batched call per span, plus
 * one per expectation repair. Its own bucket, so a long run can never use up
 * the cap react and triage share.
 */
export const JEV_BIBLE_QA_CAP_PER_WINDOW = 120
const DEFAULT_TIMEOUT_MS = 10_000

export type JevPurpose = "react" | "triage" | "bible-qa"

/** The rate-limit bucket and cap for each purpose. React and triage share one, as they always have. */
const PURPOSE_LIMITS: Readonly<Record<JevPurpose, { kind: string; cap: number }>> = {
  react: { kind: "jev_decisions", cap: JEV_PROJECT_CAP_PER_WINDOW },
  triage: { kind: "jev_decisions", cap: JEV_PROJECT_CAP_PER_WINDOW },
  "bible-qa": { kind: "jev_bible_qa", cap: JEV_BIBLE_QA_CAP_PER_WINDOW },
}

/** Each purpose's kill switch: the env var that, set to "off", keeps that purpose on its fixed rules. */
function switchedOff(env: Env, purpose: JevPurpose): boolean {
  const flag = purpose === "react" ? env.JEV_REACT : purpose === "bible-qa" ? env.JEV_BIBLE_QA : undefined
  return flag?.trim().toLowerCase() === "off"
}

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

  if (switchedOff(env, input.purpose)) return heuristic("disabled")
  if (!env.OPENROUTER_API_KEY) return heuristic("no_key")
  const timeoutMs = input.deadline === undefined ? DEFAULT_TIMEOUT_MS : Math.min(DEFAULT_TIMEOUT_MS, input.deadline - Date.now())
  if (timeoutMs <= 0) return heuristic("timeout")

  const identifier = `project:${input.projectId}`
  const limit = PURPOSE_LIMITS[input.purpose]
  const recent = await countRecentRateLimitEvents(env.AQUILLA_PG, limit.kind, identifier)
  if (recent >= limit.cap) return heuristic("capped")
  await recordRateLimitEvent(env.AQUILLA_PG, limit.kind, identifier)

  const called = await callJev(env, { model: JEV_MODEL, state: input.state, questions: input.questions }, timeoutMs)
  if (!called.ok) return heuristic(called.reason)
  return decideResultFromBody(called.body, input.questions, input.fallback)
}

/**
 * A decisions response as a DecideResult: each question's answer, or its
 * fallback when the model left it out; all fallbacks when it answered none.
 * Exported so the shadow eval (scripts/jev-shadow-eval.ts, AQU-1701) reads
 * answers exactly as production does.
 */
export function decideResultFromBody(
  body: unknown,
  questions: Record<string, JevQuestion>,
  fallbackOf: () => Record<string, JevAnswer>,
): DecideResult {
  const raw = (body as { answers?: Record<string, unknown> } | null)?.answers ?? {}
  const fallback = fallbackOf()
  const answers: Record<string, JevAnswer> = {}
  let fromModel = 0
  for (const [key, question] of Object.entries(questions)) {
    const parsed = parseAnswer(raw[key], question)
    if (parsed) fromModel += 1
    answers[key] = parsed ?? fallback[key]
  }
  const total = Object.keys(questions).length
  if (fromModel === 0) return { answers: fallback, decidedBy: "heuristic", reason: "upstream", model: null, usage: null }
  return {
    answers,
    decidedBy: fromModel === total ? "model" : "mixed",
    ...(fromModel === total ? {} : { reason: "partial" as const }),
    model: JEV_MODEL,
    usage: usageOf(body),
  }
}
