import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { authMiddleware } from "../middleware/auth"
import { creditGuard, recordCredit } from "../lib/credits"
import { checkAiSpendCeiling } from "../../../db/shared/ai-spend-ceiling"
import { weeklyUsageActive } from "../lib/billing/usage-mode"
import { reserveWorkspaceUsage, settleWorkspaceUsage } from "../lib/billing/workspace-usage"
import {
  settleChatUsage, holdChatUsage, releaseChatUsage, type ChatUsage,
} from "../lib/billing/chat-usage"
import { readProviderCostCents } from "../../../db/shared/billing-cost"
import {
  omniAmortization, omniCostBoundCents, omniRawCostCents, type OmniModel,
} from "../../../db/shared/omni-asr-cost"
import { omniLanguageFromTag, whisperLanguageFromTag } from "../lib/transcription-language"
import {
  isAllowedExampleUrl, omniConfigured, omniFetch, omniStatusSchema, omniTranscribe,
  omniTranscribeResponseSchema, OMNI_MAX_AUDIO_SECONDS, zeroShotEnabledForOrg,
} from "../lib/omni-asr"
import {
  transcriptionSeconds, transcriptionCostBound, WHISPER_MODEL,
} from "../lib/billing/transcription-usage"
import { resolveProjectRole } from "../services/project-permissions"
import {
  enforceRateLimit, userRateLimitIdentifier,
} from "../../../db/shared/rate-limit"

const transcription = new Hono<{ Bindings: Env; Variables: Variables }>()

/** Transcription calls allowed per user per shared limiter window. Named (it
 *  was a bare `60` inline) so the cap reads the same way as every sibling
 *  route's — see db/shared/rate-limit.ts. */
const TRANSCRIPTION_MAX_PER_USER_PER_WINDOW = 60

const requestSchema = z.object({
  projectId: z.string().min(1).max(200),
  input_audio: z.object({
    data: z.string().min(1).max(2600000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    format: z.literal("wav"),
  }),
  /** The project's raw BCP-47 tag; the server picks the model from it. */
  language: z.string().max(64).regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/).optional(),
  /** "zs" is the per-user zero-shot opt-in; "auto" picks Whisper or CTC. */
  model: z.enum(["auto", "zs"]).default("auto"),
  /** Zero-shot context pairs from GET …/transcription-examples. */
  examples: z.array(z.object({
    url: z.string().max(4096),
    text: z.string().min(1).max(4000),
  })).max(10).optional(),
})
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

transcription.post("/transcriptions", authMiddleware,
  bodyLimit({ maxSize: 2700000 }),
  zValidator("json", requestSchema), async c => {
    const user = c.get("user")
    const request = c.req.valid("json")
    const role = await resolveProjectRole(c.env, user, request.projectId)
    if (!role || role.level < 400) return c.json({ error: "forbidden" }, 403)
    // auto: Whisper for every tag it supports, and when no tag is sent (its
    // auto-detect, as before). Otherwise Omnilingual — CTC, or ZS on opt-in.
    const whisperLanguage = whisperLanguageFromTag(request.language)
    const omniModel: OmniModel | null = request.model === "zs" ? "zs"
      : request.language === undefined || whisperLanguage !== undefined ? null : "ctc"
    if (omniModel === null && !c.env.OPENROUTER_API_KEY) {
      return c.json({ error: "Hosted transcription is not configured" }, 503)
    }
    if (omniModel !== null && !omniConfigured(c.env)) {
      return c.json({ error: "Omnilingual transcription is not configured" }, 503)
    }
    if (omniModel === "zs") {
      if (!request.examples?.length) return c.json({ error: "zero_shot_examples_required" }, 400)
      if (!request.examples.every(example => isAllowedExampleUrl(c.env, example.url))) {
        return c.json({ error: "invalid_example_url" }, 400)
      }
    }
    let seconds: number
    try { seconds = transcriptionSeconds(request.input_audio.data) }
    catch { return c.json({ error: "Invalid transcription audio" }, 400) }
    if (omniModel !== null && seconds >= OMNI_MAX_AUDIO_SECONDS) {
      return c.json({ error: "omnilingual_audio_too_long" }, 400)
    }
    const project = await c.env.AQUILLA_PG.prepare(
      "SELECT org_id FROM projects WHERE id = ?",
    ).bind(request.projectId).first<{ org_id: number | null }>()
    const orgId = project?.org_id ?? 0
    if (omniModel === "zs") {
      let enabled: boolean
      try { enabled = await zeroShotEnabledForOrg(c.env.AQUILLA_PG, orgId) }
      catch { return c.json({ error: "Transcription settings unavailable" }, 503) }
      if (!enabled) return c.json({ error: "zero_shot_disabled" }, 403)
    }
    const weekly = weeklyUsageActive(c.env, c.req.url)
    if (weekly === "unavailable") {
      return c.json({ error: "usage_rehearsal_unavailable" }, 503)
    }
    if (weekly === "on" && orgId <= 0) return c.json({ error: "forbidden" }, 403)
    // Platform daily spend ceiling (AQU-1869) — applies to the metered path
    // too, so it sits outside the `weekly === "off"` branch below.
    const spendCeiling = await checkAiSpendCeiling(c.env.AQUILLA_PG, c.env, "transcription")
    if (!spendCeiling.ok) return c.json(spendCeiling.body, spendCeiling.status)
    if (weekly === "off") {
      const check = await creditGuard(c.env.AQUILLA_PG, c.env, orgId, "llm")
      if (!check.ok) return c.json({ error: "credit_cap_exceeded" }, 429)
    }
    // AQU-1843: atomic, and FAIL CLOSED — transcription bills a vendor per
    // call, so a limiter outage must not uncap it.
    const transcribeLimit = await enforceRateLimit(c.env.AQUILLA_PG, {
      kind: "audio_transcriptions",
      identifier: userRateLimitIdentifier(user.id),
      limit: TRANSCRIPTION_MAX_PER_USER_PER_WINDOW,
      failMode: "closed",
    })
    if (!transcribeLimit.allowed) {
      return c.json({ error: "rate_limited" }, 429, {
        "Retry-After": String(transcribeLimit.retryAfterSeconds),
      })
    }
    let bound: number
    let amortization = 0
    try {
      if (omniModel === null) bound = await transcriptionCostBound(c.env, seconds)
      else {
        amortization = omniAmortization(c.env.OMNI_ASR_AMORTIZATION)
        bound = omniCostBoundCents(omniModel, seconds, amortization)
      }
    } catch { return c.json({ error: "Transcription price unavailable" }, 503) }
    let usage: ChatUsage | undefined
    if (weekly === "on") {
      const suppliedId = c.req.header("Idempotency-Key")
      if (suppliedId && !z.string().uuid().safeParse(suppliedId).success) {
        return c.json({ error: "invalid_request_id" }, 400)
      }
      usage = { orgId, requestId: suppliedId ?? crypto.randomUUID() }
      try {
        const admitted = await reserveWorkspaceUsage(c.env.AQUILLA_PG, {
          ...usage, projectId: request.projectId, userId: user.id,
          rail: "llm", maxRawCostCents: bound,
        })
        if (!admitted.created) return c.json({ error: "request_already_started" }, 409)
      } catch (error) {
        if (error instanceof Error && error.message === "Weekly AI allowance exhausted") {
          return c.json({ error: "weekly_ai_allowance_exhausted" }, 429)
        }
        return c.json({ error: "Transcription accounting unavailable" }, 503)
      }
    }
    if (omniModel !== null && omniConfigured(c.env)) {
      const lang = omniLanguageFromTag(request.language)
      let response: Response
      try {
        response = await omniTranscribe(c.env, {
          model: omniModel, audio: request.input_audio.data,
          ...(lang ? { lang } : {}),
          ...(omniModel === "zs" ? { examples: request.examples } : {}),
        })
      } catch {
        // A timeout may follow GPU work: keep the reservation held.
        return c.json({ error: "Transcription provider unavailable" }, 502)
      }
      if (!response.ok) {
        // Our service validates (secret, body, example fetch) before it starts
        // the GPU timer, so a 4xx other than 408 is proven free. 5xx and 408
        // stay held, as with chat (chat-usage.ts providerRejectedPreModel).
        if (usage && response.status >= 400 && response.status < 500 && response.status !== 408) {
          await releaseChatUsage(c.env, usage)
        }
        return c.json({ error: "Transcription provider failed" }, 502)
      }
      const parsed = omniTranscribeResponseSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) return c.json({ error: "Invalid transcription response" }, 502)
      const { text, words, gpuSeconds, gpu, timingsApproximate } = parsed.data
      const rawCents = omniRawCostCents(gpuSeconds, gpu, amortization)
      if (usage) {
        let status: "settled" | "pending" = "settled"
        try { await settleWorkspaceUsage(c.env.AQUILLA_PG, usage.orgId, usage.requestId, rawCents) }
        catch {
          console.warn("[billing] omnilingual usage requires reconciliation", usage, { rawCents })
          status = "pending"
        }
        c.header("X-Billing-Usage-Status", status)
      } else {
        await recordCredit(c.env.AQUILLA_PG, orgId, user.id, "llm", rawCents, Math.ceil(seconds))
      }
      if (text.trim() && !words.length) {
        return c.json({ error: "Transcription provider returned no timings" }, 502)
      }
      return c.json({
        text, chunks: words.map(({ text, start, end }) => ({ text, start, end })),
        ...(timingsApproximate ? { timingsApproximate: true } : {}),
      })
    }
    const base = c.env.OPENROUTER_BASE_URL?.replace(/\/+$/, "")
      ?? "https://openrouter.ai/api/v1"
    let generationId: string | undefined
    try {
      const response = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: WHISPER_MODEL, input_audio: request.input_audio,
          language: whisperLanguage, response_format: "verbose_json",
          timestamp_granularities: ["word", "segment"],
        }),
        signal: AbortSignal.timeout(65000),
      })
      generationId = response.headers.get("X-Generation-Id") ?? undefined
      if (!response.ok) {
        if (usage) await holdChatUsage(c.env, usage, generationId)
        return c.json({ error: "Transcription provider failed" }, 502)
      }
      const data = await response.json() as Record<string, unknown>
      if (usage) {
        c.header("X-Billing-Usage-Status", await settleChatUsage(c.env, usage,
          { ...data, ...(generationId ? { id: generationId } : {}) }))
      } else {
        let cost = bound
        try { cost = readProviderCostCents(data) } catch { /* legacy estimate */ }
        // Whisper bills whole seconds (transcriptionCostBound assumes the same)
        // and the ledger's units column is INTEGER: never pass the raw duration.
        await recordCredit(c.env.AQUILLA_PG, orgId, user.id, "llm", cost, Math.ceil(seconds))
      }
      const parsed = upstreamSchema.safeParse(data)
      if (!parsed.success) return c.json({ error: "Invalid transcription response" }, 502)
      const { text, words, segments } = parsed.data
      const chunks = words?.length
        ? words.map(({ word, start, end }) => ({ text: word, start, end }))
        : segments ?? []
      if (text.trim() && !chunks.length) {
        return c.json({ error: "Transcription provider returned no timings" }, 502)
      }
      return c.json({ text, chunks })
    } catch {
      if (usage) await holdChatUsage(c.env, usage, generationId)
      return c.json({ error: "Transcription provider unavailable" }, 502)
    }
  })

// ── Warm-up + status proxies (spec §3/§5). Warming is free; only a project
// contributor can trigger it, and ZS respects the org gate so a disabled org
// cannot spin up the expensive container.

const warmSchema = z.object({
  projectId: z.string().min(1).max(200),
  model: z.enum(["ctc", "zs"]),
})
const statusQuerySchema = z.object({
  projectId: z.string().min(1).max(200),
  model: z.enum(["ctc", "zs"]).default("zs"),
})

/** Membership + org gate shared by both proxies; null means proceed. */
async function omniProxyGate(
  env: Env, user: Variables["user"], projectId: string, model: OmniModel,
): Promise<{ error: string; status: 403 | 503 } | null> {
  const role = await resolveProjectRole(env, user, projectId)
  if (!role || role.level < 400) return { error: "forbidden", status: 403 }
  if (!omniConfigured(env)) return { error: "Omnilingual transcription is not configured", status: 503 }
  if (model === "zs") {
    const project = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(projectId).first<{ org_id: number | null }>()
    let enabled: boolean
    try { enabled = await zeroShotEnabledForOrg(env.AQUILLA_PG, project?.org_id ?? 0) }
    catch { return { error: "Transcription settings unavailable", status: 503 } }
    if (!enabled) return { error: "zero_shot_disabled", status: 403 }
  }
  return null
}

transcription.post("/transcriptions/warm", authMiddleware,
  zValidator("json", warmSchema), async c => {
    const { projectId, model } = c.req.valid("json")
    const denied = await omniProxyGate(c.env, c.get("user"), projectId, model)
    if (denied) return c.json({ error: denied.error }, denied.status)
    if (!omniConfigured(c.env)) return c.json({ error: "Omnilingual transcription is not configured" }, 503)
    try {
      const response = await omniFetch(c.env, "/warm", { method: "POST", body: { model }, timeoutMs: 10000 })
      if (!response.ok) return c.json({ error: "Warm-up failed" }, 502)
    } catch { return c.json({ error: "Warm-up unavailable" }, 502) }
    return c.json({ ok: true }, 202)
  })

transcription.get("/transcriptions/status", authMiddleware,
  zValidator("query", statusQuerySchema), async c => {
    const { projectId, model } = c.req.valid("query")
    const denied = await omniProxyGate(c.env, c.get("user"), projectId, model)
    if (denied) return c.json({ error: denied.error }, denied.status)
    if (!omniConfigured(c.env)) return c.json({ error: "Omnilingual transcription is not configured" }, 503)
    try {
      const response = await omniFetch(c.env, `/status?model=${model}`, { method: "GET", timeoutMs: 10000 })
      if (!response.ok) return c.json({ error: "Status unavailable" }, 502)
      const parsed = omniStatusSchema.safeParse(await response.json().catch(() => null))
      if (!parsed.success) return c.json({ error: "Invalid status response" }, 502)
      return c.json(parsed.data, 200, { "Cache-Control": "no-store" })
    } catch { return c.json({ error: "Status unavailable" }, 502) }
  })

export default transcription
