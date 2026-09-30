import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { authMiddleware } from "../middleware/auth"
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
    const identifier = `user:${user.id}`
    const recent = await countRecentRateLimitEvents(
      c.env.AQUILLA_PG, "audio_transcriptions", identifier,
    )
    if (recent >= 60) return c.json({ error: "rate_limited" }, 429)
    await recordRateLimitEvent(c.env.AQUILLA_PG, "audio_transcriptions", identifier)
    const base = c.env.OPENROUTER_BASE_URL?.replace(/\/+$/, "")
      ?? "https://openrouter.ai/api/v1"
    try {
      const response = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/whisper-1", input_audio: request.input_audio,
          language: request.language, response_format: "verbose_json",
          timestamp_granularities: ["word", "segment"],
        }),
        signal: AbortSignal.timeout(65000),
      })
      if (!response.ok) return c.json({ error: "Transcription provider failed" }, 502)
      const parsed = upstreamSchema.safeParse(await response.json())
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
      return c.json({ error: "Transcription provider unavailable" }, 502)
    }
  })

export default transcription
