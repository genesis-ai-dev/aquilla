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
import { getPlatformSettingsCached, type PlatformSettings } from "../lib/platform-settings"
import { creditGuard, creditsFor, recordCredit, resolveCreditConfig } from "../lib/credits"
import { resolveProjectRole } from "../services/project-permissions"
import { AliasMap, compressRows } from "../lib/agent/compress"
import { runGuardedSql, type SqlVarContext } from "../lib/agent/sql-guard"
import { stageEvents, type AgentProposal, type EmitStageContext } from "../lib/agent/emit-stage"
import { getCookbook } from "../lib/agent/docs"
import { readModelTurn, type ToolCall, type UpstreamMessage } from "../lib/agent/upstream"
import { compactConvo, loadSession, saveSession, type StoredMessage } from "../lib/agent/sessions"
import { executeRead, resolveScope, type ReadArgs } from "../lib/agent/tools/read"
import { selectCellPairs } from "../lib/agent/tools/select-cells"
import { executeExamples, type ExamplesArgs } from "../lib/agent/tools/examples"
import { executeSearch, type SearchArgs } from "../lib/agent/tools/search"
import { executeDraft, type DraftArgs } from "../lib/agent/tools/draft"
import type { ToolResultData } from "../lib/agent/tools/types"
import { parseAquiferOp } from "../lib/agent/aquifer-guard"
import { aquiferSearch, aquiferReadPage, type AquiferCitation } from "../lib/aquifer/client"
import { isBibleResourcesEnabled } from "../lib/aquifer/gate"
import { buildSystemPrompt } from "../lib/agent/schema-card"
import { insertAgentRun, finishAgentRun, listAgentRuns } from "../lib/agent/runs"
import { makePostgres } from "../../../db/shim/postgres"
import {
  type HarnessFrame,
  resolveRunCostCapCents,
} from "../lib/agent/frames"
import { buildMemoryContext, type MemoryContext } from "../../../db/shared/agent-memory"
import { buildAugmentSystemPrompt } from "../lib/agent/prompt-augment"
import { sandboxDestroy } from "../lib/agent/sandbox-client"
import { openRouterExtras } from "../lib/llm-vendor"
import {
  runCode,
  loadArtifact,
  readSandboxFile,
  proposeMemoryTool,
  proposeBriefUpdateTool,
  readMemoryTool,
  type HarnessToolCtx,
  type RunCodeArgs,
  type LoadArtifactArgs,
  type ReadSandboxFileArgs,
  type ProposeMemoryArgs,
  type ProposeBriefArgs,
  type ReadMemoryArgs,
} from "../lib/agent/harness-tools"

const agent = new Hono<{ Bindings: Env; Variables: Variables }>()

// Overridable so the dev stack / e2e can point the loop at a scripted mock
// (scripts/mock-openrouter.ts) when no real key is configured. Prod ignores it.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
function resolveOpenRouterUrl(env: Env): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : OPENROUTER_URL
}
/** Haiku-class default from the existing allowlist (lib/ai-budget.ts). Used
 *  when neither platform_settings.agentModel nor AGENT_MODEL_DEFAULT is set. */
const DEFAULT_AGENT_MODEL = "anthropic/claude-haiku-4-5"
/** Resolve the agent model: admin-set store wins, then env, then the default. */
function resolveAgentModel(env: Env, settings: PlatformSettings): string {
  return settings.agentModel || env.AGENT_MODEL_DEFAULT || DEFAULT_AGENT_MODEL
}
/** The draft tool's translation model — may be stronger than the orchestrator. */
function resolveDraftModel(env: Env, settings: PlatformSettings, agentModel: string): string {
  return settings.agentDraftModel || env.AGENT_DRAFT_MODEL_DEFAULT || agentModel
}
// Iteration budget counts model rounds that WRITE or run raw SQL (draft /
// propose|emit / sql). Read-shaped rounds (read/examples/search/docs/aquifer)
// are free — each is one bounded, recipe-encoded call — but a hard round cap
// backstops a model looping on free tools.
const MAX_TOOL_ITERATIONS = 12
const MAX_TOTAL_ROUNDS = 30
const TOKEN_CEILING = 100_000
/** code_result summaries are truncated for the UI per the contract. */
const RESULT_SUMMARY_MAX = 2000

// ── SSE frame types (wire contract — keep byte-identical to the plan doc) ──

type CodeKind = "focus" | "sql" | "emit" | "docs" | "aquifer" | "read" | "examples" | "search" | "draft"

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
  | { type: "run_start"; runId: string; sessionId?: string }
  | { type: "focus_changed"; fileId: string; fileName: string; cellId?: string }
  | { type: "assistant_delta"; text: string }
  | { type: "code_start"; step: number; kind: CodeKind; summary: string }
  | { type: "code_result"; step: number; ok: boolean; summary: string; data?: ToolResultData }
  | { type: "proposal"; proposal: AgentProposal }
  | { type: "aquifer_proposal"; proposal: AquiferPublishProposal }
  | { type: "progress"; label: string; done: number; total: number }
  | { type: "usage"; promptTokens: number; completionTokens: number; costCredits: number }
  | { type: "done"; runId: string; status: "ok" | "capped" | "error" }
  | { type: "error"; message: string }
  // AQU-AGENT §4 — harness frames (tool.code.*, memory.proposed,
  // brief.proposed, budget, budget.exhausted) plus changeset.staged for
  // backward-compatible rendering of persisted runs.
  | HarnessFrame

// ── Tool schema (OpenAI tool-calling, served to the model) ──────────────────
// Semantic tools carry the recipes in CODE (design 2026-07-02 §3); `sql` stays
// as the guarded escape hatch and `execute` as a back-compat shim (scripted
// mocks + old transcripts in stored sessions still call it).

const SCOPE_PROPS = {
  fileId: { type: "string", description: "File id, #f-alias, or :file (the focused file)." },
  ref: { type: "string", description: 'Scripture scope: "MRK", "MRK 4", or "MRK 4:1-20". Resolves the file by book code when fileId is omitted.' },
} as const

const AQUIFER_PROPS = {
  op: { type: "string", enum: ["search", "read", "publish"] },
  q: { type: "string" },
  limit: { type: "number" },
  path: { type: "string", description: "Site path from a search result url, e.g. /en/passages/RUT/1/8/" },
  maxChars: { type: "number" },
  question: { type: "string" },
  answer: { type: "string" },
  status: { type: "string", enum: ["answered", "undetermined"] },
  citations: { type: "array", items: { type: "object" } },
} as const

function buildTools(bibleResourcesEnabled: boolean) {
  const tools: Record<string, unknown>[] = [
    {
      type: "function",
      function: {
        name: "focus",
        description:
          "Move the user's visible workbench to a project file and optional cell/reference. Use this when the user asks to open, show, navigate to, or work in a file. This changes UI focus only; it does not edit project data.",
        parameters: {
          type: "object",
          properties: {
            ...SCOPE_PROPS,
            fileName: { type: "string", description: "File name when no file id/alias is known; exact names are preferred, otherwise a unique partial match is accepted." },
            cellId: { type: "string", description: "Optional cell id, #c-alias, or :cell." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read",
        description:
          "Aligned source/target rows for a file or ref range, in display order, with per-cell status (untranslated | drafted | stale | validated | translated). Start most tasks here.",
        parameters: {
          type: "object",
          properties: {
            ...SCOPE_PROPS,
            filter: { type: "string", enum: ["all", "untranslated", "stale", "flagged", "validated", "drafted"] },
            limit: { type: "number", description: "Max rows (default 50, cap 200)." },
            offset: { type: "number" },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "examples",
        description:
          "Few-shot translation pairs to imitate: validated pairs first, then similarity-retrieved. Give the source text you are about to translate (or cellIds).",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string", description: "Source text to find similar pairs for." },
            cellIds: { type: "array", items: { type: "string" }, description: "Alternative: cell ids / #c-aliases whose source text seeds the query." },
            n: { type: "number", description: "Max pairs (default 6, cap 12)." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "search",
        description:
          "Full-text search across the project. side: cells (default, source+target) | source | target | comments | terms.",
        parameters: {
          type: "object",
          properties: {
            q: { type: "string" },
            side: { type: "string", enum: ["cells", "source", "target", "comments", "terms"] },
            fileId: SCOPE_PROPS.fileId,
            limit: { type: "number" },
          },
          required: ["q"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "draft",
        description:
          "Draft untranslated cells in scope with the project's drafting pipeline (exemplars + discourse context + rule lint) and STAGE the results as a proposal for user approval. Preferred over writing translations yourself. One call handles up to 50 cells; the result says how many remain.",
        parameters: {
          type: "object",
          properties: {
            ...SCOPE_PROPS,
            cellIds: { type: "array", items: { type: "string" }, description: "Draft exactly these cells (ids or #c-aliases) instead of every untranslated cell in scope." },
            limit: { type: "number", description: "Max cells this call (default 20, cap 50)." },
            instructions: { type: "string", description: "Extra guidance for this batch (tone, term choices, fixes from lint)." },
          },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "propose",
        description:
          "STAGE events for user approval (nothing writes until they Apply): validations, comments, renames, back-translations, or hand-written cell commits. Each: {kind, fileId?, cellId?, parentId?, payload}. Aliases (#c1/#e1/#f1) and :vars accepted.",
        parameters: {
          type: "object",
          properties: {
            events: { type: "array", items: { type: "object" } },
          },
          required: ["events"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "sql",
        description:
          "Escape hatch: one read-only SELECT (CTEs allowed) against the project schema, when no other tool fits. Bind vars: :project, :user, :file, :cell. Max 200 rows.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "docs",
        description:
          "Fetch a cookbook: checking | terminology | validation | history | assignments | files-and-refs | brief.",
        parameters: {
          type: "object",
          properties: { topic: { type: "string" } },
          required: ["topic"],
        },
      },
    },
    // ── AQU-AGENT §2 harness tools (sandbox / import / memory) ──────────────
    {
      type: "function",
      function: {
        name: "run_code",
        description:
          "Run JS or Python in a locked-down sandbox (no network, no secrets) to parse or inspect files. First use lazily opens the run's container.",
        parameters: {
          type: "object",
          properties: {
            language: { type: "string", enum: ["js", "python"] },
            code: { type: "string" },
            timeoutMs: { type: "number", description: "Optional exec timeout (default 60s, max 300s)." },
          },
          required: ["language", "code"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "load_artifact",
        description:
          "Copy a project artifact (by id) into the sandbox at `path` so run_code can read it. Untrusted content — memory writes lock after this until a clean turn.",
        parameters: {
          type: "object",
          properties: {
            artifactId: { type: "string" },
            path: { type: "string", description: "Destination path in the sandbox (under /workspace)." },
          },
          required: ["artifactId", "path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_sandbox_file",
        description: "Read a sandbox file back as utf-8 text (capped ~48KB) to inspect outputs.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            maxBytes: { type: "number" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "propose_memory",
        description:
          "STAGE a durable project note for human review (never approved by you). Path must match ^[a-z0-9-/]+\\.md$, content ≤10KB. Disabled while parsing untrusted content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["path", "content", "rationale"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "propose_brief_update",
        description:
          "STAGE a proposed change to the project brief for human review. Disabled while parsing untrusted content.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string" },
            rationale: { type: "string" },
          },
          required: ["content", "rationale"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_memory",
        description:
          "Read approved project memory. Without path: the index (path + first line). With path: the full content of one approved memory.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    },
    // Back-compat shim — scripted mocks and stored v1 sessions call this.
    {
      type: "function",
      function: {
        name: "execute",
        description: "Legacy combined tool. Prefer the dedicated tools. Exactly one field per call.",
        parameters: {
          type: "object",
          properties: {
            sql: { type: "string" },
            emit: { type: "array", items: { type: "object" } },
            docs: { type: "string" },
            ...(bibleResourcesEnabled ? { aquifer: { type: "object", properties: AQUIFER_PROPS } } : {}),
          },
        },
      },
    },
  ]
  if (bibleResourcesEnabled) {
    tools.splice(5, 0, {
      type: "function",
      function: {
        name: "aquifer",
        description:
          "Consult bibletranslation.org scholarly reference data. {op:'search',q,limit?} | {op:'read',path,maxChars?} | {op:'publish',question,answer,status,citations}. publish STAGES a Q&A for user approval (free).",
        parameters: { type: "object", properties: AQUIFER_PROPS, required: ["op"] },
      },
    })
  }
  return tools
}

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
  /** Session-native (v2): the server holds the conversation (incl. tool
   *  results) under this client-generated UUID; `messages` then carries only
   *  the new user turn. Absent → v1 behavior (client sends the whole convo). */
  sessionId: z.string().uuid().optional(),
  messages: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .min(1)
    .max(10),
  context: z.object({ fileId: z.string().optional(), cellId: z.string().optional() }).optional(),
  translatorProfile: translatorProfileSchema,
  /** AQU-AGENT Wave-2: files the user attached in the composer, already
   *  uploaded as project artifacts (POST /projects/:id/agent-artifacts). The
   *  agent is told they're available and can pull them into the sandbox with
   *  the `load_artifact` tool. Capped so a client can't flood the prompt. */
  artifacts: z
    .array(z.object({ artifactId: z.string().min(1), fileName: z.string().min(1) }))
    .max(10)
    .optional(),
})

/** AQU-AGENT Wave-2 — system message announcing composer-attached artifacts.
 *  English scaffolding (contracts §7). Lists each artifact's id + file name and
 *  directs the model to `load_artifact` (which pulls bytes into the sandbox and
 *  flips the untrusted-content guard) rather than assuming the content. */
function buildAttachedArtifactsPrompt(
  artifacts: { artifactId: string; fileName: string }[],
): string {
  const lines = artifacts.map((a) => `- ${a.fileName} (artifactId: ${a.artifactId})`)
  return [
    "The user attached the following file(s) to this run. They are stored as project artifacts, NOT inlined here.",
    ...lines,
    "",
    "To inspect one, call load_artifact { artifactId, path } to copy it into the sandbox, then run_code / read_sandbox_file to read it. Loading artifact bytes puts the run in untrusted-content mode (memory writes are disabled that turn).",
  ].join("\n")
}

// ── OpenRouter message plumbing ─────────────────────────────────────────────
// ToolCall / UpstreamMessage and the streaming/JSON turn reader live in
// lib/agent/upstream.ts; the persisted-session shapes in lib/agent/sessions.ts.

type ConvoMessage = { role: "system"; content: string } | StoredMessage

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

  // Resolve the agent model from the global store (env/default fallback).
  const platformSettings = await getPlatformSettingsCached(c.env)
  const agentModel = resolveAgentModel(c.env, platformSettings)

  // AI guard: model allowlist + per-user/global daily budget (AQU-265).
  const guard = await runAiGuard(agentModel, user.id, c.env.AQUILLA_PG, c.env)
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

  // Session-native conversation (v2): load the stored convo — including tool
  // results — so a follow-up reuses what prior runs discovered. Ownership is
  // enforced here; an unknown id just starts a fresh session under that id.
  let storedConvo: StoredMessage[] = []
  // Untrusted-content bit carried over from the session's last run: if the prior
  // run left untrusted content in scope, this run starts with memory writes
  // locked (adversarial-panel authz-M2 / races-F2).
  let storedUntrusted = false
  if (body.sessionId) {
    const session = await loadSession(c.env.AQUILLA_PG, body.sessionId)
    if (session && (session.projectId !== body.projectId || session.userId !== user.id)) {
      return c.json({ error: "forbidden", message: "Session belongs to another project or user" }, 403)
    }
    storedConvo = session?.convo ?? []
    storedUntrusted = session?.untrustedActive ?? false
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
    model: agentModel,
    sessionId: body.sessionId ?? null,
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (frame: AgentFrame) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
      }
      runAgentLoop({ env, body, storedConvo, storedUntrusted, user: { id: user.id, username: user.username }, roleLevel: role.level, runId, orgId, model: agentModel, draftModel: resolveDraftModel(c.env, platformSettings, agentModel), signal, send })
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

// ── GET /runs — the per-project acceptance ledger (design §7 health metrics:
//    "≥40% of staged writes applied"). staged_count lives on agent_runs; the
//    applied/undone counts come from event-log provenance (agent_run_id /
//    undo_of_agent_run_id), so this is a read-only rollup — no extra write path.
agent.get("/runs", authMiddleware, async (c) => {
  const projectId = c.req.query("projectId")
  if (!projectId) {
    return c.json({ error: "bad_request", message: "projectId is required" }, 400)
  }
  const user = c.get("user")
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) {
    return c.json({ error: "forbidden", message: "No access to this project" }, 403)
  }
  const limitRaw = Number(c.req.query("limit"))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
  const runs = await listAgentRuns(c.env.AQUILLA_PG, projectId, limit)
  return c.json({ runs })
})

interface LoopArgs {
  env: Env
  body: z.infer<typeof runRequestSchema>
  /** Prior turns from agent_sessions (incl. tool results); [] when sessionless. */
  storedConvo: StoredMessage[]
  /** Session's carried-over untrusted-content bit (false when sessionless). */
  storedUntrusted: boolean
  user: { id: number; username: string }
  roleLevel: number
  runId: string
  orgId: number
  model: string
  /** The draft tool's translation model (resolveDraftModel). */
  draftModel: string
  signal: AbortSignal
  send: (frame: AgentFrame) => void
}

async function runAgentLoop({ env, body, storedConvo, storedUntrusted, user, roleLevel, runId, orgId, model, draftModel, signal, send }: LoopArgs): Promise<void> {
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

  // AQU-AGENT §2 — read-side memory context (approved memories + brief). Pure
  // reads; degrades to empty on any failure so a run never dies on grounding.
  let memory: MemoryContext = {
    brief: "",
    memoryIndex: [],
    readMemory: async () => null,
  }
  try {
    memory = await buildMemoryContext(env.AQUILLA_PG, body.projectId)
  } catch {
    /* memory grounding is best-effort */
  }

  const convo: ConvoMessage[] = [
    {
      role: "system" as const,
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
        // The profile language is an ambiguity fallback. The user's latest
        // message drives ordinary conversation; the project target language
        // remains reserved for translation output.
        responseLanguage: body.translatorProfile?.responseLanguage,
        briefSummary,
      }),
    },
    // AQU-AGENT §2 — second system message: verbatim brief + approved-memory
    // index + new-tool guidance + reply-language rule. Kept separate so the
    // existing schema-card prompt stays byte-identical.
    {
      role: "system" as const,
      content: buildAugmentSystemPrompt({
        memory,
        fallbackResponseLanguage: body.translatorProfile?.responseLanguage,
      }),
    },
    // AQU-AGENT Wave-2 — attached artifacts. The user attached these files in
    // the composer; they're already uploaded as project artifacts. Tell the
    // model they exist and how to read them (load_artifact → sandbox), rather
    // than pasting their bytes into the prompt.
    ...(body.artifacts && body.artifacts.length > 0
      ? [{ role: "system" as const, content: buildAttachedArtifactsPrompt(body.artifacts) }]
      : []),
    ...storedConvo,
    ...body.messages,
  ]

  let promptTokens = 0
  let completionTokens = 0
  let costCents = 0
  let steps = 0
  let stagedCount = 0
  let status: "ok" | "capped" | "error" = "ok"

  // AQU-AGENT §2 run state: cost cap, untrusted-content guard, and the sandbox
  // container id.
  const costCapCents = resolveRunCostCapCents(env.AGENT_RUN_COST_CAP_CENTS)
  // Budget/usage frames are org-facing: convert raw provider cents → CREDITS
  // (agent-rail markup) so the client only ever sees credits, consistent with
  // the org credits panel. resolveCreditConfig never throws.
  const creditCfg = await resolveCreditConfig(env, env.AQUILLA_PG, orgId)
  const toCredits = (cents: number) => creditsFor(cents, "agent", creditCfg)
  // `active` seeds from the session's carried-over bit so a run that inherits
  // untrusted content starts locked; `usedThisTurn` gates the within-run clear;
  // `runHad` records whether ANY turn in this run used an untrusted tool, which
  // is what we persist back to the session (adversarial-panel authz-M2/races-F2).
  const untrusted = { active: storedUntrusted, usedThisTurn: false, runHad: false }
  // races-F4: one sandbox container PER RUN (never reuse the session's). Cross-run
  // container reuse is deferred to v2 — the model reloads artifacts each run via
  // load_artifact (see the attached-artifacts prompt). See AQU-AGENT-TRACES.md.
  const sandboxSessionId = runId
  const harness: HarnessToolCtx = {
    env,
    runId,
    sandboxSessionId,
    sessionId: body.sessionId ?? null,
    projectId: body.projectId,
    userId: user.id,
    username: user.username,
    signal,
    send,
    memory,
    markUntrusted: () => {
      untrusted.active = true
      untrusted.usedThisTurn = true
      untrusted.runHad = true
    },
    isUntrustedActive: () => untrusted.active,
  }

  send({ type: "run_start", runId, ...(body.sessionId ? { sessionId: body.sessionId } : {}) })

  const tools = buildTools(bibleResourcesEnabled)

  try {
    let iteration = 0
    let rounds = 0
    for (;;) {
      if (signal.aborted) {
        status = "error"
        break
      }
      if (iteration >= MAX_TOOL_ITERATIONS || rounds >= MAX_TOTAL_ROUNDS) {
        status = "capped"
        send({ type: "error", message: `Tool-iteration cap reached — run stopped.` })
        break
      }
      if (promptTokens + completionTokens > TOKEN_CEILING) {
        status = "capped"
        send({ type: "error", message: `Token ceiling reached (${Math.round(TOKEN_CEILING / 1000)}k) — run stopped.` })
        break
      }
      // AQU-AGENT §2 cost cap: halt gracefully BEFORE the next paid model call
      // once the accumulated OpenRouter cost reaches the ceiling.
      if (costCents >= costCapCents) {
        status = "capped"
        send({ type: "budget.exhausted", runId, spentCredits: toCredits(costCents), capCredits: toCredits(costCapCents) })
        break
      }

      // A new model turn — reset the per-turn untrusted flag. The persisted
      // `untrusted.active` only clears at the END of a turn that used no
      // untrusted-content tool (contracts §2).
      untrusted.usedThisTurn = false

      const upstream = await fetch(resolveOpenRouterUrl(env), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: convo,
          tools,
          stream: true,
          ...openRouterExtras(env.OPENROUTER_BASE_URL),
        }),
        signal,
      })

      if (!upstream.ok) {
        const text = await upstream.text()
        send({ type: "error", message: `openrouter_error ${upstream.status}: ${text.slice(0, 500)}` })
        status = "error"
        break
      }

      // Streaming (SSE) upstream forwards prose token by token; JSON bodies
      // (scripted mocks) forward the whole content once. Either way `message`
      // is the complete assistant turn for the transcript.
      let message: UpstreamMessage
      try {
        const turn = await readModelTurn(upstream, (text) => send({ type: "assistant_delta", text }))
        message = turn.message
        promptTokens += turn.usage?.prompt_tokens ?? 0
        completionTokens += turn.usage?.completion_tokens ?? 0
        costCents += (turn.usage?.cost ?? 0) * 100
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) })
        status = "error"
        break
      }

      // AQU-AGENT §4 — cost meter after each turn's usage lands.
      send({ type: "budget", runId, spentCredits: toCredits(costCents), capCredits: toCredits(costCapCents) })

      convo.push({ ...message, role: "assistant" })

      const toolCalls = message.tool_calls ?? []
      if (toolCalls.length === 0) break // final prose — the run is complete

      // Budget: only rounds that WRITE or run raw SQL consume iterations —
      // read-shaped tools (read/examples/search/docs/aquifer) are bounded,
      // recipe-encoded calls and stay free (MAX_TOTAL_ROUNDS backstops loops).
      rounds++
      if (toolCalls.some((call) => budgetedCall(call))) iteration++
      let budgetTripped = false
      for (let ci = 0; ci < toolCalls.length; ci++) {
        const call = toolCalls[ci]
        // races-F3: re-check the caps mid-turn before each BUDGETED call. A prior
        // tool in this same turn can push cost/tokens past the cap (e.g. a draft's
        // internal model call folds cost via addUsage). Halt rather than run more
        // paid work — the top-of-loop check only fires between turns.
        if (
          budgetedCall(call) &&
          (costCents >= costCapCents || promptTokens + completionTokens > TOKEN_CEILING)
        ) {
          status = "capped"
          send({ type: "budget.exhausted", runId, spentCredits: toCredits(costCents), capCredits: toCredits(costCapCents) })
          // Answer every not-yet-run tool_call so the stored transcript stays
          // valid for a follow-up run (each tool_call needs a tool message).
          for (let cj = ci; cj < toolCalls.length; cj++) {
            convo.push({
              role: "tool",
              tool_call_id: toolCalls[cj].id,
              content: "run halted: budget exhausted before this tool ran",
            })
          }
          budgetTripped = true
          break
        }
        steps++
        const result = await executeToolCall(call, {
          env,
          aliases,
          sqlVars,
          stageCtx,
          send,
          step: steps,
          signal,
          draft: {
            model: draftModel,
            apiKey: env.OPENROUTER_API_KEY ?? "",
            url: resolveOpenRouterUrl(env),
            sourceLanguage: languages.sourceLanguage,
            targetLanguage: languages.targetLanguage,
            briefSummary,
          },
          addUsage: (u) => {
            promptTokens += u.prompt_tokens ?? 0
            completionTokens += u.completion_tokens ?? 0
            costCents += (u.cost ?? 0) * 100
          },
          // Acceptance-rate denominator (0051): staged commits per run. The
          // numerator lands in the event log when the user Applies.
          countStaged: (n) => {
            stagedCount += n
          },
          harness,
        })
        convo.push({ role: "tool", tool_call_id: call.id, content: result })
      }

      // races-F3: a mid-turn budget trip ends the run (already 'capped').
      if (budgetTripped) break

      // End of turn: the untrusted flag clears ONLY after a turn with no
      // untrusted-content tool use (contracts §2). A turn that touched artifact
      // bytes keeps memory writes locked into the next turn too.
      if (!untrusted.usedThisTurn) untrusted.active = false
    }
  } catch (err) {
    if (!signal.aborted) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) })
    }
    status = "error"
  }

  // AQU-AGENT §2 — best-effort sandbox teardown. Never blocks the run's
  // settlement; failures are logged, not surfaced.
  if (env.AGENT_SANDBOX_URL && env.AGENT_SANDBOX_KEY) {
    await sandboxDestroy(env, sandboxSessionId)
  }

  send({ type: "usage", promptTokens, completionTokens, costCredits: toCredits(costCents) })
  send({ type: "done", runId, status })

  try {
    await finishAgentRun(env.AQUILLA_PG, { runId, status, promptTokens, completionTokens, costCents, steps, stagedCount })
  } catch (err) {
    console.error("[agent] failed to finalise agent_runs row:", err)
  }

  // Persist the session convo (minus the per-run system prompt), compacted so
  // old tool results shrink to digests. Best-effort — a failed save costs the
  // next turn its shared context, never the run itself.
  if (body.sessionId) {
    try {
      const stored = convo.filter((m): m is StoredMessage => m.role !== "system")
      await saveSession(env.AQUILLA_PG, {
        sessionId: body.sessionId,
        projectId: body.projectId,
        userId: user.id,
        convo: compactConvo(stored),
        // The session flag clears ONLY when this run completed with zero untrusted
        // tool use; any untrusted tool use in the run carries the lock forward
        // (adversarial-panel authz-M2 / races-F2).
        untrustedActive: untrusted.runHad,
      })
    } catch (err) {
      console.error("[agent] failed to persist agent_sessions row:", err)
    }
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
  signal: AbortSignal
  /** Config for the draft tool's internal model call. */
  draft: {
    model: string
    apiKey: string
    url: string
    sourceLanguage?: string
    targetLanguage?: string
    briefSummary?: string
  }
  /** Folds a tool-internal model call's usage into the run totals. */
  addUsage: (usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number }) => void
  /** Folds staged target.cell.commit events into the run's staged_count. */
  countStaged: (n: number) => void
  /** AQU-AGENT §2 harness context (sandbox / import / memory tools). */
  harness: HarnessToolCtx
}

/** Does this tool call consume the write/SQL iteration budget? Write-shaped
 *  harness tools (propose_* persist proposals)
 *  count too; sandbox reads + read_memory stay free (MAX_TOTAL_ROUNDS backstop). */
function budgetedCall(call: ToolCall): boolean {
  const name = call.function.name
  if (name === "draft" || name === "propose" || name === "sql") return true
  if (name === "propose_memory" || name === "propose_brief_update") return true
  if (name !== "execute") return false
  try {
    const args = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>
    return args.sql !== undefined || args.emit !== undefined
  } catch {
    return true
  }
}

// ── Per-tool handlers (each sends code_start/code_result and returns the
//    tool-result text the model sees) ────────────────────────────────────────

async function runSqlTool(sql: string, t: ToolCallEnv): Promise<string> {
  t.send({ type: "code_start", step: t.step, kind: "sql", summary: sql.slice(0, 120) })
  const run = await runGuardedSql(t.env.AQUILLA_PG, sql, t.sqlVars, t.aliases)
  const text = run.ok
    ? compressRows(run.rows, t.aliases, { projectId: t.sqlVars.projectId })
    : `error: ${run.error}`
  t.send({ type: "code_result", step: t.step, ok: run.ok, summary: text.slice(0, RESULT_SUMMARY_MAX) })
  return text
}

/** Move the client workbench's visible file/cell without writing project data.
 * The focused ids also rebind :file/:cell for subsequent tools in this run. */
async function runFocusTool(args: Record<string, unknown>, t: ToolCallEnv): Promise<string> {
  t.send({
    type: "code_start",
    step: t.step,
    kind: "focus",
    summary: String(args.ref ?? args.fileName ?? args.fileId ?? "project file").slice(0, 120),
  })

  let scopedArgs: { fileId?: unknown; ref?: unknown } = { fileId: args.fileId, ref: args.ref }
  if (args.fileName !== undefined && args.fileId === undefined && args.ref === undefined) {
    if (typeof args.fileName !== "string" || !args.fileName.trim()) {
      const msg = "error: fileName must be a non-empty string"
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
    const matches = await t.env.AQUILLA_PG.prepare(
        `SELECT id, name FROM files
       WHERE project_id = ? AND deleted_at IS NULL AND name ILIKE ?
       ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, length(name), name
       LIMIT 2`,
      )
      .bind(t.stageCtx.projectId, `%${args.fileName.trim()}%`, args.fileName.trim())
      .all<{ id: string; name: string }>()
    if (matches.results.length === 0) {
      const msg = `error: no project file matches "${args.fileName.trim()}"`
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
    const requestedName = args.fileName.trim().toLocaleLowerCase()
    const exact = matches.results.find((row) => row.name.toLocaleLowerCase() === requestedName)
    if (!exact && matches.results.length > 1) {
      const msg = `error: file name is ambiguous — matches ${matches.results.map((row) => row.name).join(", ")}`
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
    scopedArgs = { fileId: (exact ?? matches.results[0]).id }
  }

  const scope = await resolveScope(t.env.AQUILLA_PG, scopedArgs, {
    projectId: t.stageCtx.projectId,
    focusedFileId: t.stageCtx.fileId,
    aliases: t.aliases,
  })
  if (!scope.ok) {
    const msg = `error: ${scope.error}`
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }

  const file = await t.env.AQUILLA_PG.prepare(
    "SELECT id, name FROM files WHERE project_id = ? AND id = ? AND deleted_at IS NULL",
  )
    .bind(t.stageCtx.projectId, scope.fileId)
    .first<{ id: string; name: string }>()
  if (!file) {
    const msg = "error: focused file does not exist in this project"
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }

  let cellId: string | undefined
  if (args.cellId !== undefined) {
    if (typeof args.cellId !== "string") {
      const msg = "error: cellId must be a string"
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
    if (args.cellId === ":cell") cellId = t.stageCtx.cellId
    else if (AliasMap.isAlias(args.cellId)) cellId = t.aliases.resolve(args.cellId)
    else cellId = args.cellId
    if (!cellId) {
      const msg = `error: ${args.cellId === ":cell" ? ":cell is not bound" : `unknown cell ${args.cellId}`}`
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
    const exists = await t.env.AQUILLA_PG.prepare(
      "SELECT cell_id FROM cells WHERE project_id = ? AND file_id = ? AND cell_id = ? LIMIT 1",
    )
      .bind(t.stageCtx.projectId, file.id, cellId)
      .first<{ cell_id: string }>()
    if (!exists) {
      const msg = "error: cell does not belong to the focused file"
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
  } else if (scope.range) {
    const pairs = await selectCellPairs(t.env.AQUILLA_PG, t.stageCtx.projectId, scope)
    cellId = pairs[0]?.cellId
  }

  t.stageCtx.fileId = file.id
  t.stageCtx.cellId = cellId
  t.sqlVars.fileId = file.id
  t.sqlVars.cellId = cellId
  t.aliases.alias(file.id, "f")
  if (cellId) t.aliases.alias(cellId, "c")

  t.send({
    type: "focus_changed",
    fileId: file.id,
    fileName: file.name,
    ...(cellId ? { cellId } : {}),
  })
  const msg = `Focused ${file.name}${cellId ? " at the requested cell" : ""}. Subsequent :file/:cell references now use this focus.`
  t.send({ type: "code_result", step: t.step, ok: true, summary: msg })
  return msg
}

async function runEmitTool(events: unknown[], t: ToolCallEnv): Promise<string> {
  t.send({ type: "code_start", step: t.step, kind: "emit", summary: `${events.length} events` })
  const { proposal, modelVerdictBlock } = await stageEvents(t.env.AQUILLA_PG, events, t.stageCtx)
  if (proposal) {
    t.send({ type: "proposal", proposal })
    t.countStaged(proposal.events.filter((ev) => ev.kind === "target.cell.commit").length)
  }
  t.send({
    type: "code_result",
    step: t.step,
    ok: proposal !== null,
    summary: modelVerdictBlock.slice(0, RESULT_SUMMARY_MAX),
  })
  return modelVerdictBlock
}

function runDocsTool(topic: string, t: ToolCallEnv): string {
  t.send({ type: "code_start", step: t.step, kind: "docs", summary: topic })
  const book = getCookbook(topic)
  t.send({
    type: "code_result",
    step: t.step,
    ok: book.ok,
    summary: book.ok ? `cookbook: ${topic} (${book.text.length} chars)` : book.text,
  })
  return book.text
}

function scopeSummary(args: { ref?: unknown; fileId?: unknown }): string {
  if (typeof args.ref === "string") return args.ref
  if (typeof args.fileId === "string") return args.fileId
  return ":file"
}

async function runReadTool(args: ReadArgs, t: ToolCallEnv): Promise<string> {
  const filter = typeof args.filter === "string" ? args.filter : "all"
  t.send({ type: "code_start", step: t.step, kind: "read", summary: `${scopeSummary(args)} · ${filter}` })
  const outcome = await executeRead(t.env.AQUILLA_PG, args, {
    projectId: t.stageCtx.projectId,
    focusedFileId: t.stageCtx.fileId,
    aliases: t.aliases,
  })
  t.send({
    type: "code_result",
    step: t.step,
    ok: outcome.ok,
    summary: outcome.text.slice(0, RESULT_SUMMARY_MAX),
    ...(outcome.data ? { data: outcome.data } : {}),
  })
  return outcome.text
}

async function runExamplesTool(args: ExamplesArgs, t: ToolCallEnv): Promise<string> {
  const seed = typeof args.text === "string" ? args.text.slice(0, 80) : `${Array.isArray(args.cellIds) ? args.cellIds.length : 0} cells`
  t.send({ type: "code_start", step: t.step, kind: "examples", summary: seed })
  const outcome = await executeExamples(t.env.AQUILLA_PG, args, {
    projectId: t.stageCtx.projectId,
    aliases: t.aliases,
  })
  t.send({
    type: "code_result",
    step: t.step,
    ok: outcome.ok,
    summary: outcome.text.slice(0, RESULT_SUMMARY_MAX),
    ...(outcome.data ? { data: outcome.data } : {}),
  })
  return outcome.text
}

async function runSearchTool(args: SearchArgs, t: ToolCallEnv): Promise<string> {
  const q = typeof args.q === "string" ? args.q.slice(0, 80) : "(no q)"
  t.send({ type: "code_start", step: t.step, kind: "search", summary: q })
  const outcome = await executeSearch(t.env.AQUILLA_PG, args, {
    projectId: t.stageCtx.projectId,
    focusedFileId: t.stageCtx.fileId,
    aliases: t.aliases,
  })
  t.send({
    type: "code_result",
    step: t.step,
    ok: outcome.ok,
    summary: outcome.text.slice(0, RESULT_SUMMARY_MAX),
    ...(outcome.data ? { data: outcome.data } : {}),
  })
  return outcome.text
}

/** target.cell.commit's role floor (schema-card AGENT_REQUIRED_ROLE). */
const AGENT_REQUIRED_ROLE_COMMIT = 400

async function runDraftTool(args: DraftArgs, t: ToolCallEnv): Promise<string> {
  t.send({ type: "code_start", step: t.step, kind: "draft", summary: scopeSummary(args) })
  // Fail fast BEFORE the (paid) internal model call — stageEvents would
  // reject each event anyway, but only after drafting.
  if (t.stageCtx.roleLevel < AGENT_REQUIRED_ROLE_COMMIT) {
    const msg = "error: drafting needs the contributor role — you act below it"
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }
  const outcome = await executeDraft(
    t.env.AQUILLA_PG,
    args,
    {
      projectId: t.stageCtx.projectId,
      focusedFileId: t.stageCtx.fileId,
      aliases: t.aliases,
      stageCtx: t.stageCtx,
      sourceLanguage: t.draft.sourceLanguage,
      targetLanguage: t.draft.targetLanguage,
      briefSummary: t.draft.briefSummary,
      signal: t.signal,
      sendProgress: (label, done, total) => t.send({ type: "progress", label, done, total }),
      addUsage: t.addUsage,
    },
    { model: t.draft.model, apiKey: t.draft.apiKey, url: t.draft.url },
  )
  if (outcome.proposal) {
    t.send({ type: "proposal", proposal: outcome.proposal })
    t.countStaged(outcome.proposal.events.filter((ev) => ev.kind === "target.cell.commit").length)
  }
  t.send({
    type: "code_result",
    step: t.step,
    ok: outcome.ok,
    summary: outcome.text.slice(0, RESULT_SUMMARY_MAX),
    ...(outcome.data ? { data: outcome.data } : {}),
  })
  return outcome.text
}

/** Run one tool call; emits code_start/code_result (+ proposal/progress)
 *  frames and returns the tool-result text the model sees. */
async function executeToolCall(call: ToolCall, t: ToolCallEnv): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>
  } catch {
    t.send({ type: "code_start", step: t.step, kind: "sql", summary: `(${call.function.name}: unparseable arguments)` })
    const msg = "error: tool arguments were not valid JSON"
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }

  switch (call.function.name) {
    case "focus":
      return runFocusTool(args, t)
    case "read":
      return runReadTool(args as ReadArgs, t)
    case "examples":
      return runExamplesTool(args as ExamplesArgs, t)
    case "search":
      return runSearchTool(args as SearchArgs, t)
    case "draft":
      return runDraftTool(args as DraftArgs, t)
    // AQU-AGENT §2 harness tools. These emit their own §4 frames (via
    // t.harness.send) and return the tool-result text directly.
    case "run_code":
      return runCode(args as RunCodeArgs, t.harness)
    case "load_artifact":
      return loadArtifact(args as LoadArtifactArgs, t.harness)
    case "read_sandbox_file":
      return readSandboxFile(args as ReadSandboxFileArgs, t.harness)
    case "propose_memory":
      return proposeMemoryTool(args as ProposeMemoryArgs, t.harness)
    case "propose_brief_update":
      return proposeBriefUpdateTool(args as ProposeBriefArgs, t.harness)
    case "read_memory":
      return readMemoryTool(args as ReadMemoryArgs, t.harness)
    case "propose": {
      if (!Array.isArray(args.events)) {
        t.send({ type: "code_start", step: t.step, kind: "emit", summary: "(invalid call)" })
        const msg = "error: propose needs {events: [...]}"
        t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
        return msg
      }
      return runEmitTool(args.events, t)
    }
    case "sql": {
      if (typeof args.query !== "string") {
        t.send({ type: "code_start", step: t.step, kind: "sql", summary: "(invalid call)" })
        const msg = "error: sql needs {query: \"SELECT …\"}"
        t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
        return msg
      }
      return runSqlTool(args.query, t)
    }
    case "docs": {
      if (typeof args.topic !== "string") {
        t.send({ type: "code_start", step: t.step, kind: "docs", summary: "(invalid call)" })
        const msg = "error: docs needs {topic: \"…\"}"
        t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
        return msg
      }
      return runDocsTool(args.topic, t)
    }
    case "aquifer":
      return runAquiferCall(args, t)
    case "execute":
      return executeLegacyCall(args, t)
    default: {
      t.send({ type: "code_start", step: t.step, kind: "sql", summary: `(unknown tool ${call.function.name})` })
      const msg = `error: unknown tool "${call.function.name}"`
      t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
      return msg
    }
  }
}

/** v1 combined tool — one of sql | emit | docs | aquifer per call.
 *
 *  DEPRECATED (2026-07-06): kept only for scripted mocks and stored v1
 *  session transcripts. Remove the tool + this handler once (a) the mocks
 *  call the semantic tools and (b) stored sessions predating v2 have aged
 *  out — check the warn below in worker logs for residual callers first. */
async function executeLegacyCall(
  args: { sql?: unknown; emit?: unknown; docs?: unknown; aquifer?: unknown },
  t: ToolCallEnv,
): Promise<string> {
  console.warn("[agent] legacy execute tool called — see executeLegacyCall deprecation note")
  const fields = (["sql", "emit", "docs", "aquifer"] as const).filter((f) => args[f] !== undefined)
  if (fields.length !== 1) {
    const kind = fields[0] ?? "sql"
    t.send({ type: "code_start", step: t.step, kind, summary: "(invalid call)" })
    const msg = "error: call the `execute` tool with exactly one of sql | emit | docs | aquifer"
    t.send({ type: "code_result", step: t.step, ok: false, summary: msg })
    return msg
  }
  if (fields[0] === "sql" && typeof args.sql === "string") return runSqlTool(args.sql, t)
  if (fields[0] === "emit" && Array.isArray(args.emit)) return runEmitTool(args.emit, t)
  if (fields[0] === "docs" && typeof args.docs === "string") return runDocsTool(args.docs, t)
  if (fields[0] === "aquifer") return runAquiferCall(args.aquifer, t)

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
