/**
 * protocol.ts — Translation agent wire contract (client mirror).
 *
 * AUTHORITATIVE SOURCE:
 * docs/superpowers/specs/2026-07-02-agent-mode-v2-design.md (supersedes the
 * 2026-06-12 plan's §frames).
 *
 * These shapes MUST match the server slice (auth-worker/src/lib/agent/ and
 * auth-worker/src/routes/agent.ts) byte-for-byte. Do not extend or rename
 * fields here without updating the design doc and the server types together.
 */

// ── Tool kinds (v2 semantic tools + v1 escape hatches) ─────────────────────

export type ToolKind =
  | "read" // aligned source/target rows for a ref range / file span
  | "examples" // few-shot pairs: validated first, then FTS-similar
  | "search" // project-wide FTS (source | target | comments | terms)
  | "draft" // server-side drafting pipeline → staged proposal
  | "emit" // stage arbitrary events (propose)
  | "sql" // guarded read-only SELECT (escape hatch)
  | "docs" // cookbook fetch
  | "aquifer" // Bible reference data (search/read/publish)

// ── Typed tool-result payloads (display-only; the model sees compact text) ──

export interface PassageRow {
  cellId: string
  fileId?: string
  ref?: string
  source: string
  target: string
  status?: "untranslated" | "drafted" | "stale" | "validated" | "flagged"
}

export interface ExamplePair {
  cellId?: string
  ref?: string
  source: string
  target: string
  validated?: boolean
}

export interface SearchHit {
  cellId: string
  fileId?: string
  ref?: string
  side: "source" | "target" | "comments" | "terms"
  snippet: string
}

export interface ToolResultData {
  cells?: PassageRow[]
  examples?: ExamplePair[]
  hits?: SearchHit[]
}

// ── SSE frames (server → client), `data:`-prefixed JSON lines ─────────────

export type AgentFrame =
  | { type: 'run_start'; runId: string; sessionId?: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'code_start'; step: number; kind: ToolKind; summary: string } // summary: first 120 chars of sql / "N events" / topic / ref range
  | { type: 'code_result'; step: number; ok: boolean; summary: string; data?: ToolResultData } // summary: compressed result block (what the model saw), ≤2000 chars for UI
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'aquifer_proposal'; proposal: AquiferPublishProposal }
  | { type: 'progress'; label: string; done: number; total: number } // bulk-job heartbeat
  | { type: 'usage'; promptTokens: number; completionTokens: number; costCredits: number }
  | { type: 'done'; runId: string; status: 'ok' | 'capped' | 'error' }
  | { type: 'error'; message: string }
  // ── AQU-AGENT wave-1 additions (docs/swarm/AQU-AGENT-CONTRACTS.md §4) ────
  // Additive only — existing consumers (run-state reducer, older server
  // builds) are unaffected by these new variants.
  | { type: 'tool.code.start'; runId: string; language: 'js' | 'python'; codePreview: string } // first 400 chars
  | { type: 'tool.code.output'; runId: string; stdout: string; stderr: string; truncated: boolean; durationMs: number }
  | { type: 'changeset.staged'; runId: string; changesetId: string; approvalUrl: string; summary: string; cellCount: number }
  | { type: 'memory.proposed'; runId: string; memoryId: string; path: string; preview: string }
  | { type: 'brief.proposed'; runId: string; proposalId: string; preview: string }
  | { type: 'budget'; runId: string; spentCredits: number; capCredits: number }
  | { type: 'budget.exhausted'; runId: string; spentCredits: number; capCredits: number }

// ── Staged proposal shape ──────────────────────────────────────────────────

export interface AgentProposal {
  proposalId: string            // uuid, server-generated
  runId: string
  events: StagedEvent[]         // resolved: real UUIDs, real parentId/sourceEventId
  summary: string               // human line: "Draft 12 cells in MRK 4"
}

export interface StagedEvent {
  kind: string                  // e.g. 'target.cell.commit'
  fileId?: string
  cellId?: string
  parentId?: string             // resolved current cells.event_id (server resolves at stage time)
  payload: Record<string, unknown> // server injects ai_suggestion: true and agent_run_id for cell commits
  // display context the client card needs:
  display: { canonicalRef?: string; before?: string; after?: string }
}

// ── Aquifer publish proposal (Bible-resources answer) ──────────────────────

/**
 * Streamed when the agent proposes publishing an answer to the Bible Aquifer
 * wiki (bibletranslation.org). Distinct from `AgentProposal` because Apply
 * goes through aquiferPublishAnswer (a wiki POST), NOT the events outbox.
 */
export interface AquiferPublishProposal {
  proposalId: string
  runId: string
  question: string
  answer: string
  status: 'answered' | 'undetermined'
  citations: { url: string; title?: string; quote?: string }[]
}

// ── Request body for POST /api/v1/ai/agent/run ─────────────────────────────

export interface AgentRunRequest {
  projectId: string
  /**
   * Session-native (v2): when set, the server holds the full conversation
   * (including tool results) under this id and the client sends ONLY the new
   * user message. `messages` then carries exactly one user turn.
   */
  sessionId?: string
  /** ≤10 turns, client truncates. With sessionId: exactly the new user turn. */
  messages: { role: 'user' | 'assistant'; content: string }[]
  context?: { fileId?: string; cellId?: string }
  /**
   * User-level translator profile (all fields optional, free-text). Injected as
   * JSON into the agent's system prompt to tailor answers and pick the reply
   * language. The server re-caps each field — never trust the client's lengths.
   * Mirrors src/lib/translator-profile.ts TranslatorProfile.
   */
  translatorProfile?: {
    responseLanguage?: string
    age?: string
    gender?: string
    educationLevel?: string
    religiousBackground?: string
    translationExperience?: string
    geographicalSetting?: string
    otherInfo?: string
  }
  /**
   * Files the user attached in the composer, already uploaded as project
   * artifacts (POST /api/v2/projects/:id/agent-artifacts). The server tells the
   * model they're available and how to pull them into the sandbox with the
   * `load_artifact` tool. Server re-caps the count. Must match the server
   * schema in auth-worker/src/routes/agent.ts (runRequestSchema.artifacts).
   */
  artifacts?: { artifactId: string; fileName: string }[]
}

/** Result of POST /api/v2/projects/:projectId/agent-artifacts. */
export interface UploadedArtifact {
  artifactId: string
  fileName: string
  sizeBytes: number
  sha256: string
}
