/**
 * ChangesetCard.tsx — a PlanImport changeset staged via changeset-bridge
 * (AQU-AGENT §2 plan_import / §4 changeset.staged), awaiting human approval
 * at the existing `/approve/:changesetId` surface. Unlike ProposalCard this
 * is NOT applied from chat — the "Review & approve" link is the only action,
 * opened in a new tab so the run stays on screen.
 *
 * mem-M5 liveness: while the card is mounted and the changeset is still
 * pending, it polls `GET /api/v2/changesets/:id/approval` (same route/shape
 * as src/pages/ApproveChangeset/ApproveChangeset.tsx) every ~5s so the card
 * reflects an approval/rejection made from that page without a page reload.
 * Polling stops once a terminal status lands or the card unmounts.
 */

import { useEffect, useState } from "react"
import { ExternalLink, FileDiff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { AUTH_BASE } from "@/lib/frontier/auth"
import type { ChangesetItem } from "@/lib/agent/run-state"

const POLL_INTERVAL_MS = 5000

/** Matches ApprovalData['status'] in ApproveChangeset.tsx — a free-form
 *  server string, but these three are the only terminal values it defines. */
const TERMINAL_STATUSES = new Set(["approved", "committed", "discarded"])

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

function statusLabel(status: string): string {
  switch (status) {
    case "approved":
      return "Approved"
    case "committed":
      return "Committed"
    case "discarded":
      return "Discarded"
    default:
      return "Pending review"
  }
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "approved" || status === "committed") return "default"
  if (status === "discarded") return "outline"
  return "secondary"
}

export function ChangesetCard({ item }: { item: ChangesetItem }) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [status, setStatus] = useState("staged")

  useEffect(() => {
    if (!jwt || isTerminal(status)) return
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`${AUTH_BASE}/api/v2/changesets/${item.changesetId}/approval`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
        if (cancelled || !res.ok) return
        const data = (await res.json()) as { status?: string }
        if (!cancelled && data.status) setStatus(data.status)
      } catch {
        // Transient network error — the next tick retries; no need to surface it here.
      }
    }

    void poll()
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [jwt, item.changesetId, status])

  const terminal = isTerminal(status)

  return (
    <div
      data-frame-type="changeset.staged"
      data-changeset-status={status}
      className="space-y-1.5 rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-sky-500" />
        <span className="min-w-0 flex-1 truncate font-medium">{item.summary}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {item.cellCount} {item.cellCount === 1 ? "cell" : "cells"}
        </Badge>
        <Badge variant={statusVariant(status)} className="px-1.5 py-0 text-[10px]">
          {statusLabel(status)}
        </Badge>
      </div>
      {terminal ? (
        <span className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-muted-foreground">
          Review & approve
        </span>
      ) : (
        <a
          href={item.approvalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          Review & approve
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  )
}
