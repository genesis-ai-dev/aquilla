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
import type { Env, Variables, AuthUser } from "../types"
import { authMiddleware } from "../middleware/auth"
import { resolveProjectRole } from "../services/project-permissions"
import { runAiGuard } from "../lib/ai-budget"
import { getPlatformSettingsCached, type PlatformSettings } from "../lib/platform-settings"
import { creditGuard, recordCredit } from "../lib/credits"
import {
  AB_OUTCOMES,
  pickAbArm,
  recordAbEvent,
  recordAbOutcome,
  setAbHeaders,
} from "../lib/model-ab"

const chat = new Hono<{ Bindings: Env; Variables: Variables }>()

// OPENROUTER_BASE_URL override mirrors routes/agent.ts:70 — the dev stack
// points it at the scripted mock (scripts/mock-openrouter.ts) when no real
// key exists. Absent the override, production OpenRouter is used.
const openRouterUrl = (env: Env): string =>
  env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"

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
  // AQU-414 follow-up: chat invoked from a project-editing context carries the
  // project id so its credit spend counts against that project's org (same
  // attribution as agent.ts). Optional — project-less chat stays at org 0.
  // NOT forwarded to OpenRouter (see buildOpenRouterBody).
  projectId: z.string().min(1).optional(),
})

type ChatRequest = z.infer<typeof chatCompletionRequestSchema>

/** True when the client asked the server to pick ("", "default", "free-tier"). */
function isDefaultRequest(requested: string): boolean {
  return !requested || requested === "default" || requested === "free-tier"
}

/**
 * "default", "free-tier", or an empty model string means "let the server
 * pick". Anything else passes through unchanged. The server pick is the
 * admin-set platform_settings.defaultLlmModel, then DEFAULT_LLM_MODEL, then the
 * hardcoded fallback.
 */
function resolveModel(env: Env, requested: string, settings: PlatformSettings): string {
  const fallback =
    settings.defaultLlmModel || env.DEFAULT_LLM_MODEL || "anthropic/claude-sonnet-4.5"
  if (isDefaultRequest(requested)) return fallback
  return requested
}

/**
 * Resolve the org whose credit ledger this chat spend belongs to (AQU-414
 * follow-up). Membership-gated: the caller must actually have a role on the
 * project — otherwise a client could bill its chat to an arbitrary org by
 * passing someone else's projectId. Attribution is best-effort and never
 * blocks chat: no projectId, no access, or any lookup failure → org 0
 * (the historical no-org fallback).
 */
async function resolveChatOrgId(
  env: Env,
  user: AuthUser,
  projectId: string | undefined,
): Promise<number> {
  if (!projectId) return 0
  try {
    const role = await resolveProjectRole(env, user, projectId)
    if (!role) return 0
    const projectRow = await env.AQUILLA_PG
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ org_id: number | null }>()
    return projectRow?.org_id ?? 0
  } catch {
    return 0
  }
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
    let model = resolveModel(c.env, request.model, settings)

    // Model A/B (FRO: admin console experiments): only default-model traffic
    // is eligible — an explicit model request is never reassigned. When an
    // arm is rolled, the served model may become the challenger, and the
    // assignment is echoed back via X-AB-* headers for outcome feedback.
    const user = c.get("user")
    const ab = isDefaultRequest(request.model) ? pickAbArm(settings, model) : null
    if (ab) model = ab.model

    // AI guard: model allowlist + per-user/global daily budget (AQU-265).
    const guard = await runAiGuard(model, user.id, c.env.AQUILLA_PG, c.env)
    if (!guard.ok) {
      return c.json(guard.body, guard.status)
    }

    // Credit guard + attribution (AQU-414 follow-up): chat invoked from a
    // project context bills that project's org; project-less chat falls back
    // to org 0 as before. The guard uses the same org so chat respects the
    // org's caps once an admin turns enforcement on (log-only by default).
    const orgId = await resolveChatOrgId(c.env, user, request.projectId)
    const chatCreditCheck = await creditGuard(c.env.AQUILLA_PG, c.env, orgId, "llm")
    if (!chatCreditCheck.ok) {
      return c.json(
        { error: "credit_cap_exceeded", reason: chatCreditCheck.reason, message: "LLM credit cap reached. Contact your org admin." },
        429,
      )
    }

    try {
      const startedAt = Date.now()
      const upstream = await fetch(openRouterUrl(c.env), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: buildOpenRouterBody(request, model),
      })
      const latencyMs = Date.now() - startedAt

      // Log the A/B assignment now that we know whether upstream succeeded.
      // Failed requests count against the serving arm's error rate.
      if (ab) {
        await recordAbEvent(c.env.AQUILLA_PG, ab, user.id, {
          error: !upstream.ok,
          latencyMs,
        })
      }

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
        await recordCredit(c.env.AQUILLA_PG, orgId, user.id, "llm", 1, 1)
        const streamHeaders = new Headers({
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        if (ab) setAbHeaders(streamHeaders, ab)
        return new Response(upstream.body, { status: 200, headers: streamHeaders })
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
      await recordCredit(c.env.AQUILLA_PG, orgId, user.id, "llm", costCents, 1)

      if (ab) {
        c.header("X-AB-Request-Id", ab.requestId)
        c.header("X-AB-Arm", ab.arm)
        c.header("X-AB-Model", ab.model)
      }
      return c.json(data)
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error)
      console.error("Error in chat completion:", error)
      return c.json({ error: "internal_error", message }, 500)
    }
  },
)

const abFeedbackSchema = z.object({
  requestId: z.string().uuid(),
  outcome: z.enum(AB_OUTCOMES),
  /** Normalized Levenshtein [0,1] between the AI draft and the human's text. */
  editDistance: z.number().min(0).max(1).optional(),
})

/**
 * POST /api/v1/chat/ab-feedback — the SPA reports what the user did with an
 * A/B-assigned completion (accepted = validated the cell, edited = overwrote
 * the AI draft) plus how far the text moved (editDistance). Outcome is
 * first-write-wins; the distance refines with further edits. Only the
 * requester may report. Always 200 with { recorded } so a stale/duplicate
 * report never surfaces as a user-visible error — telemetry, not a workflow.
 */
chat.post("/ab-feedback", authMiddleware, zValidator("json", abFeedbackSchema), async (c) => {
  const user = c.get("user")
  const { requestId, outcome, editDistance } = c.req.valid("json")
  try {
    const recorded = await recordAbOutcome(c.env.AQUILLA_PG, requestId, user.id, outcome, editDistance)
    return c.json({ ok: true, recorded })
  } catch (err) {
    console.error("[model-ab] feedback write failed:", err)
    return c.json({ ok: false, recorded: false })
  }
})

export default chat
