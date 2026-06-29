// POST /api/v1/chat/completions — OpenAI-compatible authenticated proxy to
// OpenRouter. Streams via SSE when `stream: true`; otherwise returns the
// upstream JSON verbatim so codex-web's existing client code keeps working.
//
// Folded in from the former aquilla-chat-worker (2026-05-26): the chat
// route only ever needed the same JWT + user lookup the identity worker
// already does, so keeping it in a separate worker meant a second
// SECRET_KEY that drifted. One worker, one secret.
//
// Behaviour kept identical to the old chat-worker:
//   1. Verify the Bearer JWT via authMiddleware (against AQUILLA_PG).
//   2. Map "default" / "free-tier" / "" to DEFAULT_LLM_MODEL.
//   3. Forward to OpenRouter with OPENROUTER_API_KEY.
//   4. Pass the response through unchanged (streaming or JSON).

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { authMiddleware } from "../middleware/auth"
import { runAiGuard } from "../lib/ai-budget"
import { getPlatformSettingsCached, type PlatformSettings } from "../lib/platform-settings"
import { creditGuard, recordCredit } from "../lib/credits"

const chat = new Hono<{ Bindings: Env; Variables: Variables }>()

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

const messageSchema = z.object({
  role: z.string(),
  content: z.string(),
})

const chatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(messageSchema),
  temperature: z.number().optional().default(0.7),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().optional(),
  response_format: z.record(z.unknown()).optional(),
})

type ChatRequest = z.infer<typeof chatCompletionRequestSchema>

/**
 * "default", "free-tier", or an empty model string means "let the server
 * pick". Anything else passes through unchanged. The server pick is the
 * admin-set platform_settings.defaultLlmModel, then DEFAULT_LLM_MODEL, then the
 * hardcoded fallback.
 */
function resolveModel(env: Env, requested: string, settings: PlatformSettings): string {
  const fallback =
    settings.defaultLlmModel || env.DEFAULT_LLM_MODEL || "anthropic/claude-sonnet-4.5"
  if (!requested) return fallback
  if (requested === "default" || requested === "free-tier") return fallback
  return requested
}

function buildOpenRouterBody(request: ChatRequest, model: string): string {
  const messages = request.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
  return JSON.stringify({
    model,
    messages,
    temperature: request.temperature,
    stream: request.stream,
    max_tokens: request.max_tokens,
    usage: { include: true },
    reasoning: { effort: "none" },
    ...(request.response_format && { response_format: request.response_format }),
  })
}

chat.post(
  "/completions",
  authMiddleware,
  zValidator("json", chatCompletionRequestSchema),
  async (c) => {
    if (!c.env.OPENROUTER_API_KEY) {
      return c.json({ error: "OPENROUTER_API_KEY is not configured" }, 500)
    }

    const request = c.req.valid("json")
    const settings = await getPlatformSettingsCached(c.env)
    const model = resolveModel(c.env, request.model, settings)

    // AI guard: model allowlist + per-user/global daily budget (FRO-265).
    const user = c.get("user")
    const guard = await runAiGuard(model, user.id, c.env.AQUILLA_PG, c.env)
    if (!guard.ok) {
      return c.json(guard.body, guard.status)
    }

    // Credit guard: chat is not tied to a project → orgId = 0 (no-org fallback).
    // Log-only by default; enforce only when cfg.enforce is on.
    const chatCreditCheck = await creditGuard(c.env.AQUILLA_PG, c.env, 0, "llm")
    if (!chatCreditCheck.ok) {
      return c.json(
        { error: "credit_cap_exceeded", reason: chatCreditCheck.reason, message: "LLM credit cap reached. Contact your org admin." },
        429,
      )
    }

    try {
      const upstream = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: buildOpenRouterBody(request, model),
      })

      if (!upstream.ok) {
        const errorText = await upstream.text()
        return new Response(
          JSON.stringify({
            error: "openrouter_error",
            status: upstream.status,
            message: errorText,
          }),
          {
            status: upstream.status,
            headers: { "Content-Type": "application/json" },
          },
        )
      }

      if (request.stream) {
        // Streaming: pass body through unchanged. We can't inspect the usage
        // object from a streaming response without buffering it (defeats the
        // point). Record a flat 1¢ fallback estimate so the ledger always has
        // a row — this is the cheap/low-priority rail.
        await recordCredit(c.env.AQUILLA_PG, 0, user.id, "llm", 1, 1)
        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        })
      }

      const data = (await upstream.json()) as Record<string, unknown>

      // Non-streaming: extract OpenRouter usage.cost if present.
      // usage.cost is in dollars → × 100 for cents.
      let costCents = 1 // fallback ~1¢ per request
      try {
        const usage = data.usage as { cost?: number } | undefined
        if (typeof usage?.cost === "number" && usage.cost > 0) {
          costCents = usage.cost * 100
        }
      } catch {
        /* ignore — use the fallback */
      }
      // Record asynchronously (graceful-degrade) — never block the response.
      await recordCredit(c.env.AQUILLA_PG, 0, user.id, "llm", costCents, 1)

      return c.json(data)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)
      console.error("Error in chat completion:", error)
      return c.json({ error: "internal_error", message }, 500)
    }
  },
)

export default chat
