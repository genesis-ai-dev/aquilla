// AQU-AGENT §2 — new harness tool handlers (run_code, load_artifact,
// read_sandbox_file, plan_import, propose_memory, propose_brief_update,
// read_memory). Each returns the tool-result TEXT the model sees and emits the
// relevant §4 SSE frame(s) via `ctx.send`. Registration + dispatch live in a
// minimal diff in agent.ts; the logic lives here to keep that file small.

import {
  sandboxExec,
  sandboxFetchArtifact,
  sandboxReadFile,
  type SandboxEnv,
} from "./sandbox-client"
import {
  stageImportViaChangeset,
  type ChangesetBridgeEnv,
  type PlanImportCellInput,
  type RunCredential,
} from "./changeset-bridge"
import { proposeMemory, proposeBriefUpdate, type MemoryProvenance } from "./memory-writes"
import type { HarnessFrame } from "./frames"
import type { MemoryContext } from "./memory-context-stub"

/** Cell cap for plan_import (contracts §2 PLAN_IMPORT_MAX_CELLS). */
export const PLAN_IMPORT_MAX_CELLS = 5000

/** read_sandbox_file default/utf-8 cap (contracts §2: 48KB). */
const READ_SANDBOX_MAX_BYTES = 48 * 1024

/** run_code codePreview length (contracts §4: first 400 chars). */
const CODE_PREVIEW_MAX = 400

/** Context threaded from the run loop into every harness tool. */
export interface HarnessToolCtx {
  env: SandboxEnv & ChangesetBridgeEnv & { AQUILLA_PG: AquillaDb }
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
  /** Register the ephemeral changeset credential for revoke at run end. */
  registerCredential: (cred: RunCredential) => void
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
  const maxBytes =
    typeof args.maxBytes === "number" && args.maxBytes > 0
      ? Math.min(args.maxBytes, READ_SANDBOX_MAX_BYTES)
      : READ_SANDBOX_MAX_BYTES

  const out = await sandboxReadFile(ctx.env, ctx.sandboxSessionId, path, maxBytes, ctx.signal)
  if (!out.available) return `error: ${out.reason}`
  return out.data.truncated ? `${out.data.text}\n…(truncated at ${maxBytes} bytes)` : out.data.text
}

// ── plan_import ───────────────────────────────────────────────────────────────

export interface PlanImportArgs {
  fileName?: unknown
  fileType?: unknown
  sourceLanguage?: unknown
  targetLanguage?: unknown
  cells?: unknown
}

function normalizeCells(raw: unknown): PlanImportCellInput[] | null {
  if (!Array.isArray(raw)) return null
  const cells: PlanImportCellInput[] = []
  for (const c of raw) {
    if (typeof c !== "object" || c === null) return null
    const rec = c as Record<string, unknown>
    if (typeof rec.original !== "string" || rec.original.length === 0) return null
    cells.push({
      original: rec.original,
      ...(typeof rec.id === "string" ? { id: rec.id } : {}),
      ...(typeof rec.translated === "string" ? { translated: rec.translated } : {}),
      ...(typeof rec.context === "string" ? { context: rec.context } : {}),
      ...(typeof rec.group === "string" ? { group: rec.group } : {}),
      ...(typeof rec.type === "string" ? { type: rec.type } : {}),
    })
  }
  return cells
}

export async function planImport(args: PlanImportArgs, ctx: HarnessToolCtx): Promise<string> {
  const fileName = typeof args.fileName === "string" ? args.fileName : null
  const fileType = typeof args.fileType === "string" ? args.fileType : null
  if (!fileName || !fileType) {
    return "error: plan_import needs {fileName: string, fileType: string, cells: [...]}"
  }
  const cells = normalizeCells(args.cells)
  if (!cells || cells.length === 0) {
    return "error: plan_import needs a non-empty cells array; each cell needs an `original` string"
  }
  if (cells.length > PLAN_IMPORT_MAX_CELLS) {
    // Do NOT chunk silently — tell the model to split the file (contracts §2).
    return `error: ${cells.length} cells exceeds the ${PLAN_IMPORT_MAX_CELLS}-cell limit per import — split this into multiple smaller files instead of chunking one file`
  }

  const { result, credential } = await stageImportViaChangeset(
    ctx.env,
    {
      userId: ctx.userId,
      projectId: ctx.projectId,
      runId: ctx.runId,
      request: {
        fileName,
        fileType,
        sourceLanguage: typeof args.sourceLanguage === "string" ? args.sourceLanguage : undefined,
        targetLanguage: typeof args.targetLanguage === "string" ? args.targetLanguage : undefined,
        cells,
      },
    },
    ctx.signal,
  )
  if (credential) ctx.registerCredential(credential)

  if (!result.ok) return `error: ${result.error}`

  ctx.send({
    type: "changeset.staged",
    runId: ctx.runId,
    changesetId: result.staged.changesetId,
    approvalUrl: result.staged.approvalUrl,
    summary: result.staged.summary,
    cellCount: result.staged.cellCount,
  })
  return (
    `STAGED import changeset ${result.staged.changesetId} — ${result.staged.summary}. ` +
    `A human must approve it at ${result.staged.approvalUrl}; nothing is written until they do.`
  )
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
    // No path → the approved-memory index (path + first line).
    if (ctx.memory.memoryIndex.length === 0) return "No approved memories for this project yet."
    return ctx.memory.memoryIndex.map((m) => `- ${m.path}: ${m.firstLine}`).join("\n")
  }
  const content = await ctx.memory.readMemory(path)
  if (content == null) return `error: no approved memory at ${path}`
  return content
}
