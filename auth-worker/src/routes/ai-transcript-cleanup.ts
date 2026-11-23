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
// With `stream: true` the reply is Server-Sent Events instead of one JSON
// body: `delta` frames carry the transcript as the model writes it (so the
// row can show the cleanup and its diff live), then one `result` frame carries
// exactly what the JSON reply would have. The model call, the parser and the
// billing are the same either way; an older client that sends no `stream`
// keeps getting JSON.
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
import {
  holdChatUsage, openRouterEstimate, providerRejectedPreModel, releaseChatUsage, settleChatUsage,
} from "../lib/billing/chat-usage"
import { admitPaidCall } from "../lib/billing/paid-call"
import { getPlatformSettingsCached } from "../lib/platform-settings"
import { openRouterExtras, streamUsageOptions } from "../lib/llm-vendor"
import { DEFAULT_LLM_MODEL_ID } from "../lib/model-defaults"
import {
  buildCleanupMessages,
  CLEANUP_MAX_CONTEXT,
  CLEANUP_MAX_PAIRS,
  CLEANUP_MAX_SAMPLE_CHARS,
  CLEANUP_MAX_SAMPLES,
  CLEANUP_MAX_TERMS,
  CLEANUP_MAX_TOKENS,
  parseCleanupResult,
  partialCleanupText,
  type CleanupParse,
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
  /** Other lines the team wrote in this language (spelling evidence). */
  samples: z.array(z.string().max(CLEANUP_MAX_SAMPLE_CHARS * 4)).max(CLEANUP_MAX_SAMPLES).default([]),
  /** Reply as Server-Sent Events (see the header). */
  stream: z.boolean().default(false),
})

/** The upstream reply, in the non-streaming shape, however it arrived. */
interface CleanupCompletion {
  id?: string
  choices?: { finish_reason?: string | null; message?: { content?: string } }[]
  usage?: { cost?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
}

const sseFrame = (event: string, data: unknown) =>
  new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

/**
 * Read an OpenAI-shaped SSE completion to its end. `onContent` gets the whole
 * content so far after each frame that added to it. Resolves `complete: false`
 * when the stream stopped without `[DONE]` or carried an error frame: what was
 * written is then not a result, and its cost is not known.
 */
async function readCompletionStream(
  body: ReadableStream<Uint8Array>,
  onContent: (content: string) => void,
): Promise<{ complete: boolean; completion: CleanupCompletion }> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const completion: CleanupCompletion = {}
  let content = ""
  let finishReason: string | null | undefined
  let buffer = ""
  let complete = false
  let broken = false
  const frame = (data: string) => {
    if (data === "[DONE]") { complete = true; return }
    let parsed: {
      id?: string; error?: unknown
      choices?: { finish_reason?: string | null; delta?: { content?: string | null } }[]
      usage?: CleanupCompletion["usage"]
    }
    try { parsed = JSON.parse(data) } catch { broken = true; return }
    if (parsed.error) { broken = true; return }
    if (typeof parsed.id === "string") completion.id ??= parsed.id
    if (parsed.usage) completion.usage = parsed.usage
    const choice = parsed.choices?.[0]
    if (choice?.finish_reason) finishReason = choice.finish_reason
    const added = choice?.delta?.content
    if (typeof added === "string" && added) {
      content += added
      onContent(content)
    }
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      buffer += decoder.decode(next.value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        if (line.startsWith("data:")) frame(line.slice(5).trim())
      }
    }
  } catch {
    broken = true
  } finally {
    reader.releaseLock()
  }
  completion.choices = [{ finish_reason: finishReason ?? null, message: { content } }]
  return { complete: complete && !broken, completion }
}

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
    samples: input.samples,
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

  /** Bill a finished reply and read it. One path for JSON and for a stream. */
  const settle = async (data: CleanupCompletion, alreadySettled = false): Promise<CleanupParse> => {
    if (usage && !alreadySettled) await settleChatUsage(c.env, usage, data)
    if (!usage) {
      const cost = typeof data.usage?.cost === "number" && data.usage.cost > 0 ? data.usage.cost * 100 : 1
      await recordCredit(db, orgId, user.id, "llm", cost, 1)
      await recordWords(db, orgId, user.id, "llm", countWords(input.heard))
    }
    // A reply cut off at max_tokens is never a result, even when what it did
    // write parses: reading it as "unchanged" would say ASR was already right.
    // Usually a model reasoning despite effort "none" (AQU-2226).
    if (data.choices?.[0]?.finish_reason === "length") {
      console.warn("[transcript-cleanup] reply cut off at max_tokens", {
        model,
        maxTokens: CLEANUP_MAX_TOKENS,
        completionTokens: data.usage?.completion_tokens,
        reasoningTokens: data.usage?.completion_tokens_details?.reasoning_tokens,
      })
      return { kind: "invalid" }
    }
    return parseCleanupResult(data.choices?.[0]?.message?.content ?? "", input.heard)
  }

  // A streamed call is bounded to its first byte; nothing bounds a healthy
  // stream. The client hanging up aborts only a call that has not answered.
  const vendor = input.stream ? "openRouterStreamFirstByte" as const : "openRouterNonStreaming" as const
  const deadline = vendorDeadline(vendor, c.req.raw.signal)
  try {
    const upstream = await fetch(resolveOpenRouterUrl(c.env), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        max_tokens: CLEANUP_MAX_TOKENS,
        stream: input.stream,
        ...(input.stream ? streamUsageOptions(c.env.OPENROUTER_BASE_URL) : {}),
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
    if (input.stream && upstream.body) {
      // Headers are in: from here the deadline would bound the stream itself.
      deadline.clear()
      const upstreamBody = upstream.body
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
      const writer = writable.getWriter()
      // The client hanging up must not stop the read: the model has run, so
      // the reply is still read to its end and billed for what it cost.
      const send = (event: string, data: unknown) => writer.write(sseFrame(event, data)).catch(() => undefined)
      const pump = (async () => {
        let sent = ""
        const { complete, completion } = await readCompletionStream(upstreamBody, (content) => {
          const { text } = partialCleanupText(content)
          if (text.length > sent.length && text.startsWith(sent)) {
            void send("delta", { add: text.slice(sent.length) })
            sent = text
          }
        })
        if (!complete) {
          // Unknown cost: keep the reservation for reconciliation, as a
          // broken chat stream does (billing/chat-usage.ts meterChatStream).
          if (usage) await holdChatUsage(c.env, usage, typeof completion.id === "string" ? completion.id : undefined)
          console.error("[transcript-cleanup] llm stream ended early")
          await send("error", { error: "llm_unavailable", message: "Transcript cleanup is temporarily unavailable" })
        } else {
          const result = await settle(completion)
          await send("result", { model, result })
        }
        await writer.close().catch(() => undefined)
      })()
      // Hono throws on `c.executionCtx` when there is none (vitest calls
      // app.request without one); the open response body keeps the pump alive.
      try { c.executionCtx.waitUntil(pump) } catch { /* no execution context */ }
      return new Response(readable, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
      })
    }
    const data = await upstream.json() as CleanupCompletion
    const billing = usage ? await settleChatUsage(c.env, usage, data) : null
    if (billing) c.header("X-Billing-Usage-Status", billing)
    return c.json({ model, result: await settle(data, billing !== null) })
  } catch (error) {
    if (deadline.timedOut()) {
      logVendorTimeout(vendor, error)
      return c.json({ error: "llm_timeout", message: vendorTimeoutMessage(vendor) }, 504)
    }
    console.error("[transcript-cleanup] llm failed:", error)
    return c.json({ error: "llm_unavailable", message: "Transcript cleanup is temporarily unavailable" }, 502)
  } finally {
    deadline.clear()
  }
})

export default aiTranscriptCleanup
