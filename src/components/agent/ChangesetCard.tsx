/**
 * ChangesetCard.tsx — a PlanImport changeset staged via changeset-bridge
 * (AQU-AGENT §2 plan_import / §4 changeset.staged), awaiting human approval
 * at the existing `/approve/:changesetId` surface. Unlike ProposalCard this
 * is NOT applied from chat — the "Review & approve" link is the only action,
 * opened in a new tab so the run stays on screen.
 */

import { ExternalLink, FileDiff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import type { ChangesetItem } from "@/lib/agent/run-state"

export function ChangesetCard({ item }: { item: ChangesetItem }) {
  return (
    <div
      data-frame-type="changeset.staged"
      className="space-y-1.5 rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-sky-500" />
        <span className="min-w-0 flex-1 truncate font-medium">{item.summary}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {item.cellCount} {item.cellCount === 1 ? "cell" : "cells"}
        </Badge>
      </div>
      <a
        href={item.approvalUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
      >
        Review & approve
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  )
}
