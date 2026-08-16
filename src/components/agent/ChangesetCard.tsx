/**
 * ChangesetCard.tsx — in-conversation review surface for a staged agent
 * changeset (changeset.staged frame). Shows a sample of the actual per-cell
 * changes and lets the reviewer Approve/Reject right here — the full-page
 * `/approve/:changesetId` surface stays available (new tab) for auditing the
 * complete plan, but leaving the conversation is no longer required.
 *
 * Approval calls the same auth-worker endpoints as the approval page, with the
 * digest taken from the GET payload — what's approved is provably what the
 * server staged, never something the frame carried.
 *
 * mem-M5 liveness: while the card is mounted and the changeset is still
 * pending, it polls `GET /api/v2/changesets/:id/approval` every ~5s so the
 * card reflects an approval/rejection made elsewhere without a page reload.
 * Polling stops once a terminal status lands or the card unmounts.
 */

import { useEffect, useState } from "react"
import { ExternalLink, FileDiff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { AUTH_BASE } from "@/lib/frontier/auth"
import type { ChangesetItem } from "@/lib/agent/run-state"
import {
  ChangeList,
  ImportPreviewView,
  type ChangesetChanges,
  type ChangesetImportPreview,
} from "@/components/changesets/ChangeList"

const POLL_INTERVAL_MS = 5000

/** In-chat sample size — enough to sanity-check the writing, not an audit.
 *  The "View full details" link carries the reviewer to the complete list. */
const SAMPLE_CHANGES = 3

/** Server statuses after which the changeset can no longer be acted on. */
const TERMINAL_STATUSES = new Set(["committed", "discarded", "stale", "expired"])

interface ApprovalPayload {
  status: string
  digest: string
  changes?: ChangesetChanges
  importPreview?: ChangesetImportPreview
}

function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.has(status)
}

function statusLabel(status: string, approvedLocally: boolean): string {
  switch (status) {
    case "committed":
      return "Committed"
    case "discarded":
      return "Discarded"
    case "stale":
      return "Stale"
    case "expired":
      return "Expired"
    default:
      return approvedLocally ? "Approved" : "Pending review"
  }
}

function statusVariant(status: string, approvedLocally: boolean): "default" | "secondary" | "outline" {
  if (status === "committed" || approvedLocally) return "default"
  if (isTerminal(status)) return "outline"
  return "secondary"
}

export function ChangesetCard({ item }: { item: ChangesetItem }) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [approval, setApproval] = useState<ApprovalPayload | null>(null)
  const [status, setStatus] = useState("staged")
  // "Approved" isn't a server status (it stays `staged` until the agent
  // commits), so a successful approve is remembered locally.
  const [approvedLocally, setApprovedLocally] = useState(false)
  const [working, setWorking] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!jwt || isTerminal(status)) return
    let cancelled = false

    const poll = async () => {
      try {
        const res = await fetch(`${AUTH_BASE}/api/v2/changesets/${item.changesetId}/approval`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
        if (cancelled || !res.ok) return
        const data = (await res.json()) as ApprovalPayload
        if (cancelled) return
        setApproval(data)
        if (data.status) setStatus(data.status)
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

  async function act(kind: "approve" | "reject") {
    if (!jwt || !approval) return
    setWorking(true)
    setActionError(null)
    try {
      const res = await fetch(
        `${AUTH_BASE}/api/v2/changesets/${item.changesetId}/${kind}`,
        kind === "approve"
          ? {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
              body: JSON.stringify({ digest: approval.digest }),
            }
          : { method: "POST", headers: { Authorization: `Bearer ${jwt}` } },
      )
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null
        setActionError(body?.error?.message ?? `Something went wrong (${res.status}).`)
        return
      }
      if (kind === "approve") setApprovedLocally(true)
      else setStatus("discarded")
    } catch {
      setActionError("Couldn't reach the server. Check your connection and try again.")
    } finally {
      setWorking(false)
    }
  }

  const actionable = status === "staged" && !approvedLocally && jwt !== null && approval !== null

  return (
    <div
      data-frame-type="changeset.staged"
      data-changeset-status={approvedLocally && status === "staged" ? "approved" : status}
      className="space-y-1.5 rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-sky-500" />
        <span className="min-w-0 flex-1 truncate font-medium">{item.summary}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {item.cellCount} {item.cellCount === 1 ? "cell" : "cells"}
        </Badge>
        <Badge variant={statusVariant(status, approvedLocally)} className="px-1.5 py-0 text-[10px]">
          {statusLabel(status, approvedLocally)}
        </Badge>
      </div>

      {approval?.changes && approval.changes.items.length > 0 && (
        <ChangeList changes={approval.changes} maxItems={SAMPLE_CHANGES} />
      )}
      {approval?.importPreview && (
        <ImportPreviewView
          preview={{
            ...approval.importPreview,
            sampleCells: approval.importPreview.sampleCells.slice(0, SAMPLE_CHANGES),
          }}
        />
      )}

      {approvedLocally && status === "staged" && (
        <p className="text-[11px] text-muted-foreground">
          Approved — the agent can now commit these changes.
        </p>
      )}

      {actionError && <p className="text-[11px] text-destructive">{actionError}</p>}

      <div className="flex items-center gap-2">
        {actionable && (
          <>
            <Button size="sm" className="h-6 px-2 text-[11px]" disabled={working} onClick={() => void act("approve")}>
              {working ? <Spinner data-icon="inline-start" /> : null}
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={working}
              onClick={() => void act("reject")}
            >
              Reject
            </Button>
          </>
        )}
        <a
          href={item.approvalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          View full details
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  )
}
