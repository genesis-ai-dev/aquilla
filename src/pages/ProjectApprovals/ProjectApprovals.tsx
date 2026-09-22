/**
 * ProjectApprovals.tsx — the in-app approvals queue (AQU-841).
 *
 * Before this page the only way to act on an EXTERNAL agent's staged plan was
 * the per-changeset URL the agent handed back (`/approve/:changesetId`): review
 * meant opening one link, acting, going back for the next. The in-conversation
 * cards never covered that case, because a Cowork/Codex agent produces no
 * in-app conversation to render them in.
 *
 * `listProjectChangesets` (COMMAND-REGISTRY-P1 §3.3) has existed for exactly
 * this surface and had no consumer; this page is it. One project-scoped list,
 * approve/reject inline, and a bulk approve for the plans that may be
 * bulk-approved.
 *
 * Two rules the queue does NOT get to relax:
 * - **The digest always comes from the approval GET**, per changeset, at the
 *   moment of approving — never the one the list row carried. What is approved
 *   stays provably what the server staged, exactly as on /approve/:id.
 * - **Testimony is never bulk-approved** (COMMAND-REGISTRY §5). Rows that
 *   assert quality are excluded from the bulk action and say so; they are
 *   reviewed one at a time through the full page.
 */

import { useCallback, useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { AlertCircle, Layers, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { ChangesetHeldNotice } from "@/components/agent/ChangesetHeldNotice"
import {
  approveChangeset,
  fetchChangesetApproval,
  listProjectChangesets,
  rejectChangeset,
  type ChangesetListItem,
} from "@/lib/agent/changeset-api"
import {
  changesetStatusBadgeClass,
  changesetStatusLabel,
  changesetStatusVariant,
  humanizeSummaryKey,
  messageForChangesetError,
  requiresPerItemConfirmation,
  summaryFactEntries,
} from "@/lib/agent/changeset-review"
import { cn } from "@/lib/utils"

/**
 * A queue shows the work, not a sample: pass an explicit `limit` so the server
 * pages the full ranked list instead of applying its 3-row default view. 50 is
 * the worker's own `LIST_CHANGESETS_MAX` scan window (P1 §3.3) — asking for
 * more cannot return more, and anything beyond it still comes back as
 * `heldCount`, which the held notice explains.
 */
const QUEUE_LIMIT = 50

type LoadState =
  | { phase: "loading" }
  | { phase: "loaded"; rows: ChangesetListItem[]; heldCount: number }
  | { phase: "error"; message: string }

/** Per-row outcome. Rows keep their own state so one failure never blanks the
 *  queue — the other rows stay actionable. */
type RowState =
  | { phase: "idle" }
  | { phase: "working" }
  | { phase: "approved" }
  | { phase: "rejected" }
  | { phase: "error"; message: string }

export function ProjectApprovals() {
  const t = useT()
  const { id: projectId } = useParams<{ id: string }>()
  const { session, loading: sessionLoading } = useFrontierSession()
  const [load, setLoad] = useState<LoadState>({ phase: "loading" })
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({})
  const [bulk, setBulk] = useState<{ working: boolean; result: string | null }>({
    working: false,
    result: null,
  })

  const jwt = session?.jwt ?? null

  const refresh = useCallback(async () => {
    if (!projectId || !jwt) return
    setLoad({ phase: "loading" })
    try {
      const page = await listProjectChangesets(jwt, projectId, {
        status: "staged",
        limit: QUEUE_LIMIT,
      })
      setLoad({ phase: "loaded", rows: page.changesets, heldCount: page.heldCount })
      setRowStates({})
    } catch (err) {
      setLoad({ phase: "error", message: messageForChangesetError(err) })
    }
  }, [projectId, jwt])

  useEffect(() => {
    if (sessionLoading || !jwt) return
    void refresh()
  }, [sessionLoading, jwt, refresh])

  /** Approve one plan. The digest is fetched fresh here rather than read off
   *  the list row — see the header note. Returns whether it landed, so the
   *  bulk action can tally without re-reading component state. */
  const approveOne = useCallback(
    async (changesetId: string): Promise<boolean> => {
      if (!jwt) return false
      setRowStates((prev) => ({ ...prev, [changesetId]: { phase: "working" } }))
      try {
        const approval = await fetchChangesetApproval(jwt, changesetId)
        await approveChangeset(jwt, changesetId, approval.digest)
        setRowStates((prev) => ({ ...prev, [changesetId]: { phase: "approved" } }))
        return true
      } catch (err) {
        setRowStates((prev) => ({
          ...prev,
          [changesetId]: { phase: "error", message: messageForChangesetError(err) },
        }))
        return false
      }
    },
    [jwt],
  )

  const rejectOne = useCallback(
    async (changesetId: string) => {
      if (!jwt) return
      setRowStates((prev) => ({ ...prev, [changesetId]: { phase: "working" } }))
      try {
        await rejectChangeset(jwt, changesetId)
        setRowStates((prev) => ({ ...prev, [changesetId]: { phase: "rejected" } }))
      } catch (err) {
        setRowStates((prev) => ({
          ...prev,
          [changesetId]: { phase: "error", message: messageForChangesetError(err) },
        }))
      }
    },
    [jwt],
  )

  const rows = load.phase === "loaded" ? load.rows : []
  // Sequential, not Promise.all: each approve is a two-call round trip against
  // the same project, and a burst of them is exactly the load the cap in §3.3
  // exists to avoid. A queue of 50 is a background action, not a race.
  const bulkTargets = rows.filter(
    (row) =>
      !requiresPerItemConfirmation(row.summary) &&
      (rowStates[row.id]?.phase ?? "idle") === "idle",
  )
  const hasPerItemRows = rows.some((row) => requiresPerItemConfirmation(row.summary))

  async function approveAll() {
    setBulk({ working: true, result: null })
    let approved = 0
    for (const row of bulkTargets) {
      if (await approveOne(row.id)) approved += 1
    }
    setBulk({
      working: false,
      result: t("agent.approvals.approveAllResult", {
        approved,
        total: bulkTargets.length,
      }),
    })
  }

  const isSignedOut = !sessionLoading && !jwt

  return (
    <div className="mx-auto w-full max-w-3xl p-4">
      <Card>
        <CardHeader className="space-y-1">
          <CardTitle className="text-lg">{t("agent.approvals.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">{t("agent.approvals.subtitle")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {sessionLoading ? (
            <Spinner className="text-muted-foreground" />
          ) : isSignedOut ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("agent.approvals.signInNotice")}
              </p>
              <a href={`/login?next=${encodeURIComponent(window.location.pathname)}`}>
                <Button className="w-full">{t("auth.login.submitDefault")}</Button>
              </a>
            </div>
          ) : load.phase === "loading" ? (
            <div className="flex items-center gap-2 py-1">
              <Spinner className="text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("agent.approvals.loading")}</p>
            </div>
          ) : load.phase === "error" ? (
            <div className="flex items-start gap-2 text-destructive">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
              <p className="text-sm">{load.message}</p>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={bulk.working || bulkTargets.length === 0}
                  onClick={() => void approveAll()}
                >
                  {bulk.working ? <Spinner data-icon="inline-start" /> : null}
                  {t("agent.approvals.approveAll", { count: bulkTargets.length })}
                </Button>
                <Button variant="outline" disabled={bulk.working} onClick={() => void refresh()}>
                  <RefreshCw data-icon="inline-start" className="h-3.5 w-3.5" />
                  {t("agent.approvals.refresh")}
                </Button>
                {bulk.result && (
                  <p className="text-xs text-muted-foreground">{bulk.result}</p>
                )}
              </div>

              {hasPerItemRows && (
                <p className="flex items-start gap-1.5 rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  <Layers className="mt-px h-3.5 w-3.5 shrink-0" />
                  {t("agent.approvals.perItemNotice")}
                </p>
              )}

              {load.rows.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  {t("agent.approvals.empty")}
                </p>
              ) : (
                <ul className="space-y-2" data-testid="approvals-queue">
                  {load.rows.map((row) => (
                    <ApprovalRow
                      key={row.id}
                      row={row}
                      state={rowStates[row.id] ?? { phase: "idle" }}
                      disabled={bulk.working}
                      onApprove={() => void approveOne(row.id)}
                      onReject={() => void rejectOne(row.id)}
                    />
                  ))}
                </ul>
              )}

              <ChangesetHeldNotice heldCount={load.heldCount} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ApprovalRow({
  row,
  state,
  disabled,
  onApprove,
  onReject,
}: {
  row: ChangesetListItem
  state: RowState
  disabled: boolean
  onApprove: () => void
  onReject: () => void
}) {
  const { locale, t } = useI18n()
  const perItem = requiresPerItemConfirmation(row.summary)
  const facts = summaryFactEntries(row.summary)
  const warnings = row.summary.warnings ?? []
  const settled = state.phase === "approved" || state.phase === "rejected"
  const busy = state.phase === "working" || disabled

  return (
    <li
      data-changeset-id={row.id}
      data-row-state={state.phase}
      className="space-y-1.5 rounded-lg border px-3 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {row.id}
        </span>
        {perItem && (
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {t("agent.approvals.perItemBadge")}
          </Badge>
        )}
        <Badge
          variant={changesetStatusVariant(row.status, state.phase === "approved")}
          className={cn("px-1.5 py-0 text-[10px]", changesetStatusBadgeClass(row.status))}
        >
          {changesetStatusLabel(t, row.status, state.phase === "approved")}
        </Badge>
      </div>

      {facts.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t("agent.changeset.noChangesSummarized")}
        </p>
      ) : (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {facts.map(([key, value]) => (
            <li key={key}>
              {humanizeSummaryKey(key)}:{" "}
              <span className="font-medium text-foreground">{String(value)}</span>
            </li>
          ))}
        </ul>
      )}

      {warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-4 text-xs text-amber-700 dark:text-amber-400">
          {warnings.map((w, i) => (
            <li key={i}>{w.message}</li>
          ))}
        </ul>
      )}

      {state.phase === "approved" && (
        <p className="text-[11px] text-muted-foreground">
          {t("agent.changeset.approvedNotice")}
        </p>
      )}
      {state.phase === "rejected" && (
        <p className="text-[11px] text-muted-foreground">
          {t("agent.changeset.rejectedFull")}
        </p>
      )}
      {state.phase === "error" && (
        <p className="text-[11px] text-destructive">{state.message}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {!settled && (
          <>
            <Button
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={onApprove}
            >
              {state.phase === "working" ? <Spinner data-icon="inline-start" /> : null}
              {t("agent.approve")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={onReject}
            >
              {t("agent.reject")}
            </Button>
          </>
        )}
        <Link
          to={`/approve/${row.id}`}
          className="text-[11px] font-medium text-sky-600 hover:underline dark:text-sky-400"
        >
          {t("agent.approvals.openFullReview")}
        </Link>
        <span className="ms-auto text-[11px] text-muted-foreground">
          <DateTooltip value={row.expiresAt} label={t("common.date.expires")}>
            {t("common.expiresOn", {
              date: fmtShortCalendarDate(row.expiresAt, undefined, locale),
            })}
          </DateTooltip>
        </span>
      </div>
    </li>
  )
}
