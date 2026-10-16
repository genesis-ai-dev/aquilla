// One hosted-transcription path for every caller (spec §5, §7): the SPA's
// POST /api/v1/audio/transcriptions and sync-worker's Agent API tool (through
// POST /api/v1/audio/internal/transcriptions). Both get the same model
// routing, ZS org gate, spend ceiling, rate limit, reservation and settlement,
// so an agent can never transcribe on cheaper or looser terms than the app.
//
// The caller has already authenticated the user and checked project role.

import { z } from "zod"
import type { Env } from "../types"
import { creditGuard, recordCredit } from "./credits"
import { checkAiSpendCeiling } from "../../../db/shared/ai-spend-ceiling"
import { weeklyUsageActive } from "./billing/usage-mode"
import { reserveWorkspaceUsage, settleWorkspaceUsage } from "./billing/workspace-usage"
import {
  settleChatUsage, holdChatUsage, releaseChatUsage, type ChatUsage,
} from "./billing/chat-usage"
import { costMultiplier, readProviderCostCents } from "../../../db/shared/billing-cost"
import {
  omniAmortization, omniCostBoundCents, omniRawCostCents, type OmniModel,
} from "../../../db/shared/omni-asr-cost"
import {
  pickAsrModel, toOmniCode, toQwenCode, toWhisperCode,
  type AsrModel, type AsrModelChoice,
} from "../../../db/shared/asr-models"
import {
  isAllowedExampleUrl, omniConfigured, omniTranscribe, omniTranscribeResponseSchema,
  omniWarmingSchema, OMNI_MAX_AUDIO_SECONDS, zeroShotEnabledForOrg,
} from "./omni-asr"
import {
  transcriptionSeconds, transcriptionCostBound, QWEN_ASR_MODEL, WHISPER_MODEL,
} from "./billing/transcription-usage"
import { enforceRateLimit, userRateLimitIdentifier } from "../../../db/shared/rate-limit"

/** Transcription calls allowed per user per shared limiter window. Named (it
 *  was a bare `60` inline) so the cap reads the same way as every sibling
 *  route's — see db/shared/rate-limit.ts. */
const TRANSCRIPTION_MAX_PER_USER_PER_WINDOW = 60

/** Containers other than the SPA's canonical WAV. Only the internal (agent)
 *  route sends them: a stored take is forwarded as recorded. */
export const COMPRESSED_AUDIO_FORMATS = ["webm", "ogg", "mp3", "m4a", "flac", "aac"] as const
/** What OpenRouter documents for audio input; webm is not listed, so a webm
 *  take can only go to Omnilingual (Modal decodes with ffmpeg). */
const OPENROUTER_AUDIO_FORMATS = new Set<string>(["wav", "ogg", "mp3", "m4a", "flac", "aac"])

export interface TranscribeInput {
  userId: number
  projectId: string
  audio: { data: string; format: "wav" | typeof COMPRESSED_AUDIO_FORMATS[number]; durationMs?: number }
  language?: string
  model: AsrModelChoice
  examples?: Array<{ url: string; text: string }>
  idempotencyKey?: string
  requestUrl: string
}

export interface TranscribeSuccess {
  text: string
  chunks: Array<{ text: string; start: number; end: number }>
  model: AsrModel
  timingsApproximate: boolean
  /**
   * AQU-1681: what `chunks` are — words, whole segments, or nothing timed.
   * The client sends a minute of a recording at a time and hands each word
   * back to the row it was spoken in; a sentence-long segment can span two
   * rows, so it needs to know.
   */
  granularity: "word" | "segment" | "none"
}

export type TranscribeResult =
  | { ok: true; body: TranscribeSuccess; creditsCharged: number | null; headers: Record<string, string> }
  | { ok: false; status: 400 | 403 | 409 | 429 | 502 | 503; body: { error: string }; headers?: Record<string, string> }

const fail = (status: 400 | 403 | 409 | 429 | 502 | 503, error: string, headers?: Record<string, string>): TranscribeResult =>
  ({ ok: false, status, body: { error }, ...(headers ? { headers } : {}) })

const upstreamSchema = z.object({
  text: z.string(),
  words: z.array(z.object({
    word: z.string(), start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
  })).optional(),
  segments: z.array(z.object({
    text: z.string(), start: z.number().finite().nonnegative(),
    end: z.number().finite().nonnegative(),
  })).optional(),
})

/** Marked-up credit units (cents × the rail multiplier) for an agent report. */
const toCredits = (rawCents: number) => rawCents * costMultiplier("llm")

/** "auto" → pickAsrModel; an explicit choice is honoured as sent. */
export function resolveAsrModel(choice: AsrModelChoice, language: string | undefined): AsrModel {
  return choice === "auto" ? pickAsrModel(language) : choice
}

export async function transcribe(env: Env, input: TranscribeInput): Promise<TranscribeResult> {
  const picked = resolveAsrModel(input.model, input.language)
  // Without the Modal service, Automatic keeps the pre-Omnilingual behaviour
  // for languages Whisper lacks: Whisper auto-detect, not a 503. Only an
  // explicit Omnilingual choice is refused.
  const model: AsrModel = input.model === "auto" && picked === "omni-ctc" && !omniConfigured(env)
    ? "whisper" : picked
  const omniModel: OmniModel | null = model === "omni-zs" ? "zs" : model === "omni-ctc" ? "ctc" : null
  if (omniModel === null && !env.OPENROUTER_API_KEY) return fail(503, "Hosted transcription is not configured")
  if (omniModel !== null && !omniConfigured(env)) return fail(503, "Omnilingual transcription is not configured")
  if (omniModel === null && !OPENROUTER_AUDIO_FORMATS.has(input.audio.format)) {
    return fail(400, "audio_format_unsupported_for_model")
  }
  if (omniModel === "zs") {
    if (!input.examples?.length) return fail(400, "zs_no_examples")
    if (!input.examples.every(example => isAllowedExampleUrl(env, example.url))) {
      return fail(400, "invalid_example_url")
    }
  }
  let seconds: number
  if (input.audio.format === "wav") {
    try { seconds = transcriptionSeconds(input.audio.data) }
    catch { return fail(400, "Invalid transcription audio") }
  } else {
    // A stored take's duration comes from its row; settlement still uses the
    // provider's own cost or the measured GPU time, never this number.
    const ms = input.audio.durationMs
    if (ms === undefined || !Number.isFinite(ms) || ms <= 0 || ms > 60000) {
      return fail(400, "Invalid transcription audio")
    }
    seconds = ms / 1000
  }
  if (omniModel !== null && seconds >= OMNI_MAX_AUDIO_SECONDS) return fail(400, "omnilingual_audio_too_long")

  const project = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
    .bind(input.projectId).first<{ org_id: number | null }>()
  const orgId = project?.org_id ?? 0
  if (omniModel === "zs") {
    let enabled: boolean
    try { enabled = await zeroShotEnabledForOrg(env.AQUILLA_PG, orgId) }
    catch { return fail(503, "Transcription settings unavailable") }
    if (!enabled) return fail(403, "zero_shot_disabled")
  }
  const weekly = weeklyUsageActive(env, input.requestUrl)
  if (weekly === "unavailable") return fail(503, "usage_rehearsal_unavailable")
  if (weekly === "on" && orgId <= 0) return fail(403, "forbidden")
  // Platform daily spend ceiling (AQU-1869) — applies to the metered path
  // too, so it sits outside the `weekly === "off"` branch below.
  const spendCeiling = await checkAiSpendCeiling(env.AQUILLA_PG, env, "transcription")
  if (!spendCeiling.ok) return { ok: false, status: spendCeiling.status as 429 | 503, body: spendCeiling.body as { error: string } }
  if (weekly === "off") {
    const check = await creditGuard(env.AQUILLA_PG, env, orgId, "llm")
    if (!check.ok) return fail(429, "credit_cap_exceeded")
  }
  // AQU-1843: atomic, and FAIL CLOSED — transcription bills a vendor per
  // call, so a limiter outage must not uncap it.
  const transcribeLimit = await enforceRateLimit(env.AQUILLA_PG, {
    kind: "audio_transcriptions",
    identifier: userRateLimitIdentifier(input.userId),
    limit: TRANSCRIPTION_MAX_PER_USER_PER_WINDOW,
    failMode: "closed",
  })
  if (!transcribeLimit.allowed) {
    return fail(429, "rate_limited", { "Retry-After": String(transcribeLimit.retryAfterSeconds) })
  }
  const openRouterModel = model === "qwen3-asr" ? QWEN_ASR_MODEL : WHISPER_MODEL
  let bound: number
  let amortization = 0
  try {
    if (omniModel === null) bound = await transcriptionCostBound(env, seconds, openRouterModel)
    else {
      amortization = omniAmortization(env.OMNI_ASR_AMORTIZATION)
      bound = omniCostBoundCents(omniModel, seconds, amortization)
    }
  } catch { return fail(503, "Transcription price unavailable") }
  let usage: ChatUsage | undefined
  if (weekly === "on") {
    const suppliedId = input.idempotencyKey
    if (suppliedId && !z.string().uuid().safeParse(suppliedId).success) return fail(400, "invalid_request_id")
    usage = { orgId, requestId: suppliedId ?? crypto.randomUUID() }
    try {
      const admitted = await reserveWorkspaceUsage(env.AQUILLA_PG, {
        ...usage, projectId: input.projectId, userId: input.userId,
        rail: "llm", maxRawCostCents: bound,
      })
      if (!admitted.created) return fail(409, "request_already_started")
    } catch (error) {
      if (error instanceof Error && error.message === "Weekly AI allowance exhausted") {
        return fail(429, "weekly_ai_allowance_exhausted")
      }
      return fail(503, "Transcription accounting unavailable")
    }
  }

  if (omniModel !== null && omniConfigured(env)) {
    const lang = toOmniCode(input.language)
    let response: Response
    try {
      response = await omniTranscribe(env, {
        model: omniModel, audio: input.audio.data,
        ...(lang ? { lang } : {}),
        ...(omniModel === "zs" ? { examples: input.examples } : {}),
      })
    } catch {
      // A timeout may follow GPU work: keep the reservation held.
      return fail(502, "Transcription provider unavailable")
    }
    if (!response.ok) {
      // Our service validates (secret, body, example fetch) before it starts
      // the GPU timer, so a 4xx other than 408 is proven free. 5xx and 408
      // stay held, as with chat (chat-usage.ts providerRejectedPreModel).
      if (usage && response.status >= 400 && response.status < 500 && response.status !== 408) {
        await releaseChatUsage(env, usage)
      }
      return fail(502, "Transcription provider failed")
    }
    const reply: unknown = await response.json().catch(() => null)
    if (omniWarmingSchema.safeParse(reply).success) {
      // Proven free: the service only spawned a warm-up. The client shows
      // the warm-up toast and retries (spec §5).
      if (usage) await releaseChatUsage(env, usage)
      return fail(503, "asr_warming", { "Retry-After": "10" })
    }
    const parsed = omniTranscribeResponseSchema.safeParse(reply)
    if (!parsed.success) return fail(502, "Invalid transcription response")
    const { text, words, gpuSeconds, gpu, timingsApproximate } = parsed.data
    const rawCents = omniRawCostCents(gpuSeconds, gpu, amortization)
    const headers: Record<string, string> = {}
    if (usage) {
      let status: "settled" | "pending" = "settled"
      try { await settleWorkspaceUsage(env.AQUILLA_PG, usage.orgId, usage.requestId, rawCents) }
      catch {
        console.warn("[billing] omnilingual usage requires reconciliation", usage, { rawCents })
        status = "pending"
      }
      headers["X-Billing-Usage-Status"] = status
    } else {
      await recordCredit(env.AQUILLA_PG, orgId, input.userId, "llm", rawCents, Math.ceil(seconds))
    }
    if (text.trim() && !words.length) return fail(502, "Transcription provider returned no timings")
    return {
      ok: true, headers, creditsCharged: toCredits(rawCents),
      body: {
        text, chunks: words.map(({ text, start, end }) => ({ text, start, end })),
        model, timingsApproximate: timingsApproximate ?? false,
        granularity: words.length ? "word" : "none",
      },
    }
  }

  const base = env.OPENROUTER_BASE_URL?.replace(/\/+$/, "") ?? "https://openrouter.ai/api/v1"
  const language = model === "qwen3-asr" ? toQwenCode(input.language) : toWhisperCode(input.language)
  let generationId: string | undefined
  try {
    const response = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: openRouterModel, input_audio: { data: input.audio.data, format: input.audio.format },
        language, response_format: "verbose_json",
        timestamp_granularities: ["word", "segment"],
      }),
      signal: AbortSignal.timeout(65000),
    })
    generationId = response.headers.get("X-Generation-Id") ?? undefined
    if (!response.ok) {
      if (usage) await holdChatUsage(env, usage, generationId)
      return fail(502, "Transcription provider failed")
    }
    const data = await response.json() as Record<string, unknown>
    let providerCents: number | null = null
    try { providerCents = readProviderCostCents(data) } catch { /* unresolved */ }
    const headers: Record<string, string> = {}
    if (usage) {
      headers["X-Billing-Usage-Status"] = await settleChatUsage(env, usage,
        { ...data, ...(generationId ? { id: generationId } : {}) })
    } else {
      // Whisper bills whole seconds (transcriptionCostBound assumes the same)
      // and the ledger's units column is INTEGER: never pass the raw duration.
      await recordCredit(env.AQUILLA_PG, orgId, input.userId, "llm", providerCents ?? bound, Math.ceil(seconds))
    }
    const parsed = upstreamSchema.safeParse(data)
    if (!parsed.success) return fail(502, "Invalid transcription response")
    const { text, words, segments } = parsed.data
    const chunks = words?.length
      ? words.map(({ word, start, end }) => ({ text: word, start, end }))
      : segments ?? []
    if (text.trim() && !chunks.length) return fail(502, "Transcription provider returned no timings")
    return {
      ok: true, headers,
      creditsCharged: usage ? (providerCents === null ? null : toCredits(providerCents)) : toCredits(providerCents ?? bound),
      body: {
        text, chunks, model, timingsApproximate: false,
        granularity: words?.length ? "word" : segments?.length ? "segment" : "none",
      },
    }
  } catch {
    if (usage) await holdChatUsage(env, usage, generationId)
    return fail(502, "Transcription provider unavailable")
  }
}

