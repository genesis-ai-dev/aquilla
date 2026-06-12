// POST /api/v1/ai/agent/run — the translation agent's SSE endpoint.
//
// Design: docs/superpowers/specs/2026-06-12-translation-agent-design.md.
// Wire contract (frames, tool schema, proposal shapes — byte-for-byte):
// docs/superpowers/specs/2026-06-12-translation-agent-implementation-plan.md.
//
// One tool ("execute": sql | emit | docs), max 8 tool iterations, 60k token
// ceiling, Haiku-class default model through the same OpenRouter key +
// runAiGuard() path as /api/v1/chat/completions. All writes are STAGED
// proposals — the client applies them through the normal POST /events path.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type { Env, Variables } from "../types"
import { authMiddleware } from "../middleware/auth"
import { runAiGuard } from "../lib/ai-budget"
import { resolveProjectRole } from "../services/project-permissions"
import { AliasMap, compressRows } from "../lib/agent/compress"
import { runGuardedSql, type SqlVarContext } from "../lib/agent/sql-guard"
import { stageEvents, type AgentProposal, type EmitStageContext } from "../lib/agent/emit-stage"
import { getCookbook } from "../lib/agent/docs"
import { buildSystemPrompt } from "../lib/agent/schema-card"
import { insertAgentRun, finishAgentRun } from "../lib/agent/runs"

const agent = new Hono<{ Bindings: Env; Variables: Variables }>()

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
/** Haiku-class default from the existing allowlist (lib/ai-budget.ts). */
const AGENT_MODEL = "anthropic/claude-haiku-4-5"
const MAX_TOOL_ITERATIONS = 8
const TOKEN_CEILING = 60_000
/** code_result summaries are truncated for the UI per the contract. */
const RESULT_SUMMARY_MAX = 2000

// ── SSE frame types (wire contract — keep byte-identical to the plan doc) ──

type AgentFrame =
  | { type: "run_start"; runId: string }
  | { type: "assistant_delta"; text: string }
  | { type: "code_start"; step: number; kind: "sql" | "emit" | "docs"; summary: string }
  | { type: "code_result"; step: number; ok: boolean; summary: string }
  | { type: "proposal"; proposal: AgentProposal }
  | { type: "usage"; promptTokens: number; completionTokens: number; costCents: number }
  | { type: "done"; runId: string; status: "ok" | "capped" | "error" }
  | { type: "error"; message: string }

// ── The one tool (OpenAI tool-calling schema, served to the model) ─────────

const EXECUTE_TOOL = {
  type: "function",
  function: {
    name: "execute",
    description: "Run read-only SQL, stage events, or fetch docs. Exactly one field per call.",
    parameters: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description:
            "One read-only SELECT (CTEs allowed). Bind vars: :project, :user, :file, :cell. Max 200 rows surfaced.",
        },
        emit: {
          type: "array",
          items: { type: "object" },
          description:
            "Events to STAGE for user approval. Each: {kind, fileId?, cellId?, parentId?, payload}. Aliases (#c1/#e1/#f1) and :vars accepted.",
        },
        docs: {
          type: "string",
          description:
            "Fetch a cookbook: drafting | checking | terminology | validation | history | assignments | files-and-refs",
        },
      },
    },
  },
} as const

// ── Request body ────────────────────────────────────────────────────────────

const runRequestSchema = z.object({
  projectId: z.string().min(1),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .min(1)
    .max(10),
  context: z.object({ fileId: z.string().optional(), cellId: z.string().optional() }).optional(),
})

// ── OpenRouter message plumbing ─────────────────────────────────────────────

interface ToolCall {
  id: string
  type: string
  function: { name: string; arguments: string }
}

interface UpstreamMessage {
  role: string
  content: string | null
  tool_calls?: ToolCall[]
}

interface UpstreamResponse {
  choices?: { message?: UpstreamMessage }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
}

type ConvoMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | (UpstreamMessage & { role: "assistant" })
  | { role: "tool"; tool_call_id: string; content: string }

// ── Route ───────────────────────────────────────────────────────────────────

agent.post("/run", authMiddleware, zValidator("json", runRequestSchema), async (c) => {
  if (!c.env.OPENROUTER_API_KEY) {
    return c.json({ error: "OPENROUTER_API_KEY is not configured" }, 500)
  }

  const body = c.req.valid("json")
  const user = c.get("user")

  // Project role — the agent acts strictly as this user, at this level.
  const role = await resolveProjectRole(c.env, user, body.projectId)
  if (!role) {
    return c.json({ error: "forbidden", message: "No access to this project" }, 403)
  }

  // AI guard: model allowlist + per-user/global daily budget (FRO-265).
  const guard = await runAiGuard(AGENT_MODEL, user.id, c.env.AQUILLA_PG, c.env)
  if (!guard.ok) {
    return c.json(guard.body, guard.status)
  }

  const env = c.env
  const signal = c.req.raw.signal
  const runId = crypto.randomUUID()
  const lastUserMessage = [...body.messages].reverse().find((m) => m.role === "user")

  await insertAgentRun(env.AQUILLA_PG, {
    runId,
    projectId: body.projectId,
    userId: user.id,
    username: user.username,
    prompt: lastUserMessage?.content ?? "",
    model: AGENT_MODEL,
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: AgentFrame) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      }
      runAgentLoop({ env, body, user: { id: user.id, username: user.username }, roleLevel: role.level, runId, signal, send })
        .catch((err) => {
          // Last-resort: surface, then settle the ledger as error.
          try {
            send({ type: "error", message: err instanceof Error ? err.message : String(err) })
            send({ type: "done", runId, status: "error" })
          } catch {
            /* controller already closed (client gone) */
          }
        })
        .finally(() => {
          try {
            controller.close()
          } catch {
            /* already closed */
          }
        })
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
})

interface LoopArgs {
  env: Env
  body: z.infer<typeof runRequestSchema>
  user: { id: number; username: string }
  roleLevel: number
  runId: string
  signal: AbortSignal
  send: (frame: AgentFrame) => void
}

async function runAgentLoop({ env, body, user, roleLevel, runId, signal, send }: LoopArgs): Promise<void> {
  const aliases = new AliasMap()
  const sqlVars: SqlVarContext = {
    projectId: body.projectId,
    userId: user.id,
    fileId: body.context?.fileId,
    cellId: body.context?.cellId,
  }
  const stageCtx: EmitStageContext = {
    runId,
    projectId: body.projectId,
    roleLevel,
    fileId: body.context?.fileId,
    cellId: body.context?.cellId,
    aliases,
  }

  const convo: ConvoMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        projectId: body.projectId,
        username: user.username,
        roleLevel,
        fileId: body.context?.fileId,
        cellId: body.context?.cellId,
      }),
    },
    ...body.messages,
  ]

  let promptTokens = 0
  let completionTokens = 0
  let costCents = 0
  let steps = 0
  let status: "ok" | "capped" | "error" = "ok"

  send({ type: "run_start", runId })

  try {
    let iteration = 0
    for (;;) {
      if (signal.aborted) {
        status = "error"
        break
      }
      if (iteration >= MAX_TOOL_ITERATIONS) {
        status = "capped"
        send({ type: "error", message: "Tool-iteration cap reached (8) — run stopped." })
        break
      }
      if (promptTokens + completionTokens > TOKEN_CEILING) {
        status = "capped"
        send({ type: "error", message: "Token ceiling reached (60k) — run stopped." })
        break
      }

      const upstream = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: AGENT_MODEL,
          messages: convo,
          tools: [EXECUTE_TOOL],
          stream: false,
          usage: { include: true },
          reasoning: { effort: "none" },
        }),
        signal,
      })

      if (!upstream.ok) {
        const text = await upstream.text()
        send({ type: "error", message: `openrouter_error ${upstream.status}: ${text.slice(0, 500)}` })
        status = "error"
        break
      }

      const data = (await upstream.json()) as UpstreamResponse
      promptTokens += data.usage?.prompt_tokens ?? 0
      completionTokens += data.usage?.completion_tokens ?? 0
      costCents += (data.usage?.cost ?? 0) * 100

      const message = data.choices?.[0]?.message
      if (!message) {
        send({ type: "error", message: "openrouter returned no message" })
        status = "error"
        break
      }

      // Acceptable v1: buffer model text per step, one assistant_delta per step.
      if (message.content) {
        send({ type: "assistant_delta", text: message.content })
      }

      convo.push({ ...message, role: "assistant" })

      const toolCalls = message.tool_calls ?? []
      if (toolCalls.length === 0) break // final prose — the run is complete

      iteration++
      for (const call of toolCalls) {
        steps++
        const result = await executeToolCall(call, {
          env,
          aliases,
          sqlVars,
          stageCtx,
          send,
          step: steps,
        })
        convo.push({ role: "tool", tool_call_id: call.id, content: result })
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) })
    }
    status = "error"
  }

  send({ type: "usage", promptTokens, completionTokens, costCents })
  send({ type: "done", runId, status })

  try {
    await finishAgentRun(env.AQUILLA_PG, { runId, status, promptTokens, completionTokens, costCents, steps })
  } catch (err) {
    console.error("[agent] failed to finalise agent_runs row:", err)
  }
}

interface ToolCallEnv {
  env: Env
  aliases: AliasMap
  sqlVars: SqlVarContext
  stageCtx: EmitStageContext
  send: (frame: AgentFrame) => void
  step: number
}

/** Run one `execute` call; emits code_start/code_result (+ proposal) frames
 *  and returns the tool-result text the model sees. */
async function executeToolCall(call: ToolCall, t: ToolCallEnv): Promise<string> {
  let args: { sql?: unknown; emit?: unknown; docs?: unknown }
  try {
    args = JSON.parse(call.function.arguments || "{}")
  } catch {
    t.send({ type: "code_start", step: t.step, kind: "sql", summary: "(unparseable arguments)" })
    const msg = "error: tool arguments were not valid JSON"
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }

  const fields = (["sql", "emit", "docs"] as const).filter((f) => args[f] !== undefined)
  if (call.function.name !== "execute" || fields.length !== 1) {
    const kind = fields[0] ?? "sql"
    t.send({ type: "code_start", step: t.step, kind, summary: "(invalid call)" })
    const msg = "error: call the `execute` tool with exactly one of sql | emit | docs"
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }

  if (fields[0] === "sql" && typeof args.sql === "string") {
    t.send({ type: "code_start", step: t.step, kind: "sql", summary: args.sql.slice(0, 120) })
    const run = await runGuardedSql(t.env.AQUILLA_PG, args.sql, t.sqlVars, t.aliases)
    const text = run.ok
      ? compressRows(run.rows, t.aliases, { projectId: t.sqlVars.projectId })
      : `error: ${run.error}`
    t.send({ type: "code_result", step: t.step, ok: run.ok, summary: text.slice(0, RESULT_SUMMARY_MAX) })
    return text
  }

  if (fields[0] === "emit" && Array.isArray(args.emit)) {
    t.send({ type: "code_start", step: t.step, kind: "emit", summary: `${args.emit.length} events` })
    const { proposal, modelVerdictBlock } = await stageEvents(t.env.AQUILLA_PG, args.emit, t.stageCtx)
    if (proposal) {
      t.send({ type: "proposal", proposal })
    }
    t.send({
      type: "code_result",
      step: t.step,
      ok: proposal !== null,
      summary: modelVerdictBlock.slice(0, RESULT_SUMMARY_MAX),
    })
    return modelVerdictBlock
  }

  if (fields[0] === "docs" && typeof args.docs === "string") {
    t.send({ type: "code_start", step: t.step, kind: "docs", summary: args.docs })
    const book = getCookbook(args.docs)
    t.send({
      type: "code_result",
      step: t.step,
      ok: book.ok,
      summary: book.ok ? `cookbook: ${args.docs} (${book.text.length} chars)` : book.text,
    })
    return book.text
  }

  const kind = fields[0] as "sql" | "emit" | "docs"
  t.send({ type: "code_start", step: t.step, kind, summary: "(wrong argument type)" })
  const msg = `error: ${kind} has the wrong type — sql: string, emit: array, docs: string`
  t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
  return msg
}

export default agent
