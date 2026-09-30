// ProjectHandedOut — "Handed out by you" sidebar panel (AQU-581).
//
// A lane coordinator can assign work but can't open the org's Team workload
// panel, which is the only other place an assignment can be removed. Without
// this list a coordinator's mistake stayed until a lead noticed, and assigning
// again only made a duplicate. It lists the open assignments the signed-in
// member handed out in this project, each with a Remove button; the server
// lets a coordinator remove only their own, in a language they still hold.
//
// Placement: under "My assignments" in the workspace left sidebar, shown only
// to a member whose assign access comes from the lane-coordinator setting.

import { useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, Send, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { getAssignmentsGivenByMe, unassignAssignment, type GivenAssignment } from "@/lib/sync/assignments"
import { useT } from "@/lib/i18n/I18nProvider"

interface ProjectHandedOutProps {
  projectId: string
  jwt: string
  /** The signed-in username, stamped on the unassign event. */
  author: string
  /** Increment to re-fetch (e.g. after the coordinator assigns something). */
  refreshKey?: number
  /** Called after a removal lands, so the other assignment lists can refresh. */
  onRemoved?: () => void
}

export function ProjectHandedOut({ projectId, jwt, author, refreshKey = 0, onRemoved }: ProjectHandedOutProps) {
  const t = useT()
  const [assignments, setAssignments] = useState<GivenAssignment[]>([])
  const [expanded, setExpanded] = useState(true)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getAssignmentsGivenByMe(jwt, projectId)
      .then((data) => { if (!cancelled) setAssignments(data) })
      .catch(() => { /* no list is better than a broken one; the server still guards removal */ })
    return () => { cancelled = true }
  }, [jwt, projectId, refreshKey])

  const handleRemove = useCallback(async (a: GivenAssignment) => {
    setError(null)
    if (!a.fileId) {
      setError(t("org.workloadRollup.removeErrorGeneric"))
      return
    }
    setRemovingId(a.assignmentId)
    try {
      await unassignAssignment({ jwt, projectId, fileId: a.fileId, author, assignmentId: a.assignmentId })
      setAssignments((prev) => prev.filter((r) => r.assignmentId !== a.assignmentId))
      onRemoved?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRemovingId(null)
    }
  }, [jwt, projectId, author, onRemoved, t])

  if (assignments.length === 0) return null

  return (
    <div className="border-t px-2 pt-2 pb-1" data-testid="project-handed-out">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-start text-xs font-medium text-muted-foreground hover:bg-muted/60 hover:text-foreground"
      >
        {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
        <Send className="h-3 w-3 shrink-0" />
        <span className="truncate">{t("workspace.handedOut.heading")}</span>
        <Badge className="ms-auto shrink-0">{assignments.length}</Badge>
      </button>

      {expanded && (
        <div className="mt-1 space-y-0.5">
          {assignments.map((a) => {
            const username = a.username ?? t("org.workloadRollup.unknownUser", { id: a.assigneeUserId })
            return (
              <div key={a.assignmentId} className="flex items-center gap-1 rounded px-2 py-1.5">
                <div className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate text-xs font-medium leading-tight">{a.scopeLabel}</span>
                    {a.targetLang && (
                      <Badge variant="outline" className="h-4 shrink-0 px-1 text-[9px] leading-none">
                        {a.targetLang}
                      </Badge>
                    )}
                  </span>
                  <p className="truncate text-[10px] text-muted-foreground">
                    {t("workspace.handedOut.assignee", { username })}
                  </p>
                </div>
                <AppTooltip content={t("org.workloadRollup.removeTooltip")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("org.workloadRollup.removeAriaLabel", { scope: a.scopeLabel, user: username })}
                    disabled={removingId === a.assignmentId}
                    onClick={() => void handleRemove(a)}
                  >
                    {removingId === a.assignmentId ? <Spinner className="size-3" /> : <X className="size-3" />}
                  </Button>
                </AppTooltip>
              </div>
            )
          })}
          {error && <p className="px-2 py-1 text-xs text-destructive">{error}</p>}
        </div>
      )}
    </div>
  )
}
