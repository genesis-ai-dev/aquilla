import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { getWorkload, unassignAssignment, type OrgWorkloadAssignment } from "@/lib/sync/assignments"
import { Section } from "@/components/ui/page"
import { Badge } from "@/components/ui/badge"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { UserChip } from "@/components/UserChip"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { ProjectDeadlineStatuses } from "@/components/ProjectStatus"
import { deadlineStatus } from "@/lib/frontier/portfolio-metrics"
import { fmtDeadlineDate, fmtShortCalendarDate } from "@/lib/format-date"
import { progressPercent } from "@/lib/progress/progress-percent"
import { PROGRESS_BG } from "@/lib/progress/progress-palette"
import { UserError } from "@/lib/errors/user-error"
import {
  compareValidationBehind,
  isValidationRow,
  validationHasAudio,
  validationLeftOverall,
} from "@/lib/assignments/validation-progress"
import { useValidationProgressLines } from "./use-validation-progress"
import { RemoveAssignmentButton } from "./RemoveAssignmentButton"

/**
 * Team-workload rollup for the org Overview (manager oversight). One row per
 * open assignment, with its project attribution (AQU-494 — a per-assignee
 * aggregate couldn't say which project an assignment belonged to). Fetches
 * the workload endpoint, which the org's member-progress and member-list
 * settings gate (AQU-1771). A refusal (403) is reported through `onRefused`
 * so the parent drops the card altogether; any other failure, and an org with
 * no open assignments, render nothing, so the card never adds noise to an org
 * that isn't using assignments yet.
 *
 * Each row has a Remove action that emits `assignment.unassign` (AQU-494:
 * previously there was no way to clear an assignment at all, "completed" or
 * not — the row just lingered forever). Removing only soft-closes the
 * assignment row; it never touches assignment_cells or the underlying cells,
 * so validated work stays intact.
 *
 * SWARM-TODO(AQU-494): live-verify in the browser — org home → Overview →
 * Team workload. Assign work, drive it to 100% (cellsDone == cellsTotal; it
 * still shows as an open row, that's expected), click the row's Remove (X) —
 * the row should disappear immediately and stay gone on reload. Each row
 * should show <username> next to a project-name badge before the scope
 * label so a manager with assignments across multiple projects can tell
 * them apart.
 *
 * AQU-1969: validate assignments follow under their own heading, furthest
 * behind first, each reading the assignee's OWN approvals — a different
 * measure from a translate row's "validated by anyone", so the two are not
 * interleaved.
 *
 * AQU-2294: every row carries a date line — when the assignment went out and
 * when it is due — because the sorts and filters this card is growing
 * (AQU-2295) only mean something to a manager who can read those dates off
 * the rows they reorder.
 */
export function WorkloadRollup({
  jwt,
  orgId,
  action,
  canUnassignProject = () => true,
  onRefused,
}: {
  jwt: string
  orgId: number
  action?: ReactNode
  canUnassignProject?: (projectId: string) => boolean
  /** The server refused the read (403): the caller is below the org's settings. */
  onRefused?: () => void
}) {
  const t = useT()
  const { locale } = useI18n()
  const progressLines = useValidationProgressLines()
  const [rows, setRows] = useState<OrgWorkloadAssignment[] | null>(null)
  /**
   * AQU-2294: the clock the date line is measured against, stamped when the
   * workload was read. Reading `Date.now()` during render instead would be an
   * impure call whose answer changes on any unrelated re-render.
   */
  const [now, setNow] = useState(0)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const { session } = useFrontierSession()

  // Read through a ref so a parent's inline callback does not refetch.
  const onRefusedRef = useRef(onRefused)
  useEffect(() => { onRefusedRef.current = onRefused }, [onRefused])

  const load = useCallback(() => {
    let cancelled = false
    getWorkload(jwt, orgId)
      .then((w) => {
        if (cancelled) return
        setRows(w)
        setNow(Date.now())
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRows(null)
        if (err instanceof UserError && err.status === 403) onRefusedRef.current?.()
      })
    return () => { cancelled = true }
  }, [jwt, orgId])

  useEffect(() => load(), [load])

  const handleRemove = useCallback(async (a: OrgWorkloadAssignment) => {
    if (!a.fileId) {
      setRemoveError(t("org.workloadRollup.removeErrorGeneric"))
      return
    }
    setRemoveError(null)
    setRemovingId(a.assignmentId)
    try {
      await unassignAssignment({
        jwt,
        projectId: a.projectId,
        fileId: a.fileId,
        author: session?.username ?? "",
        assignmentId: a.assignmentId,
      })
      // Optimistic removal — the row's server-side unassigned_at is now set,
      // so a refetch would exclude it anyway; drop it locally for instant feedback.
      setRows((prev) => (prev ? prev.filter((r) => r.assignmentId !== a.assignmentId) : prev))
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemovingId(null)
    }
  }, [jwt, session?.username, t])

  if (!rows || rows.length === 0) return null

  const translateRows = rows.filter((a) => !isValidationRow(a))
  const validateRows = rows.filter(isValidationRow).sort(compareValidationBehind)

  const removeButton = (a: OrgWorkloadAssignment) =>
    canUnassignProject(a.projectId) && (
      <RemoveAssignmentButton
        scope={a.scopeLabel}
        username={a.username}
        removing={removingId === a.assignmentId}
        onRemove={() => void handleRemove(a)}
      />
    )

  // Who, where, which language — the same head on both kinds of row.
  const head = (a: OrgWorkloadAssignment) => (
    <div className="flex items-center gap-2">
      <UserChip
        userId={a.assigneeUserId}
        username={a.username}
        className="min-w-0"
      />
      <span className="shrink-0 truncate text-xs text-muted-foreground">{a.projectName}</span>
      {/* AQU-538 (§3.5): lane chip when the assignment is pinned to a lane. */}
      {(a.laneName || a.targetLang) && (
        <Badge variant="outline" className="shrink-0">{a.laneName || a.targetLang}</Badge>
      )}
    </div>
  )

  /**
   * AQU-2294: assigned-at and deadline, in the row's own muted extra-small
   * type. Both dates render through the shared `DateTooltip` — the deadline in
   * the `deadline` variant the Due column of "Assigned to me" uses, the
   * assigned date in the default one the Projects table's Updated column uses
   * — so the formats and the hover detail cannot drift from those surfaces.
   * The overdue / due-soon chips are the Projects table's own, off the same
   * `deadlineStatus()` rule, so this card and that table never disagree about
   * a date.
   *
   * `createdAt` is absent when the SPA is talking to a worker older than this
   * change: the row then simply has no "Assigned …" (DateTooltip renders
   * nothing for a null value), and a row with neither date has no line at all.
   */
  const dates = (a: OrgWorkloadAssignment) => {
    if (a.createdAt == null && !a.deadline) return null
    return (
      <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        <DateTooltip
          value={a.createdAt ?? null}
          label={t("org.workloadRollup.assignedLabel")}
        >
          {t("org.workloadRollup.assignedDate", {
            date: fmtShortCalendarDate(a.createdAt, now, locale),
          })}
        </DateTooltip>
        <DateTooltip
          value={a.deadline}
          label={t("org.assignedToMe.dueColumnLabel")}
          variant="deadline"
        >
          {t("org.orgHome.dueDate", { date: fmtDeadlineDate(a.deadline, now, locale) })}
        </DateTooltip>
        <ProjectDeadlineStatuses
          deadline={deadlineStatus({ deadlineAt: a.deadline }, now)}
          testId={`workload-deadline-${a.assignmentId}`}
        />
      </div>
    )
  }

  return (
    <Section title={t("org.workloadRollup.title")} action={action} contentClassName="pt-0">
      <div className="divide-y">
        {translateRows.map((a) => {
          const pct = progressPercent(a.cellsDone, a.cellsTotal)
          return (
            <div key={a.assignmentId} className="flex items-center gap-4 py-2.5 first:pt-0">
              <div className="min-w-0 flex-1">
                {head(a)}
                <p className="truncate text-xs text-muted-foreground">{a.scopeLabel}</p>
                {dates(a)}
                {/* AQU-1764: done cells are VALIDATED cells — the shared
                    palette's text-validated blue. */}
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className={`h-full rounded-full ${PROGRESS_BG.textValidated}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-end">
                <p className="text-sm font-semibold tabular-nums">
                  {a.cellsDone}/{a.cellsTotal}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">{pct}%</p>
              </div>
              {removeButton(a)}
            </div>
          )
        })}
      </div>
      {validateRows.length > 0 && (
        <div className={translateRows.length > 0 ? "mt-4" : undefined} data-testid="workload-validations">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t("org.validationProgress.heading")}</h3>
          <div className="divide-y">
            {validateRows.map((a) => {
              const v = a.validation
              const lines = progressLines(v, validationHasAudio(v))
              const left = validationLeftOverall(v)
              const pct = progressPercent(v.text.validated, v.text.total)
              return (
                <div
                  key={a.assignmentId}
                  className="flex items-center gap-4 py-2.5"
                  data-testid={`workload-validation-${a.assignmentId}`}
                >
                  <div className="min-w-0 flex-1">
                    {head(a)}
                    <p className="truncate text-xs text-muted-foreground">{a.scopeLabel}</p>
                    {dates(a)}
                    {/* The assignee's own approvals, in the text-validated tone. */}
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div className={`h-full rounded-full ${PROGRESS_BG.textValidated}`} style={{ width: `${pct}%` }} />
                    </div>
                    <p className="mt-1 text-xs tabular-nums text-muted-foreground" data-testid={`workload-validation-text-${a.assignmentId}`}>
                      {lines.text}
                    </p>
                    {lines.audio && (
                      <p className="text-xs tabular-nums text-muted-foreground" data-testid={`workload-validation-audio-${a.assignmentId}`}>
                        {lines.audio}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-end">
                    <p className="text-sm font-semibold tabular-nums">
                      {v.text.validated}/{v.text.total}
                    </p>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {left > 0
                        ? t("org.validationProgress.left", { count: left })
                        : t("org.projectOverview.plan.nothingLeft")}
                    </p>
                  </div>
                  {removeButton(a)}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {removeError && <p className="mt-2 text-xs text-destructive">{removeError}</p>}
    </Section>
  )
}
