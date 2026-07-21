// AQU-AGENT §4 — server-side SSE frame shapes for the new harness tools.
//
// These MUST stay byte-compatible with the client mirror W1D adds to
// src/lib/agent/protocol.ts (AQU-AGENT-CONTRACTS §4). Exact field names below
// are normative — copy the shapes, do not rename. agent.ts widens its own
// AgentFrame union with `HarnessFrame` and emits these server-side.

/** The sandbox `run_code` tool started executing. codePreview = first 400 chars. */
export interface ToolCodeStartFrame {
  type: "tool.code.start"
  runId: string
  language: "js" | "python"
  codePreview: string
}

/** The sandbox `run_code` tool finished; stdout/stderr are the (capped) streams. */
export interface ToolCodeOutputFrame {
  type: "tool.code.output"
  runId: string
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}

/** Backward-compatible frame for previously staged PlanImport changesets. The
 * current product importer runs through the dedicated Import dialog, but old
 * persisted agent timelines may still contain this frame. */
export interface ChangesetStagedFrame {
  type: "changeset.staged"
  runId: string
  changesetId: string
  approvalUrl: string
  summary: string
  cellCount: number
}

/** A memory proposal was created (status `proposed`). `preview` is a short
 *  first-line/first-chars fragment for a toast. */
export interface MemoryProposedFrame {
  type: "memory.proposed"
  runId: string
  memoryId: string
  path: string
  preview: string
}

/** A project-brief update proposal was created (status `proposed`). */
export interface BriefProposedFrame {
  type: "brief.proposed"
  runId: string
  proposalId: string
  preview: string
}

/** Periodic run cost meter. spentCents / capCents in whole cents. */
export interface BudgetFrame {
  type: "budget"
  runId: string
  spentCents: number
  capCents: number
}

/** The run hit its cost cap and halted gracefully. */
export interface BudgetExhaustedFrame {
  type: "budget.exhausted"
  runId: string
  spentCents: number
  capCents: number
}

/** Union of every §4 frame W1B emits server-side. */
export type HarnessFrame =
  | ToolCodeStartFrame
  | ToolCodeOutputFrame
  | ChangesetStagedFrame
  | MemoryProposedFrame
  | BriefProposedFrame
  | BudgetFrame
  | BudgetExhaustedFrame

/** Default run cost cap (cents) when AGENT_RUN_COST_CAP_CENTS is unset. */
export const DEFAULT_RUN_COST_CAP_CENTS = 500

/** Resolve the run cost cap from env (AGENT_RUN_COST_CAP_CENTS), clamped to a
 *  positive number; falls back to the default on absent/garbage values. */
export function resolveRunCostCapCents(raw: string | undefined): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RUN_COST_CAP_CENTS
}
