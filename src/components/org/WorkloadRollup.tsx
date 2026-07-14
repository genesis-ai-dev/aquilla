import { useCallback, useEffect, useState, type ReactNode } from "react"
import { X } from "lucide-react"
import { getWorkload, unassignAssignment, type OrgWorkloadAssignment } from "@/lib/sync/assignments"
import { Section } from "@/components/ui/page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useFrontierSession } from "@/hooks/useFrontierSession"

/**
 * Team-workload rollup for the org Overview (manager oversight). One row per
 * open assignment, with its project attribution (AQU-494 — a per-assignee
 * aggregate couldn't say which project an assignment belonged to). Fetches
 * the maintainer-gated workload endpoint; a non-manager caller gets a 403,
 * which we swallow so the section simply doesn't render for them. Renders
 * nothing when there are no open assignments, so it never adds noise to an org
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
 */
export function WorkloadRollup({ jwt, orgId, action }: { jwt: string; orgId: number; action?: ReactNode }) {
  const [rows, setRows] = useState<OrgWorkloadAssignment[] | null>(null)
  const [removingId, setRemovingId] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const { session } = useFrontierSession()

  const load = useCallback(() => {
    let cancelled = false
    getWorkload(jwt, orgId)
      .then((w) => { if (!cancelled) setRows(w) })
      .catch(() => { if (!cancelled) setRows(null) }) // 403 (non-manager) or transient → hide
    return () => { cancelled = true }
  }, [jwt, orgId])

  useEffect(() => load(), [load])

  const handleRemove = useCallback(async (a: OrgWorkloadAssignment) => {
    if (!a.fileId) {
      setRemoveError("Can't remove this assignment — it has no resolved cells to route through.")
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
  }, [jwt, session?.username])

  if (!rows || rows.length === 0) return null

  return (
    <Section title="Team workload" action={action} contentClassName="pt-0">
      <div className="divide-y">
        {rows.map((a) => {
          const pct = a.cellsTotal > 0 ? Math.round((a.cellsDone / a.cellsTotal) * 100) : 0
          return (
            <div key={a.assignmentId} className="flex items-center gap-4 py-2.5 first:pt-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate font-medium">{a.username ?? `User ${a.assigneeUserId}`}</p>
                  <span className="shrink-0 truncate text-xs text-muted-foreground">{a.projectName}</span>
                  {/* AQU-538 (§3.5): lane chip when the assignment is pinned to a lane. */}
                  {a.targetLang && (
                    <Badge variant="outline" className="shrink-0">{a.targetLang}</Badge>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{a.scopeLabel}</p>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums">
                  {a.cellsDone}/{a.cellsTotal}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">{pct}%</p>
              </div>
              <AppTooltip content="Remove this assignment">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove assignment: ${a.scopeLabel} (${a.username ?? `User ${a.assigneeUserId}`})`}
                  disabled={removingId === a.assignmentId}
                  onClick={() => void handleRemove(a)}
                >
                  <X />
                </Button>
              </AppTooltip>
            </div>
          )
        })}
      </div>
      {removeError && <p className="mt-2 text-xs text-destructive">{removeError}</p>}
    </Section>
  )
}
