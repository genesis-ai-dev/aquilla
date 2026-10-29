import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { getWorkload, unassignAssignment, type OrgWorkloadAssignment } from "@/lib/sync/assignments"
import { Section } from "@/components/ui/page"
import { Badge } from "@/components/ui/badge"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useT } from "@/lib/i18n/I18nProvider"
import { UserChip } from "@/components/UserChip"
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
import { ShowMoreControls, useShowMore } from "@/components/ui/show-more-controls"

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
 * AQU-2293: each of the two lists caps at the shared page size and expands
 * through the same Show more / Show all / Show fewer control the project
 * overview's imported-originals list uses, independently of the other — an org
 * with many assignments used to run the card long enough to push Team usage
 * and AI usage far down the page.
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
  const progressLines = useValidationProgressLines()
  const [rows, setRows] = useState<OrgWorkloadAssignment[] | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const { session } = useFrontierSession()

  // Read through a ref so a parent's inline callback does not refetch.
  const onRefusedRef = useRef(onRefused)
  useEffect(() => { onRefusedRef.current = onRefused }, [onRefused])

  const load = useCallback(() => {
    let cancelled = false
    getWorkload(jwt, orgId)
      .then((w) => { if (!cancelled) setRows(w) })
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

  // Row order is the server's for translate rows (newest-assigned first) and
  // furthest-behind-first for validate rows; capping must not disturb either.
  // Derived before the empty-list early return, since the paging hooks below
  // cannot sit behind it.
  const translateRows = useMemo(
    () => (rows ?? []).filter((a) => !isValidationRow(a)),
    [rows],
  )
  const validateRows = useMemo(
    () => (rows ?? []).filter(isValidationRow).sort(compareValidationBehind),
    [rows],
  )
  // Each list caps on its own. Removing a visible row shrinks the list, so the
  // next hidden row slides up into the cap and "Show all (N)" drops by one.
  const { visible: visibleTranslateRows, controls: translatePaging } = useShowMore(translateRows)
  const { visible: visibleValidateRows, controls: validatePaging } = useShowMore(validateRows)

  if (!rows || rows.length === 0) return null

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

  return (
    <Section title={t("org.workloadRollup.title")} action={action} contentClassName="pt-0">
      <div className="divide-y" id="workload-translate-list">
        {visibleTranslateRows.map((a) => {
          const pct = progressPercent(a.cellsDone, a.cellsTotal)
          return (
            <div key={a.assignmentId} className="flex items-center gap-4 py-2.5 first:pt-0">
              <div className="min-w-0 flex-1">
                {head(a)}
                <p className="truncate text-xs text-muted-foreground">{a.scopeLabel}</p>
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
      <ShowMoreControls
        state={translatePaging}
        controlsId="workload-translate-list"
        testIdPrefix="workload-translate"
      />
      {validateRows.length > 0 && (
        <div className={translateRows.length > 0 ? "mt-4" : undefined} data-testid="workload-validations">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t("org.validationProgress.heading")}</h3>
          <div className="divide-y" id="workload-validate-list">
            {visibleValidateRows.map((a) => {
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
          <ShowMoreControls
            state={validatePaging}
            controlsId="workload-validate-list"
            testIdPrefix="workload-validate"
          />
        </div>
      )}
      {removeError && <p className="mt-2 text-xs text-destructive">{removeError}</p>}
    </Section>
  )
}
