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
import { creditGuard, recordCredit } from "../lib/credits"
import { resolveProjectRole } from "../services/project-permissions"
import { AliasMap, compressRows } from "../lib/agent/compress"
import { runGuardedSql, type SqlVarContext } from "../lib/agent/sql-guard"
import { stageEvents, type AgentProposal, type EmitStageContext } from "../lib/agent/emit-stage"
import { getCookbook } from "../lib/agent/docs"
import { parseAquiferOp } from "../lib/agent/aquifer-guard"
import { aquiferSearch, aquiferReadPage, type AquiferCitation } from "../lib/aquifer/client"
import { isBibleResourcesEnabled } from "../lib/aquifer/gate"
import { buildSystemPrompt } from "../lib/agent/schema-card"
import { insertAgentRun, finishAgentRun } from "../lib/agent/runs"
import { makePostgres } from "../../../db/shim/postgres"

const agent = new Hono<{ Bindings: Env; Variables: Variables }>()

// Overridable so the dev stack / e2e can point the loop at a scripted mock
// (scripts/mock-openrouter.ts) when no real key is configured. Prod ignores it.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
function resolveOpenRouterUrl(env: Env): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : OPENROUTER_URL
}
/** Haiku-class default from the existing allowlist (lib/ai-budget.ts). */
const AGENT_MODEL = "anthropic/claude-haiku-4-5"
// Counted per model round that runs sql/emit (docs-only rounds are free).
// Sized for: recipe query + exemplars + draft emit + one lint-redraft emit,
// with headroom for error recovery (battery case 2 capped at 8 mid-redraft).
const MAX_TOOL_ITERATIONS = 12
const TOKEN_CEILING = 60_000
/** code_result summaries are truncated for the UI per the contract. */
const RESULT_SUMMARY_MAX = 2000

// ── SSE frame types (wire contract — keep byte-identical to the plan doc) ──

type CodeKind = "sql" | "emit" | "docs" | "aquifer"

/** A researched Q&A the agent wants to publish back to bibletranslation.org.
 *  Unlike an event AgentProposal, applying this does NOT go through the
 *  /events outbox — the client POSTs it to /api/v1/aquifer/answers (no
 *  credits). Mirrored client-side in src/lib/agent/protocol.ts. */
export interface AquiferPublishProposal {
  proposalId: string
  runId: string
  question: string
  answer: string
  status: "answered" | "undetermined"
  citations: AquiferCitation[]
}

type AgentFrame =
  | { type: "run_start"; runId: string }
  | { type: "assistant_delta"; text: string }
  | { type: "code_start"; step: number; kind: CodeKind; summary: string }
  | { type: "code_result"; step: number; ok: boolean; summary: string }
  | { type: "proposal"; proposal: AgentProposal }
  | { type: "aquifer_proposal"; proposal: AquiferPublishProposal }
  | { type: "usage"; promptTokens: number; completionTokens: number; costCents: number }
  | { type: "done"; runId: string; status: "ok" | "capped" | "error" }
  | { type: "error"; message: string }

// ── The one tool (OpenAI tool-calling schema, served to the model) ─────────

const EXECUTE_TOOL = {
  type: "function",
  function: {
    name: "execute",
    description:
      "Run read-only SQL, stage events, fetch docs, or consult Bible reference data. Exactly one field per call.",
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
            "Fetch a cookbook: drafting | checking | terminology | validation | history | assignments | files-and-refs | brief",
        },
        aquifer: {
          type: "object",
          description:
            "Consult bibletranslation.org scholarly reference data. {op:'search',q,limit?} | {op:'read',path,maxChars?} | {op:'publish',question,answer,status,citations}. search→read by url path; publish STAGES a Q&A for user approval (free).",
          properties: {
            op: { type: "string", enum: ["search", "read", "publish"] },
            q: { type: "string" },
            limit: { type: "number" },
            path: { type: "string", description: "Site path from a search result url, e.g. /en/passages/RUT/1/8/" },
            maxChars: { type: "number" },
            question: { type: "string" },
            answer: { type: "string" },
            status: { type: "string", enum: ["answered", "undetermined"] },
            citations: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
  },
} as const

// ── Request body ────────────────────────────────────────────────────────────

// Translator profile: all fields optional free-text. The zod `.max` is a
// generous payload-size sanity ceiling; the precise per-field cap that reaches
// the prompt is applied in buildSystemPrompt (never trust the client's lengths).
const PROFILE_FIELD_CEILING = 2000
const profileField = z.string().max(PROFILE_FIELD_CEILING).optional()
const translatorProfileSchema = z
  .object({
    responseLanguage: profileField,
    age: profileField,
    gender: profileField,
    educationLevel: profileField,
    religiousBackground: profileField,
    translationExperience: profileField,
    geographicalSetting: profileField,
    otherInfo: profileField,
  })
  .optional()

const runRequestSchema = z.object({
  projectId: z.string().min(1),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .min(1)
    .max(10),
  context: z.object({ fileId: z.string().optional(), cellId: z.string().optional() }).optional(),
  translatorProfile: translatorProfileSchema,
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

  // Credit guard: resolve org from project, pre-check agent sub-cap.
  // This is the DANGEROUS rail — block early (before the SSE stream starts).
  let orgId = 0
  try {
    const projectRow = await c.env.AQUILLA_PG
      .prepare("SELECT org_id FROM projects WHERE id = ?")
      .bind(body.projectId)
      .first<{ org_id: number | null }>()
    orgId = projectRow?.org_id ?? 0
  } catch {
    /* best-effort — degrade to org 0 (no-org) so we still record */
  }
  const creditCheck = await creditGuard(c.env.AQUILLA_PG, c.env, orgId, "agent")
  if (!creditCheck.ok) {
    return c.json(
      { error: "credit_cap_exceeded", reason: creditCheck.reason, message: "Agent credit cap reached. Contact your org admin." },
      429,
    )
  }

  // The request-scoped AQUILLA_PG shim is closed when this Response returns
  // (index.ts finally) — before the SSE body finishes. The run owns its own
  // connection for the loop's lifetime; tests (no PG_CONNECTION_STRING)
  // keep using the injected AQUILLA_PG.
  const runShim = c.env.PG_CONNECTION_STRING ? makePostgres(c.env.PG_CONNECTION_STRING) : null
  const env: Env = runShim ? { ...c.env, AQUILLA_PG: runShim as unknown as Env["AQUILLA_PG"] } : c.env
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
      runAgentLoop({ env, body, user: { id: user.id, username: user.username }, roleLevel: role.level, runId, orgId, signal, send })
        .catch((err) => {
          // Last-resort: surface, then settle the ledger as error.
          try {
            send({ type: "error", message: err instanceof Error ? err.message : String(err) })
            send({ type: "done", runId, status: "error" })
          } catch {
            /* controller already closed (client gone) */
          }
        })
        .finally(async () => {
          try {
            controller.close()
          } catch {
            /* already closed */
          }
          if (runShim) {
            try {
              await runShim.close()
            } catch {
              /* connection already gone */
            }
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
  orgId: number
  signal: AbortSignal
  send: (frame: AgentFrame) => void
}

async function runAgentLoop({ env, body, user, roleLevel, runId, orgId, signal, send }: LoopArgs): Promise<void> {
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

  // Situational grounding: resolve the focused file's name/kind and the
  // project's language pair so the prompt can anchor relative requests
  // ("this file", "segment 8") and the translation direction instead of
  // leaving the model to reverse-engineer the project — or worse, stall the
  // run to ask "what language?". Best-effort, cheap lookups.
  let focusedFile: { name?: string; kind?: string } = {}
  let languages: { sourceLanguage?: string; targetLanguage?: string } = {}
  let briefSummary: string | undefined
  try {
    if (body.context?.fileId) {
      const row = await env.AQUILLA_PG.prepare(
        "SELECT name, kind FROM files WHERE project_id = ? AND id = ?",
      )
        .bind(body.projectId, body.context.fileId)
        .first<{ name: string; kind: string | null }>()
      if (row) focusedFile = { name: row.name, kind: row.kind ?? undefined }
    }
    const settings = await env.AQUILLA_PG.prepare(
      `SELECT settings::jsonb ->> 'sourceLanguage' AS source_language,
              settings::jsonb ->> 'targetLanguage' AS target_language,
              settings::jsonb -> 'translationBrief' ->> 'l1Summary' AS brief_summary
       FROM project_settings WHERE project_id = ?`,
    )
      .bind(body.projectId)
      .first<{ source_language: string | null; target_language: string | null; brief_summary: string | null }>()
    if (settings) {
      languages = {
        sourceLanguage: settings.source_language ?? undefined,
        targetLanguage: settings.target_language ?? undefined,
      }
      briefSummary = settings.brief_summary ?? undefined
    }
  } catch {
    /* prompt grounding is best-effort — the run proceeds without it */
  }

  // Feature gate read once per run — gates the L1 aquifer contract (and the
  // execute.aquifer handler re-checks it before every external call).
  const bibleResourcesEnabled = await isBibleResourcesEnabled(env, body.projectId)

  const convo: ConvoMessage[] = [
    {
      role: "system",
      content: buildSystemPrompt({
        projectId: body.projectId,
        username: user.username,
        roleLevel,
        fileId: body.context?.fileId,
        cellId: body.context?.cellId,
        fileName: focusedFile.name,
        fileKind: focusedFile.kind,
        sourceLanguage: languages.sourceLanguage,
        targetLanguage: languages.targetLanguage,
        bibleResourcesEnabled,
        translatorProfile: body.translatorProfile,
        // Profile language is the sole driver for the agent — it never had a
        // response-language setting, and defaulting to the project target
        // language would force target-language replies on owners/PMs who don't
        // read it. Unset → current English-default behavior.
        responseLanguage: body.translatorProfile?.responseLanguage,
        briefSummary,
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
        send({ type: "error", message: `Tool-iteration cap reached (${MAX_TOOL_ITERATIONS}) — run stopped.` })
        break
      }
      if (promptTokens + completionTokens > TOKEN_CEILING) {
        status = "capped"
        send({ type: "error", message: "Token ceiling reached (60k) — run stopped." })
        break
      }

      const upstream = await fetch(resolveOpenRouterUrl(env), {
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

      // Cookbook fetches are constant-cost and risk-free — a docs-only round
      // does not consume iteration budget. Otherwise a run that reads the
      // cookbook, explores, and then gets a NEEDS REVIEW lint verdict on its
      // first emit can be capped before the redraft (battery case 2).
      const docsOnly = toolCalls.every((call) => {
        try {
          const args = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>
          return typeof args.docs === "string" && args.sql === undefined && args.emit === undefined
        } catch {
          return false
        }
      })
      if (!docsOnly) iteration++
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

  // Record agent cost in org credit ledger (graceful-degrade — never throws).
  // costCents is the sum of OpenRouter usage.cost×100 across all iterations.
  await recordCredit(env.AQUILLA_PG, orgId, user.id, "agent", costCents, 1)
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
  let args: { sql?: unknown; emit?: unknown; docs?: unknown; aquifer?: unknown }
  try {
    args = JSON.parse(call.function.arguments || "{}")
  } catch {
    t.send({ type: "code_start", step: t.step, kind: "sql", summary: "(unparseable arguments)" })
    const msg = "error: tool arguments were not valid JSON"
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }

  const fields = (["sql", "emit", "docs", "aquifer"] as const).filter((f) => args[f] !== undefined)
  if (call.function.name !== "execute" || fields.length !== 1) {
    const kind = fields[0] ?? "sql"
    t.send({ type: "code_start", step: t.step, kind, summary: "(invalid call)" })
    const msg = "error: call the `execute` tool with exactly one of sql | emit | docs | aquifer"
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

  if (fields[0] === "aquifer") {
    return runAquiferCall(args.aquifer, t)
  }

  const kind = fields[0] as "sql" | "emit" | "docs"
  t.send({ type: "code_start", step: t.step, kind, summary: "(wrong argument type)" })
  const msg = `error: ${kind} has the wrong type — sql: string, emit: array, docs: string, aquifer: object`
  t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
  return msg
}

/** Strip the origin off an Aquifer result URL → a site path the model can read. */
function urlToPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

/** Handle one execute.aquifer call: search | read | publish. Gated per-project;
 *  publish stages an aquifer_proposal (applied later via /api/v1/aquifer/answers,
 *  no credits). Returns the tool-result text the model sees. */
async function runAquiferCall(rawAquifer: unknown, t: ToolCallEnv): Promise<string> {
  const parsed = parseAquiferOp(rawAquifer)
  if (!parsed.ok) {
    t.send({ type: "code_start", step: t.step, kind: "aquifer", summary: "(invalid aquifer call)" })
    const msg = `error: ${parsed.error}`
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }
  const op = parsed.value

  // Feature gate — fail closed when the project hasn't enabled Bible resources.
  if (!(await isBibleResourcesEnabled(t.env, t.sqlVars.projectId))) {
    t.send({ type: "code_start", step: t.step, kind: "aquifer", summary: `${op.op} (disabled)` })
    const msg = "error: Bible resources are not enabled for this project (Project Settings → Bible resources)."
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }

  if (op.op === "search") {
    t.send({ type: "code_start", step: t.step, kind: "aquifer", summary: `search: ${op.q.slice(0, 80)}` })
    const res = await aquiferSearch(t.env, op.q, { limit: op.limit })
    if (!res.ok) {
      const msg = `error: ${res.error}`
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
    const lines = res.data.results.map(
      (r, i) => `${i + 1}. [${r.kind}] ${r.title} — ${urlToPath(r.url)} — ${r.description}`,
    )
    const text =
      res.data.count === 0
        ? `No Aquifer results for "${op.q}".`
        : `Aquifer results for "${op.q}" (${res.data.count}):\n${lines.join("\n")}\n` +
          `Read one with execute({aquifer:{op:"read", path:"<path above>"}}).`
    t.send({ type: "code_result", step: t.step, ok: true, summary: text.slice(0, RESULT_SUMMARY_MAX) })
    return text
  }

  if (op.op === "read") {
    t.send({ type: "code_start", step: t.step, kind: "aquifer", summary: `read: ${op.path}` })
    const res = await aquiferReadPage(t.env, op.path, { maxChars: op.maxChars })
    if (!res.ok) {
      const msg = `error: ${res.error}`
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
    const page = res.data
    const text = `# ${page.title}\n(${page.url})\n\n${page.text}${page.truncated ? "\n…(truncated)" : ""}`
    t.send({ type: "code_result", step: t.step, ok: true, summary: `read ${op.path} (${page.text.length} chars)` })
    return text
  }

  // publish — stage a proposal; nothing leaves the worker until the user Applies.
  t.send({ type: "code_start", step: t.step, kind: "aquifer", summary: `publish: ${op.question.slice(0, 80)}` })
  const proposal: AquiferPublishProposal = {
    proposalId: crypto.randomUUID(),
    runId: t.stageCtx.runId,
    question: op.question,
    answer: op.answer,
    status: op.status,
    citations: op.citations,
  }
  t.send({ type: "aquifer_proposal", proposal })
  const verdict =
    `STAGED publish proposal (${op.status}) with ${op.citations.length} citation(s). ` +
    `The user must Apply it to post to the wiki — do not assume it is published.`
  t.send({ type: "code_result", step: t.step, ok: true, summary: verdict })
  return verdict
}

export default agent
