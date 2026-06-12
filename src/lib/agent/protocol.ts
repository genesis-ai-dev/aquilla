/**
 * protocol.ts — Translation agent wire contract (client mirror).
 *
 * AUTHORITATIVE SOURCE:
 * docs/superpowers/specs/2026-06-12-translation-agent-implementation-plan.md
 *
 * These shapes MUST match the server slice (auth-worker/src/lib/agent/)
 * byte-for-byte. Do not extend or rename fields here without updating the
 * plan doc and the server types together.
 */

// ── SSE frames (server → client), `data:`-prefixed JSON lines ─────────────

export type AgentFrame =
  | { type: 'run_start'; runId: string }
  | { type: 'assistant_delta'; text: string }
  | { type: 'code_start'; step: number; kind: 'sql' | 'emit' | 'docs'; summary: string } // summary: first 120 chars of sql / "N events" / topic
  | { type: 'code_result'; step: number; ok: boolean; summary: string }                  // compressed result block (what the model saw), truncated to 2000 chars for UI
  | { type: 'proposal'; proposal: AgentProposal }
  | { type: 'usage'; promptTokens: number; completionTokens: number; costCents: number }
  | { type: 'done'; runId: string; status: 'ok' | 'capped' | 'error' }
  | { type: 'error'; message: string }

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

// ── Request body for POST /api/v1/ai/agent/run ─────────────────────────────

export interface AgentRunRequest {
  projectId: string
  /** ≤10 turns, client truncates. */
  messages: { role: 'user' | 'assistant'; content: string }[]
  context?: { fileId?: string; cellId?: string }
}
