/**
 * LiveChangesetCard.tsx — live review card for a freshly staged changeset
 * (AQU-926, docs/COMMAND-REGISTRY.md §5). Rendered by ChangesetCard when the
 * changeset.staged frame carries the additive `digest` field.
 *
 * Unlike the legacy flow (approve here, the AGENT commits), this card owns the
 * whole gate: **Approve & apply** mints the one-time confirmation on
 * auth-worker, then commits through the sync-worker session route — the same
 * changeset engine external agents use — and renders the execution receipt.
 * Reject discards. Testimony-tier items (cell.validate & friends) each need an
 * individual confirmation checkbox before Approve & apply enables — never bulk
 * (registry KIND_TIER / COMMAND-REGISTRY §5).
 *
 * The digest posted to approve is ALWAYS the one the approval GET returned —
 * the frame's digest only selects this rendering; it never gets approved.
 */

import { useEffect, useMemo, useState } from "react"
import { AlertCircle, Check, CheckCheck, ExternalLink, FileDiff, RefreshCw, UserRound } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { formatDateTime } from "@/lib/i18n/format"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import type { ChangesetItem } from "@/lib/agent/run-state"
import {
  approveChangeset,
  ChangesetApiError,
  commitChangeset,
  fetchChangesetApproval,
  rejectChangeset,
  type ChangesetApproval,
  type ChangesetCommitReceipt,
} from "@/lib/agent/changeset-api"
import {
  changesetStatusBadgeClass,
  changesetStatusLabel,
  changesetStatusVariant,
  isTerminalChangesetStatus,
  testimonyEntriesFor,
} from "@/lib/agent/changeset-review"
import { ChangeList, ImportPreviewView } from "@/components/changesets/ChangeList"

/** Diff rows shown inline before the "…and N more changes." notice — a
 *  reviewable sample, not an audit (the full-details page has everything). */
const MAX_DIFF_ROWS = 20

type LoadState =
  | { phase: "loading" }
  | { phase: "loaded"; data: ChangesetApproval }
  | { phase: "error"; message: string }

export function LiveChangesetCard({
  item,
  onApplied,
}: {
  item: ChangesetItem
  /** Post-commit flush + revalidate seam (same shape as ProposalCard's). */
  onApplied?: (eventIds: string[], cellIds: string[]) => void | Promise<void>
}) {
  const { locale, t } = useI18n()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [load, setLoad] = useState<LoadState>({ phase: "loading" })
  /** Server status; starts from the frame's implicit 'staged'. */
  const [status, setStatus] = useState("staged")
  /** True from the Approve & apply click until commit settles. */
  const [committing, setCommitting] = useState(false)
  const [receipt, setReceipt] = useState<ChangesetCommitReceipt | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /** Drift errors (digest mismatch / stale / expired / not-staged) offer a
   *  Refresh that refetches the approval payload. */
  const [offerRefresh, setOfferRefresh] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  /** Testimony entry keys the reviewer has individually confirmed. */
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())

  // Race-guarded load (plain fetch + useState — no react-query, per AD-3).
  useEffect(() => {
    if (!jwt) return
    let cancelled = false
    setLoad({ phase: "loading" })
    fetchChangesetApproval(jwt, item.changesetId)
      .then((data) => {
        if (cancelled) return
        setLoad({ phase: "loaded", data })
        if (data.status) setStatus(data.status)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoad({
          phase: "error",
          message:
            err instanceof ChangesetApiError
              ? err.message
              : "Couldn't reach the server. Check your connection and try again.",
        })
      })
    return () => {
      cancelled = true
    }
  }, [jwt, item.changesetId, reloadNonce])

  const approval = load.phase === "loaded" ? load.data : null
  const testimony = useMemo(() => testimonyEntriesFor(item, approval), [item, approval])
  const allConfirmed = testimony.every((entry) => confirmed.has(entry.key))

  // Routing (COMMAND-REGISTRY-P1 §2.2): the payload names an assignee by id,
  // so the roster supplies the human name. A null projectId makes the hook
  // inert, so an UNassigned card costs no request; when the roster is
  // unavailable (org policy hides it, or it hasn't landed yet) the id is a
  // truthful fallback.
  const assignedToUserId = approval?.assignedToUserId ?? null
  const { members } = useProjectMembers(assignedToUserId && approval ? approval.projectId : null)
  const assignee = useMemo(() => {
    if (!assignedToUserId) return null
    return members.find((m) => String(m.userId) === assignedToUserId)?.username ?? assignedToUserId
  }, [assignedToUserId, members])

  const refresh = () => {
    setActionError(null)
    setOfferRefresh(false)
    setReloadNonce((n) => n + 1)
  }

  async function approveAndApply() {
    if (!jwt || !approval || committing) return
    setCommitting(true)
    setActionError(null)
    setOfferRefresh(false)
    try {
      await approveChangeset(jwt, item.changesetId, approval.digest)
      const committed = await commitChangeset(jwt, approval.projectId, item.changesetId)
      setStatus(committed.status)
      setReceipt(committed.receipt)
      const eventIds = committed.receipt?.eventIds ?? []
      const cellIds = [...new Set((approval.changes?.items ?? []).map((c) => c.cellId))]
      try {
        await onApplied?.(eventIds, cellIds)
      } catch {
        // Revalidation is best-effort — the project DO's event.applied
        // broadcast refreshes connected reads regardless.
      }
    } catch (err) {
      if (err instanceof ChangesetApiError) {
        setActionError(err.message)
        // 409 (digest mismatch / stale / not-staged) and 428 (confirmation
        // drift) mean the staged plan or its state moved — refetch to review.
        setOfferRefresh(err.status === 409 || err.status === 428)
        if (err.code === "plan_stale") setStatus("stale")
      } else {
        setActionError("Couldn't reach the server. Check your connection and try again.")
      }
    } finally {
      setCommitting(false)
    }
  }

  async function reject() {
    if (!jwt || committing) return
    setCommitting(true)
    setActionError(null)
    try {
      await rejectChangeset(jwt, item.changesetId)
      setStatus("discarded")
    } catch (err) {
      if (err instanceof ChangesetApiError) {
        setActionError(err.message)
        setOfferRefresh(err.status === 409)
      } else {
        setActionError("Couldn't reach the server. Check your connection and try again.")
      }
    } finally {
      setCommitting(false)
    }
  }

  const displayStatus = committing ? "committing" : status
  const loading = load.phase === "loading"
  const loadErrorMessage = load.phase === "error" ? load.message : null
  // Buttons stay MOUNTED while committing (spinner + "Applying…" is the
  // progress surface); they only disable. They unmount on a terminal status.
  const reviewable = status === "staged" && jwt !== null && approval !== null
  const appliedCount = typeof receipt?.appliedCount === "number" ? receipt.appliedCount : null
  const showReceipt = status === "committed" && appliedCount !== null
  const staleCount = typeof receipt?.staleCount === "number" ? receipt.staleCount : 0
  // Loaded into a non-actionable, non-terminal state (e.g. a crash left it
  // 'committing' server-side) — let the reviewer re-check.
  const showStateRefresh =
    approval !== null && !committing && !isTerminalChangesetStatus(status) && status !== "staged"
  // Superseded is a GOOD terminal outcome (P1 §1) — the work already exists —
  // so it earns an explanation rather than the error treatment `stale` gets.
  const showSupersededNotice = status === "superseded"

  return (
    <div
      data-frame-type="changeset.staged"
      data-changeset-status={displayStatus}
      aria-busy={committing || undefined}
      className="space-y-1.5 rounded-lg border border-sky-900/60 bg-sky-950/30 px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-sky-500" />
        <span className="min-w-0 flex-1 truncate font-medium">{item.summary}</span>
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
          {t("common.cellCount", { count: item.cellCount })}
        </Badge>
        {(item.kinds ?? []).map((kind) => (
          <Badge key={kind} variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
            {kind}
          </Badge>
        ))}
        <Badge
          variant={changesetStatusVariant(displayStatus, false)}
          className={cn("px-1.5 py-0 text-[10px]", changesetStatusBadgeClass(displayStatus))}
        >
          {changesetStatusLabel(t, displayStatus, false)}
        </Badge>
      </div>

      {assignee !== null && (
        <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
          <UserRound className="mt-px h-3 w-3 shrink-0" />
          <span>
            <span className="font-medium text-foreground">
              {t("agent.changeset.routedTo", { user: assignee })}
            </span>{" "}
            {t("agent.changeset.routedToNotice")}
          </span>
        </p>
      )}

      {showSupersededNotice && (
        <p className="flex items-start gap-1 text-[11px] text-emerald-700 dark:text-emerald-400">
          <CheckCheck className="mt-px h-3 w-3 shrink-0" />
          {t("agent.changeset.supersededNotice")}
        </p>
      )}

      {loading && (
        <div className="flex items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground">
          <Spinner className="size-3" />
          {t("agent.changeset.loading")}
        </div>
      )}

      {loadErrorMessage !== null && (
        <div className="space-y-1">
          <p className="flex items-start gap-1 text-[11px] text-destructive">
            <AlertCircle className="mt-px h-3 w-3 shrink-0" />
            {loadErrorMessage}
          </p>
          <RefreshButton onClick={refresh} label={t("common.refresh")} />
        </div>
      )}

      {approval?.changes && approval.changes.items.length > 0 && (
        <ChangeList changes={approval.changes} maxItems={MAX_DIFF_ROWS} />
      )}
      {approval?.importPreview && <ImportPreviewView preview={approval.importPreview} />}

      {reviewable && testimony.length > 0 && (
        <div className="space-y-1 rounded-md border border-amber-300/50 bg-amber-50/50 p-2 dark:bg-amber-950/20">
          {/* Same testimony sentence the ValidationQueueCard uses — one
              vocabulary for the per-item human gate. */}
          <p className="text-[11px] font-medium">{t("agent.validation.testimonyNotice")}</p>
          {testimony.map((entry) => (
            // Label wrap names the checkbox and makes the text a click target
            // (AssignWork idiom — Base UI links the label via aria-labelledby).
            <label key={entry.key} className="flex items-center gap-1.5 text-[11px]">
              <Checkbox
                disabled={committing}
                checked={confirmed.has(entry.key)}
                onCheckedChange={(checked) => {
                  setConfirmed((prev) => {
                    const next = new Set(prev)
                    if (checked) next.add(entry.key)
                    else next.delete(entry.key)
                    return next
                  })
                }}
              />
              <span className="font-mono">{entry.label}</span>
            </label>
          ))}
        </div>
      )}

      {showReceipt && (
        <p className="flex items-center gap-1 text-[11px] font-medium text-emerald-600">
          <Check className="h-3 w-3 shrink-0" />
          {t("agent.changeset.receiptApplied", { count: appliedCount ?? 0 })}
          {staleCount > 0 && (
            <span className="font-normal text-muted-foreground">
              {t("agent.changeset.receiptStale", { count: staleCount })}
            </span>
          )}
        </p>
      )}

      {actionError && (
        <div className="space-y-1">
          <p className="flex items-start gap-1 text-[11px] text-destructive">
            <AlertCircle className="mt-px h-3 w-3 shrink-0" />
            {actionError}
          </p>
          {offerRefresh && <RefreshButton onClick={refresh} label={t("common.refresh")} />}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {reviewable && (
          <>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={committing || !allConfirmed}
              onClick={() => void approveAndApply()}
            >
              {committing ? <Spinner data-icon="inline-start" /> : null}
              {committing
                ? t("autopilot.proposal.applying")
                : t("agent.changeset.approveAndApply")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={committing}
              onClick={() => void reject()}
            >
              {t("agent.reject")}
            </Button>
          </>
        )}
        {reviewable && approval && (
          <span className="text-[10px] text-muted-foreground">
            {t("common.expiresOn", { date: formatDateTime(approval.expiresAt, locale) })}
          </span>
        )}
        {showStateRefresh && <RefreshButton onClick={refresh} label={t("common.refresh")} />}
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

function RefreshButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button size="sm" variant="outline" className="h-6 gap-1 px-2 text-[11px]" onClick={onClick}>
      <RefreshCw className="h-3 w-3" />
      {label}
    </Button>
  )
}
