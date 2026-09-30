import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { authMiddleware } from "../middleware/auth"
import { creditGuard, recordCredit } from "../lib/credits"
import { weeklyUsageActive } from "../lib/billing/usage-mode"
import { reserveWorkspaceUsage } from "../lib/billing/workspace-usage"
import { settleChatUsage, holdChatUsage, type ChatUsage } from "../lib/billing/chat-usage"
import { readProviderCostCents } from "../../../db/shared/billing-cost"
import {
  transcriptionSeconds, transcriptionCostBound, WHISPER_MODEL,
} from "../lib/billing/transcription-usage"
import { resolveProjectRole } from "../services/project-permissions"
import {
  countRecentRateLimitEvents, recordRateLimitEvent,
} from "../../../db/shared/rate-limit"

const transcription = new Hono<{ Bindings: Env; Variables: Variables }>()
const requestSchema = z.object({
  projectId: z.string().min(1).max(200),
  input_audio: z.object({
    data: z.string().min(1).max(2600000).regex(/^[A-Za-z0-9+/]+={0,2}$/),
    format: z.literal("wav"),
  }),
  language: z.string().regex(/^[a-z]{2,3}$/).optional(),
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
    if (!c.env.OPENROUTER_API_KEY) {
      return c.json({ error: "Hosted transcription is not configured" }, 503)
    }
    let seconds: number
    try { seconds = transcriptionSeconds(request.input_audio.data) }
    catch { return c.json({ error: "Invalid transcription audio" }, 400) }
    const project = await c.env.AQUILLA_PG.prepare(
      "SELECT org_id FROM projects WHERE id = ?",
    ).bind(request.projectId).first<{ org_id: number | null }>()
    const orgId = project?.org_id ?? 0
    const weekly = weeklyUsageActive(c.env, c.req.url)
    if (weekly === "unavailable") {
      return c.json({ error: "usage_rehearsal_unavailable" }, 503)
    }
    if (weekly === "on" && orgId <= 0) return c.json({ error: "forbidden" }, 403)
    if (weekly === "off") {
      const check = await creditGuard(c.env.AQUILLA_PG, c.env, orgId, "llm")
      if (!check.ok) return c.json({ error: "credit_cap_exceeded" }, 429)
    }
    const identifier = `user:${user.id}`
    const recent = await countRecentRateLimitEvents(
      c.env.AQUILLA_PG, "audio_transcriptions", identifier,
    )
    if (recent >= 60) return c.json({ error: "rate_limited" }, 429)
    await recordRateLimitEvent(c.env.AQUILLA_PG, "audio_transcriptions", identifier)
    let bound: number
    try { bound = await transcriptionCostBound(c.env, seconds) }
    catch { return c.json({ error: "Transcription price unavailable" }, 503) }
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
          language: request.language, response_format: "verbose_json",
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
        await recordCredit(c.env.AQUILLA_PG, orgId, user.id, "llm", cost, seconds)
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

export default transcription
