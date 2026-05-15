// POST /api/v1/chat/completions — OpenAI-compatible authenticated proxy to
// OpenRouter. Streams via SSE when `stream: true`; otherwise returns the
// upstream JSON verbatim so codex-web's existing client code keeps working.
//
// Ported from the legacy frontier-server (cloudflare/src/routes/chat.ts) and
// stripped of every billing / usage-tracking concern: codex-web doesn't gate
// on tier and we don't want to write to D1 on every completion. What remains:
//   1. Verify the Bearer JWT against frontier-db-v2 (via authMiddleware).
//   2. Map "default" / "free-tier" / "" to DEFAULT_LLM_MODEL.
//   3. Forward to OpenRouter with OPENROUTER_API_KEY.
//   4. Pass the response through unchanged (streaming or JSON).
//
// A/B testing, mock-LLM mode, the GET variants, and the per-cost rate-limit
// path are intentionally dropped — codex-web doesn't call any of them.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { authMiddleware } from "../middleware/auth"

const chat = new Hono<{ Bindings: Env; Variables: Variables }>()

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

const messageSchema = z.object({
  role: z.string(),
  content: z.string(),
})

// Mirrors the legacy frontier-server schema, minus `ab_eligible` which only
// fed the dropped A/B test path. `response_format` is a free-form OpenAI
// object so we keep it as a record of unknown rather than tightening it.
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
 * pick". Anything else passes through unchanged.
 */
function resolveModel(env: Env, requested: string): string {
  const fallback = env.DEFAULT_LLM_MODEL || "anthropic/claude-sonnet-4.5"
  if (!requested) return fallback
  if (requested === "default" || requested === "free-tier") return fallback
  return requested
}

/**
 * Build the OpenRouter request body. We always ask for cost-inclusive usage
 * and disable reasoning tokens (codex-web translation prompts never benefit
 * from chain-of-thought spend).
 */
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
      return c.json(
        { error: "OPENROUTER_API_KEY is not configured" },
        500,
      )
    }

    const request = c.req.valid("json")
    const model = resolveModel(c.env, request.model)

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
        // Forward OpenRouter's status so the client can branch on 401/402/429
        // without inspecting the message body.
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
        // Pass the upstream body straight through — OpenRouter already emits
        // OpenAI-compatible SSE frames, and the codex-web client knows how to
        // consume them. The legacy frontier-server parsed every frame to
        // re-emit a "usage" sidecar; codex-web doesn't read that sidecar so
        // we save the round-trip and the parsing-boundary bugs that came
        // with it (see completion-service.ts comment about straddled chunks).
        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        })
      }

      // Non-streaming: forward the JSON verbatim.
      const data = await upstream.json()
      return c.json(data as Record<string, unknown>)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)
      console.error("Error in chat completion:", error)
      return c.json(
        {
          error: "internal_error",
          message,
        },
        500,
      )
    }
  },
)

export default chat
