// ProjectAssignedToMe — per-project "Assigned to me" pickup panel (AQU-192).
//
// Shows the current user's open assignments within ONE project. On row click,
// jumps to the first cell matching the assignment's scopeLabel (using the same
// jumpToCell mechanism as DecayBreakdown / search results).
//
// Placement: rendered as a compact collapsible section in the workspace left
// sidebar below the file list. It is a member-facing affordance (any role);
// project_lead+ can additionally assign work via AssignModal.

import { useEffect, useState, useCallback } from "react"
import { ChevronDown, ChevronRight, ClipboardList } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { getMyAssignments, type MyAssignment } from "@/lib/sync/assignments"
import { cn } from "@/lib/utils"

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
}

export function ProjectAssignedToMe({
  projectId,
  jwt,
  onJumpToAssignment,
  refreshKey = 0,
}: ProjectAssignedToMeProps) {
  const [assignments, setAssignments] = useState<MyAssignment[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

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
    },
    [onJumpToAssignment],
  )

  // Don't render if there are no assignments and we're not loading (clean state).
  if (!loading && !error && assignments.length === 0) return null

  return (
    <div className="border-t px-2 pt-2 pb-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <ClipboardList className="h-3 w-3 shrink-0" />
        <span className="truncate">My assignments</span>
        {assignments.length > 0 && (
          <Badge className="ml-auto shrink-0">{assignments.length}</Badge>
        )}
      </button>

      {expanded && (
        <div className="mt-1 space-y-0.5">
          {loading ? (
            <div className="flex items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Loading…
            </div>
          ) : error ? (
            <p className="px-2 py-1 text-xs text-destructive">{error}</p>
          ) : (
            assignments.map((a) => {
              const pct = a.cellsTotal > 0 ? Math.round((a.cellsDone / a.cellsTotal) * 100) : 0
              return (
                <AppTooltip key={a.assignmentId} content={`Jump to ${a.scopeLabel}${a.note ? `: ${a.note}` : ""}`}>
                  <button
                    type="button"
                    onClick={() => handleRowClick(a)}
                    className={cn(
                      "group w-full rounded px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
                      !onJumpToAssignment && "cursor-default",
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="flex min-w-0 items-center gap-1">
                        <span className="truncate text-xs font-medium leading-tight">{a.scopeLabel}</span>
                        {/* AQU-729: lane chip for EVERY assignment — the pinned
                            lane, or the project's default target language for a
                            default-lane assignment, so the assignee can always
                            tell which language they're being asked to work in
                            (AQU-538 previously showed it only for pinned lanes). */}
                        {a.laneLabel && (
                          <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] leading-none">
                            {a.laneLabel}
                          </Badge>
                        )}
                      </span>
                      <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{pct}%</span>
                    </div>
                    {/* Progress bar */}
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
                    </div>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {a.cellsDone}/{a.cellsTotal} cells
                      {a.deadline ? ` · Due ${a.deadline}` : ""}
                    </p>
                  </button>
                </AppTooltip>
              )
            })
          )}
        </div>
      )}
    </div>
  )
}
