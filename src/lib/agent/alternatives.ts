/**
 * alternatives.ts — is this staged proposal a CHOICE of wordings? (AQU-2398)
 *
 * The in-app assistant can stage several wordings of ONE cell for a person to
 * compare and pick one from. Every surface that reviews staged commits has to
 * know that, because the ordinary treatments are all wrong for it:
 *
 * - applying a proposal's events applies them in order, and two commits to the
 *   same cell CHAIN (src/lib/agent/apply.ts) — an apply-all would write every
 *   wording and leave the last;
 * - anything keyed by `(proposalId, cellId)` — the working set's rows, the
 *   workbench receipt's decisions — collapses N wordings of one cell into a
 *   single row, so the choice disappears and whichever wording landed last
 *   silently becomes "the" draft.
 *
 * So this predicate lives in the lib layer, not in the card registry, and the
 * review surfaces route past their normal path on it.
 */

import type { AgentProposal } from "./protocol"

/**
 * True when the proposal is several mutually-exclusive wordings of one cell.
 *
 * The server's `alternatives` flag is required, never inferred from the shape:
 * several commits to one cell is also a legitimate ordinary proposal, and
 * those are meant to chain. The structure is re-checked anyway, so a
 * mislabelled frame cannot route a mixed or multi-cell proposal into the
 * pick-one treatment and lose its other changes.
 */
export function isAlternativesProposal(proposal: AgentProposal): boolean {
  if (proposal.alternatives !== true) return false
  if (proposal.events.length < 2) return false
  const cellId = proposal.events[0].cellId
  if (!cellId) return false
  return proposal.events.every((ev) => ev.kind === "target.cell.commit" && ev.cellId === cellId)
}
