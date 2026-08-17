/**
 * ChangesetCard.tsx — in-conversation review surface for a staged agent
 * changeset (changeset.staged frame).
 *
 * Two renderings, feature-detected on the frame (AQU-926,
 * docs/COMMAND-REGISTRY.md §5):
 * - Frames WITHOUT the additive `digest` field (older server builds, legacy
 *   persisted PlanImport timelines) render the legacy card below EXACTLY as
 *   before: sample changes, Approve/Reject (the agent commits afterwards),
 *   mem-M5 status polling.
 * - Frames WITH `digest` (fresh AQU-926 stagings) render LiveChangesetCard:
 *   Approve & apply commits server-side from the card itself (approve →
 *   sync-worker commit → receipt), with testimony gating.
 *
 * Approval always posts the digest taken from the approval GET payload — what
 * is approved is provably what the server staged, never what a frame carried.
 */

import { useEffect, useState } from "react"
import { ExternalLink, FileDiff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { ChangesetItem } from "@/lib/agent/run-state"
import {
  approveChangeset,
  ChangesetApiError,
  fetchChangesetApproval,
  rejectChangeset,
  type ChangesetApproval,
} from "@/lib/agent/changeset-api"
import {
  changesetStatusLabel,
  changesetStatusVariant,
  isTerminalChangesetStatus,
} from "@/lib/agent/changeset-review"
import { ChangeList, ImportPreviewView } from "@/components/changesets/ChangeList"
import { LiveChangesetCard } from "./LiveChangesetCard"

const POLL_INTERVAL_MS = 5000

/** In-chat sample size — enough to sanity-check the writing, not an audit.
 *  The "View full details" link carries the reviewer to the complete list. */
const SAMPLE_CHANGES = 3

export function ChangesetCard({
  item,
  onApplied,
}: {
  item: ChangesetItem
  /** Post-commit hook: flush outbox + revalidate the touched cells (same seam
   *  ProposalCard uses). Only the live variant commits, so only it calls this. */
  onApplied?: (eventIds: string[], cellIds: string[]) => void | Promise<void>
}) {
  // Feature-detect the live review flow on the additive digest field — a frame
  // without it predates AQU-926 and must render exactly as before.
  if (item.digest !== undefined) {
    return <LiveChangesetCard item={item} onApplied={onApplied} />
  }
  return <LegacyChangesetCard item={item} />
}

/**
 * The pre-AQU-926 card, unchanged in behavior: the AGENT owns the commit, so
 * a successful approve is remembered locally ("the agent can now commit") and
 * mem-M5 polling keeps the status honest while the card is mounted.
 */
function LegacyChangesetCard({ item }: { item: ChangesetItem }) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [approval, setApproval] = useState<ChangesetApproval | null>(null)
  const [status, setStatus] = useState("staged")
  // "Approved" isn't a server status (it stays `staged` until the agent
  // commits), so a successful approve is remembered locally.
  const [approvedLocally, setApprovedLocally] = useState(false)
  const [working, setWorking] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!jwt || isTerminalChangesetStatus(status)) return
    let cancelled = false

    const poll = async () => {
      try {
        const data = await fetchChangesetApproval(jwt, item.changesetId)
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
      if (kind === "approve") {
        await approveChangeset(jwt, item.changesetId, approval.digest)
        setApprovedLocally(true)
      } else {
        await rejectChangeset(jwt, item.changesetId)
        setStatus("discarded")
      }
    } catch (err) {
      setActionError(
        err instanceof ChangesetApiError
          ? err.message
          : "Couldn't reach the server. Check your connection and try again.",
      )
    } finally {
      setWorking(false)
    }
  }

  const staged = status === "staged"
  const actionable = staged && !approvedLocally && jwt !== null && approval !== null
  // "Approved" awaiting the agent's commit — shown while the server still says staged.
  const approvedAwaitingCommit = approvedLocally && staged

  return (
    <div
      data-frame-type="changeset.staged"
      data-changeset-status={approvedAwaitingCommit ? "approved" : status}
      className="space-y-1.5 rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-sky-500" />
        <span className="min-w-0 flex-1 truncate font-medium">{item.summary}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {t("common.cellCount", { count: item.cellCount })}
        </Badge>
        <Badge variant={changesetStatusVariant(status, approvedLocally)} className="px-1.5 py-0 text-[10px]">
          {changesetStatusLabel(status, approvedLocally)}
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

      {approvedAwaitingCommit && (
        <p className="text-[11px] text-muted-foreground">
          {t("agent.changeset.approvedNotice")}
        </p>
      )}

      {actionError && <p className="text-[11px] text-destructive">{actionError}</p>}

      <div className="flex items-center gap-2">
        {actionable && (
          <>
            <Button size="sm" className="h-6 px-2 text-[11px]" disabled={working} onClick={() => void act("approve")}>
              {working ? <Spinner data-icon="inline-start" /> : null}
              {t("agent.approve")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={working}
              onClick={() => void act("reject")}
            >
              {t("agent.reject")}
            </Button>
          </>
        )}
        <a
          href={item.approvalUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-fit items-center gap-1 text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          {t("agent.changeset.viewFullDetails")}
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  )
}
