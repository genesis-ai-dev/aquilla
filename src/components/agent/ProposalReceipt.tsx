/**
 * ProposalReceipt.tsx — the workbench's compact stand-in for ProposalCard.
 *
 * In the workbench the working set IS the review surface, so a proposal in
 * chat renders as a one-line receipt with LIVE counters (accepted / edited /
 * rejected / to review / checks) instead of a second full diff with its own
 * Apply. "Review" jumps focus to the first undecided row in the grid. The
 * dock keeps the full ProposalCard — there is no grid beside it there.
 */

import { AlertTriangle, ArrowRight, PenLine, Undo2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { AgentProposal } from "@/lib/agent/protocol"

export interface ReceiptCounts {
  accepted: number
  edited: number
  rejected: number
  /** Applied rows since compensated back to their pre-run value. */
  undone: number
  /** Undecided rows still in the review queue. */
  pending: number
  /** Rule-lint hits across the undecided rows. */
  checks: number
}

export interface ProposalReceiptProps {
  proposal: AgentProposal
  counts: ReceiptCounts
  /** Focus the first undecided row in the working set. */
  onReview?: () => void
  /** Compensate the applied rows back to their pre-run values (undo.ts). */
  onUndo?: () => void
}

/** "MRK 1:1 – MRK 1:5" from the staged events' display refs. */
function refSpan(proposal: AgentProposal): string | null {
  const refs = proposal.events
    .map((ev) => ev.display.canonicalRef)
    .filter((r): r is string => Boolean(r))
  if (refs.length === 0) return null
  return refs.length === 1 || refs[0] === refs[refs.length - 1]
    ? refs[0]
    : `${refs[0]} – ${refs[refs.length - 1]}`
}

export function ProposalReceipt({ proposal, counts, onReview, onUndo }: ProposalReceiptProps) {
  const span = refSpan(proposal)
  const settled = counts.pending === 0
  const undoable = counts.accepted + counts.edited > 0

  return (
    <div className="my-1.5 flex flex-col gap-1.5 rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <PenLine className="h-3.5 w-3.5 text-sky-500" />
        <span className="font-medium">
          {proposal.events.length} draft{proposal.events.length === 1 ? "" : "s"} staged
        </span>
        {span && <span className="font-mono text-[10px] text-muted-foreground">{span}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {counts.accepted > 0 && (
          <Badge variant="outline" className="border-emerald-800/60 text-[10px] text-emerald-600 dark:text-emerald-500">
            {counts.accepted} accepted
          </Badge>
        )}
        {counts.edited > 0 && (
          <Badge variant="outline" className="border-emerald-800/60 text-[10px] text-emerald-600 dark:text-emerald-500">
            {counts.edited} edited & accepted
          </Badge>
        )}
        {counts.rejected > 0 && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">
            {counts.rejected} rejected
          </Badge>
        )}
        {counts.undone > 0 && (
          <Badge variant="outline" className="border-amber-700/50 text-[10px] text-amber-600 dark:text-amber-400">
            {counts.undone} undone
          </Badge>
        )}
        {counts.pending > 0 && (
          <Badge variant="outline" className="border-sky-800/60 text-[10px] text-sky-600 dark:text-sky-400">
            {counts.pending} to review
          </Badge>
        )}
        {counts.checks > 0 && (
          <Badge variant="outline" className="border-amber-700/50 text-[10px] text-amber-600 dark:text-amber-400">
            <AlertTriangle data-icon="inline-start" />
            {counts.checks} check{counts.checks === 1 ? "" : "s"}
          </Badge>
        )}
        {settled && counts.accepted + counts.edited + counts.rejected + counts.undone > 0 && (
          <Badge variant="ghost" className="text-[10px] text-muted-foreground">
            done
          </Badge>
        )}
      </div>

      {(!settled || (undoable && onUndo)) && (
        <div className="flex items-center gap-3">
          {!settled && onReview && (
            <button
              type="button"
              onClick={onReview}
              className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
            >
              Review in working set
              <ArrowRight className="h-3 w-3" />
            </button>
          )}
          {undoable && onUndo && (
            <button
              type="button"
              onClick={onUndo}
              title="Restore each applied cell to its pre-draft text (a new, audited edit — nothing is deleted)"
              className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground hover:underline"
            >
              <Undo2 className="h-3 w-3" />
              Undo applied
            </button>
          )}
        </div>
      )}
    </div>
  )
}
