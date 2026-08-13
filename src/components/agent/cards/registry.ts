/**
 * registry.ts — the card registry (agent-complete design §4).
 *
 * Maps timeline content to the inline card that should render it. This file
 * is the checklist that makes "agent-complete" enumerable: a new capability
 * lands by adding a tier entry + a card mapping here, and both the dock and
 * the workbench pick it up through the same seams.
 *
 * Current coverage: passages (PassageCard), drafts (working set / receipt /
 * ProposalCard), validation (ValidationQueueCard). Next: comments, flags,
 * history, assignments.
 */

import type { AgentProposal, PassageRow } from "@/lib/agent/protocol"
import type { ToolItem } from "@/lib/agent/run-state"

// ── Commitment tiers (design §3) ────────────────────────────────────────────

/**
 * How a staged event kind may be committed:
 * - "prepared" — one-click apply, accept-all allowed (drafts, notes).
 * - "testimony" — per-item human click, ALWAYS; exempt from accept-all and
 *   from any future auto-apply toggle (validation, endorsement).
 * Kinds not listed are unsupported in the card layer (server gates remain
 * authoritative regardless).
 */
export const KIND_TIER: Record<string, "prepared" | "testimony"> = {
  "target.cell.commit": "prepared",
  // AQU-890: row creation is prepared work, not testimony — it asserts nothing
  // about quality, and its role floor (project_lead for the source lane) is the
  // gate that matters.
  "source.cell.create": "prepared",
  "target.cell.create": "prepared",
  "comment.create": "prepared",
  "cell.validate": "testimony",
  "cell.unvalidate": "testimony",
}

// ── Tool-item cards ─────────────────────────────────────────────────────────

/**
 * Rows for an inline PassageCard, when this tool item carries passage data.
 * Null → the collapsible chip is the whole rendering.
 */
export function passageRowsFor(item: ToolItem): PassageRow[] | null {
  if (item.tool !== "read" && item.tool !== "draft") return null
  const cells = item.data?.cells
  return cells && cells.length > 0 ? cells : null
}

// ── Proposal cards ──────────────────────────────────────────────────────────

/** True when every staged event is a cell.validate (→ ValidationQueueCard). */
export function isValidationProposal(proposal: AgentProposal): boolean {
  return proposal.events.length > 0 && proposal.events.every((ev) => ev.kind === "cell.validate")
}
