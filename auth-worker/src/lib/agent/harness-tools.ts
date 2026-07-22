// AQU-AGENT §2 — new harness tool handlers (run_code, load_artifact,
// read_sandbox_file, propose_memory, propose_brief_update,
// read_memory). Each returns the tool-result TEXT the model sees and emits the
// relevant §4 SSE frame(s) via `ctx.send`. Registration + dispatch live in a
// minimal diff in agent.ts; the logic lives here to keep that file small.

import {
  sandboxExec,
  sandboxFetchArtifact,
  sandboxReadFile,
  type SandboxEnv,
} from "./sandbox-client"
import { proposeMemory, proposeBriefUpdate, type MemoryProvenance } from "./memory-writes"
import type { HarnessFrame } from "./frames"
import type { MemoryContext } from "../../../../db/shared/agent-memory"

/** read_sandbox_file default/utf-8 cap (contracts §2: 48KB). */
const READ_SANDBOX_MAX_BYTES = 48 * 1024

/** run_code codePreview length (contracts §4: first 400 chars). */
const CODE_PREVIEW_MAX = 400

/** Context threaded from the run loop into every harness tool. */
export interface HarnessToolCtx {
  env: SandboxEnv & { AQUILLA_PG: AquillaDb }
  runId: string
  /** The sandbox container id — one per session, or the runId when sessionless. */
  sandboxSessionId: string
  /** Owning agent_sessions id (null when sessionless) — for provenance. */
  sessionId: string | null
  projectId: string
  userId: number
  username: string
  signal: AbortSignal
  send: (frame: HarnessFrame) => void
  /** Read-side approved-memory context (buildMemoryContext). */
  memory: MemoryContext
  /** Marks that an untrusted-content tool touched artifact bytes this turn. */
  markUntrusted: () => void
  /** True while memory writes must be disabled (untrusted content in flight). */
  isUntrustedActive: () => boolean
}

const UNTRUSTED_BLOCK_MSG =
  "validation_failed: memory writes disabled while processing untrusted content"

// ── run_code ────────────────────────────────────────────────────────────────

export interface RunCodeArgs {
  language?: unknown
  code?: unknown
  timeoutMs?: unknown
}

export async function runCode(args: RunCodeArgs, ctx: HarnessToolCtx): Promise<string> {
  const language = args.language === "python" ? "python" : args.language === "js" ? "js" : null
  const code = typeof args.code === "string" ? args.code : null
  if (!language || !code) {
    return "error: run_code needs {language: \"js\"|\"python\", code: string}"
  }
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined

  // Executing code touches (potentially untrusted) artifact bytes in scope —
  // mark the turn so memory writes lock (contracts §2 untrusted-content guard).
  ctx.markUntrusted()

  ctx.send({
    type: "tool.code.start",
    runId: ctx.runId,
    language,
    codePreview: code.slice(0, CODE_PREVIEW_MAX),
  })

  const out = await sandboxExec(ctx.env, ctx.sandboxSessionId, { language, code, timeoutMs }, ctx.signal)
  if (!out.available) {
    ctx.send({
      type: "tool.code.output",
      runId: ctx.runId,
      stdout: "",
      stderr: out.reason,
      truncated: false,
      durationMs: 0,
    })
    return `error: ${out.reason}`
  }

  const r = out.data
  ctx.send({
    type: "tool.code.output",
    runId: ctx.runId,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: r.truncated ?? false,
    durationMs: r.durationMs,
  })

  const parts = [
    `ok: ${r.ok}`,
    r.stdout ? `stdout:\n${r.stdout}` : "stdout: (empty)",
    r.stderr ? `stderr:\n${r.stderr}` : "",
    r.resultJson ? `result:\n${r.resultJson}` : "",
    r.truncated ? "(output truncated)" : "",
  ].filter(Boolean)
  return parts.join("\n")
}

// ── load_artifact ─────────────────────────────────────────────────────────────

export interface LoadArtifactArgs {
  artifactId?: unknown
  path?: unknown
}

interface ArtifactKeyRow {
  r2_key: string
}

export async function loadArtifact(args: LoadArtifactArgs, ctx: HarnessToolCtx): Promise<string> {
  const artifactId = typeof args.artifactId === "string" ? args.artifactId : null
  const path = typeof args.path === "string" ? args.path : null
  if (!artifactId || !path) {
    return "error: load_artifact needs {artifactId: string, path: string}"
  }

  // Loading an artifact brings untrusted bytes into scope — lock memory writes.
  ctx.markUntrusted()

  // Resolve the artifact's R2 key, project-scoped (an artifact from another
  // project is invisible). We read the key directly from the shared DB rather
  // than the external metadata GET (which deliberately omits r2_key) — this
  // worker shares the same database, so no credential round-trip is needed.
  // SWARM-TODO(aqu-agent): if artifact storage moves behind a signed-URL
  // service, switch this to the sync-worker artifacts GET + a key it returns.
  let row: ArtifactKeyRow | null
  try {
    row = await ctx.env.AQUILLA_PG.prepare(
      `SELECT r2_key FROM artifacts WHERE id::text = ? AND project_id = ?`,
    )
      .bind(artifactId, ctx.projectId)
      .first<ArtifactKeyRow>()
  } catch (err) {
    return `error: artifact lookup failed — ${err instanceof Error ? err.message : String(err)}`
  }
  if (!row) return `error: artifact ${artifactId} not found in this project`

  const out = await sandboxFetchArtifact(
    ctx.env,
    ctx.sandboxSessionId,
    { key: row.r2_key, path },
    ctx.signal,
  )
  if (!out.available) return `error: ${out.reason}`
  return `ok: loaded artifact ${artifactId} → ${path} (${out.data.bytes} bytes)`
}

// ── read_sandbox_file ─────────────────────────────────────────────────────────

export interface ReadSandboxFileArgs {
  path?: unknown
  maxBytes?: unknown
}

export async function readSandboxFile(
  args: ReadSandboxFileArgs,
  ctx: HarnessToolCtx,
): Promise<string> {
  const path = typeof args.path === "string" ? args.path : null
  if (!path) return "error: read_sandbox_file needs {path: string}"

  // Reading a sandbox file pulls (potentially untrusted) artifact-derived bytes
  // into the model's context — mark the turn untrusted so memory writes lock,
  // exactly like run_code / load_artifact (adversarial-panel authz-M2).
  ctx.markUntrusted()

  const maxBytes =
    typeof args.maxBytes === "number" && args.maxBytes > 0
      ? Math.min(args.maxBytes, READ_SANDBOX_MAX_BYTES)
      : READ_SANDBOX_MAX_BYTES

  const out = await sandboxReadFile(ctx.env, ctx.sandboxSessionId, path, maxBytes, ctx.signal)
  if (!out.available) return `error: ${out.reason}`
  return out.data.truncated ? `${out.data.text}\n…(truncated at ${maxBytes} bytes)` : out.data.text
}

// ── propose_memory ─────────────────────────────────────────────────────────────

export interface ProposeMemoryArgs {
  path?: unknown
  content?: unknown
  rationale?: unknown
}

function provenanceOf(ctx: HarnessToolCtx): MemoryProvenance {
  return { runId: ctx.runId, sessionId: ctx.sessionId }
}

export async function proposeMemoryTool(
  args: ProposeMemoryArgs,
  ctx: HarnessToolCtx,
): Promise<string> {
  if (ctx.isUntrustedActive()) return UNTRUSTED_BLOCK_MSG
  const path = typeof args.path === "string" ? args.path : null
  const content = typeof args.content === "string" ? args.content : null
  const rationale = typeof args.rationale === "string" ? args.rationale : ""
  if (!path || !content) {
    return "error: propose_memory needs {path: string, content: string, rationale: string}"
  }

  const res = await proposeMemory(ctx.env.AQUILLA_PG, {
    projectId: ctx.projectId,
    path,
    content,
    rationale,
    createdBy: ctx.username,
    provenance: provenanceOf(ctx),
  })
  if (!res.ok) return `${res.code}: ${res.message}`

  ctx.send({
    type: "memory.proposed",
    runId: ctx.runId,
    memoryId: res.memoryId,
    path,
    preview: content.slice(0, 200),
  })
  return `proposed memory ${path} (id ${res.memoryId}, status proposed) — a human must approve it before it is used`
}

// ── propose_brief_update ───────────────────────────────────────────────────────

export interface ProposeBriefArgs {
  content?: unknown
  rationale?: unknown
}

export async function proposeBriefUpdateTool(
  args: ProposeBriefArgs,
  ctx: HarnessToolCtx,
): Promise<string> {
  if (ctx.isUntrustedActive()) return UNTRUSTED_BLOCK_MSG
  const content = typeof args.content === "string" ? args.content : null
  const rationale = typeof args.rationale === "string" ? args.rationale : ""
  if (!content) return "error: propose_brief_update needs {content: string, rationale: string}"

  const res = await proposeBriefUpdate(ctx.env.AQUILLA_PG, {
    projectId: ctx.projectId,
    content,
    rationale,
    createdBy: ctx.username,
  })
  if (!res.ok) return `${res.code}: ${res.message}`

  ctx.send({
    type: "brief.proposed",
    runId: ctx.runId,
    proposalId: res.proposalId,
    preview: content.slice(0, 200),
  })
  return `proposed brief update (id ${res.proposalId}, status proposed) — a human must approve it`
}

// ── read_memory ────────────────────────────────────────────────────────────────

export interface ReadMemoryArgs {
  path?: unknown
}

export async function readMemoryTool(args: ReadMemoryArgs, ctx: HarnessToolCtx): Promise<string> {
  const path = typeof args.path === "string" ? args.path : null
  if (!path) {
    // No path → the approved-memory index (path + first line). Human-edited
    // entries are flagged so the model knows they are human-owned (mem-M4).
    if (ctx.memory.memoryIndex.length === 0) return "No approved memories for this project yet."
    return ctx.memory.memoryIndex
      .map((m) => `- ${m.path}${m.humanEdited ? " [human-edited]" : ""}: ${m.firstLine}`)
      .join("\n")
  }
  const content = await ctx.memory.readMemory(path)
  if (content == null) return `error: no approved memory at ${path}`
  // Surface the human-edited status alongside the content (mem-M4). Content
  // itself stays pure; the marker is a separate prefixed line the model reads.
  const humanEdited = ctx.memory.memoryIndex.some((m) => m.path === path && m.humanEdited)
  return humanEdited
    ? `[human-edited — human-owned; do not silently re-propose over this, ask the user instead]\n${content}`
    : content
}
