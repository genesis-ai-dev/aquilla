/**
 * ValidationQueueCard — staged cell.validate proposals as a per-item queue
 * (agent-complete design §3 tier 2, §6).
 *
 * Validation is testimony: "I, with this role, assert this translation is
 * right." The agent can PREPARE it — resolve heads, pin editEventIds, stage
 * the events — but each act of validation must be the human's own click.
 * Deliberately: one Confirm per row, no "validate all", and this tier is
 * exempt from any future auto-apply toggle.
 */

import { useState } from "react"
import { BadgeCheck, Check, Loader2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { applyStagedEvent, type ApplyContext } from "@/lib/agent/apply"
import type { AgentProposal, StagedEvent } from "@/lib/agent/protocol"

export interface ValidationQueueCardProps {
  proposal: AgentProposal
  applyContext: ApplyContext
  /** Post-apply hook (flush outbox + revalidate), same as ProposalCard's. */
  onApplied?: (eventIds: string[], cellIds: string[]) => void | Promise<void>
  /** Below this role the buttons render disabled (server still enforces). */
  canValidate: boolean
}

type RowState = "idle" | "applying" | "done" | "error"

export function ValidationQueueCard({ proposal, applyContext, onApplied, canValidate }: ValidationQueueCardProps) {
  const [rowState, setRowState] = useState<ReadonlyMap<number, RowState>>(new Map())
  const [rowError, setRowError] = useState<string | null>(null)

  const validations = proposal.events.filter((ev) => ev.kind === "cell.validate")
  const doneCount = [...rowState.values()].filter((s) => s === "done").length

  const confirm = async (ev: StagedEvent, idx: number) => {
    if (rowState.get(idx) === "applying" || rowState.get(idx) === "done") return
    setRowState((prev) => new Map(prev).set(idx, "applying"))
    setRowError(null)
    try {
      const eventId = await applyStagedEvent(ev, applyContext)
      setRowState((prev) => new Map(prev).set(idx, "done"))
      if (ev.cellId) await onApplied?.([eventId], [ev.cellId])
    } catch (err) {
      setRowState((prev) => new Map(prev).set(idx, "error"))
      setRowError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="my-1.5 flex flex-col rounded-lg border border-emerald-900/50 bg-emerald-950/20">
      <div className="flex items-center gap-1.5 border-b border-emerald-900/40 px-3 py-1.5 text-xs">
        <BadgeCheck className="h-3.5 w-3.5 text-emerald-500" />
        <span className="font-medium">
          {validations.length} validation{validations.length === 1 ? "" : "s"} prepared
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {doneCount}/{validations.length} confirmed
        </span>
      </div>

      {/* The tier-2 contract, stated where the decision happens. */}
      <p className="border-b border-emerald-900/30 px-3 py-1 text-[10px] text-muted-foreground">
        Validation is your testimony — confirm each line yourself. There is no confirm-all.
      </p>

      <div className="divide-y divide-emerald-900/20">
        {validations.map((ev, idx) => {
          const state = rowState.get(idx) ?? "idle"
          return (
            <div key={`${ev.cellId}-${idx}`} className="flex items-start gap-2 px-3 py-1.5 text-xs">
              <span className="w-16 shrink-0 pt-0.5 font-mono text-[10px] text-muted-foreground">
                {ev.display.canonicalRef ?? ev.cellId?.slice(0, 8) ?? "·"}
              </span>
              <span dir="auto" className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                {ev.display.before || "∅"}
              </span>
              {state === "done" ? (
                <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[10px] text-emerald-600 dark:text-emerald-500">
                  <Check className="h-3 w-3" /> validated
                </span>
              ) : (
                <AppTooltip
                  content={canValidate ? undefined : "Your role can't validate in this project"}
                  disabled={canValidate}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-5 shrink-0 px-1.5 text-[10px]"
                    disabled={!canValidate || state === "applying"}
                    onClick={() => void confirm(ev, idx)}
                    aria-label={`Validate ${ev.display.canonicalRef ?? ev.cellId ?? "cell"}`}
                  >
                  {state === "applying" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check data-icon="inline-start" />
                  )}
                  Validate
                </Button>
                </AppTooltip>
              )}
              {state === "error" && <X className="h-3 w-3 shrink-0 text-destructive" aria-label="Failed" />}
            </div>
          )
        })}
      </div>

      {rowError && <p className="px-3 py-1 text-[10px] text-destructive">{rowError}</p>}
    </div>
  )
}
