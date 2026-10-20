// ProjectAssignedToMe — per-project "Assigned to me" pickup panel (AQU-192).
//
// Shows the current user's open assignments within ONE project. On row click,
// jumps to the first cell matching the assignment's scopeLabel (using the same
// jumpToCell mechanism as DecayBreakdown / search results).
//
// Placement: one of the workspace left sidebar's nav buttons (styled like a
// SidebarProjectSection row); clicking it opens the list in a popover. It is a member-facing affordance (any role);
// project_lead+ can additionally assign work via AssignModal.

import { useEffect, useState, useCallback } from "react"
import { ClipboardList } from "lucide-react"
import { AssignmentLaneBadge } from "@/components/AssignmentLaneBadge"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { DateTooltip } from "@/components/ui/date-tooltip"
import { fmtDeadlineDate } from "@/lib/format-date"
import { getMyAssignments, type MyAssignment } from "@/lib/sync/assignments"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import { progressPercent } from "@/lib/progress/progress-percent"
import { PROGRESS_BG } from "@/lib/progress/progress-palette"

interface ProjectAssignedToMeProps {
  projectId: string
  jwt: string | null
  /**
   * Called when the user clicks a row — parent opens the assignment's file,
   * switches to its lane, and scrolls to its first cell (AQU-690). The whole
   * assignment is passed so the handler has the file + lane, not just the label.
   */
  onJumpToAssignment?: (assignment: MyAssignment) => void
  /** Refresh token — increment to force a re-fetch (e.g. after a new assignment lands). */
  refreshKey?: number
  /** Human label for the default ('') lane — the project's target language. */
  defaultLaneLabel?: string
}

export function ProjectAssignedToMe({
  projectId,
  jwt,
  onJumpToAssignment,
  refreshKey = 0,
  defaultLaneLabel = "",
}: ProjectAssignedToMeProps) {
  const t = useT()
  const [assignments, setAssignments] = useState<MyAssignment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!jwt) return
    let cancelled = false
    setLoading(true)
    setError(null)
    void getMyAssignments(jwt, projectId)
      .then((data) => { if (!cancelled) setAssignments(data) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [jwt, projectId, refreshKey])

  const handleRowClick = useCallback(
    (a: MyAssignment) => {
      if (onJumpToAssignment) onJumpToAssignment(a)
      setOpen(false)
    },
    [onJumpToAssignment],
  )

  // Don't render if there are no assignments and we're not loading (clean state).
  if (!loading && !error && assignments.length === 0) return null

  // Wrapped in a div so Base UI's focus-guard <span>s stay out of the
  // sidebar section's flex list (see SidebarProjectSection).
  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className={cn(
                "flex h-7 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors",
                "hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none",
                open ? "bg-accent text-foreground" : "text-muted-foreground",
              )}
            >
              <ClipboardList className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate text-start">{t("workspace.assignedToMe.heading")}</span>
              {assignments.length > 0 && (
                <span className="rounded-md px-1.5 text-[10px] tabular-nums text-primary">
                  {assignments.length}
                </span>
              )}
            </button>
          }
        />
        <PopoverContent side="right" align="end" className="max-h-[60vh] w-72 gap-0 overflow-y-auto rounded-xl p-1">
          <div className="space-y-0.5">
          {loading ? (
            <div className="flex items-center px-2 py-1 text-muted-foreground">
              <Spinner className="size-3" />
            </div>
          ) : error ? (
            <p className="px-2 py-1 text-xs text-destructive">{error}</p>
          ) : (
            assignments.map((a) => {
              const pct = progressPercent(a.cellsDone, a.cellsTotal)
              return (
                <AppTooltip
                  key={a.assignmentId}
                  content={
                    a.note
                      ? t("workspace.assignedToMe.jumpToWithNoteTooltip", { scope: a.scopeLabel, note: a.note })
                      : t("workspace.assignedToMe.jumpToTooltip", { scope: a.scopeLabel })
                  }
                >
                  <button
                    type="button"
                    onClick={() => handleRowClick(a)}
                    className={cn(
                      "group w-full rounded px-2 py-1.5 text-start transition-colors hover:bg-muted/60",
                      !onJumpToAssignment && "cursor-default",
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate text-xs font-medium leading-tight">{a.scopeLabel}</span>
                        <AssignmentLaneBadge
                          targetLang={a.targetLang}
                          defaultLaneLabel={defaultLaneLabel}
                          fallbackLabel={t("org.projectOverview.laneDefaultFallback")}
                          className="h-4 px-1 text-[9px] leading-none"
                        />
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
                    </div>
                    {/* Progress bar. AQU-1764: done cells are VALIDATED
                        cells — the shared palette's text-validated blue. */}
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full transition-[width] ${PROGRESS_BG.textValidated}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {t("workspace.assignedToMe.cellsProgress", { done: a.cellsDone, total: a.cellsTotal })}
                      {a.deadline ? (
                        <>
                          {" · "}
                          <DateTooltip
                            value={a.deadline}
                            label={t("org.assignedToMe.dueColumnLabel")}
                            variant="deadline"
                          >
                            {`${t("org.assignedToMe.dueColumnLabel")} ${fmtDeadlineDate(a.deadline)}`}
                          </DateTooltip>
                        </>
                      ) : null}
                    </p>
                  </button>
                </AppTooltip>
              )
            })
          )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
