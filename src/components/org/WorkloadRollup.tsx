import { useEffect, useState } from "react"
import { getWorkload, type AssigneeWorkload } from "@/lib/sync/assignments"

/**
 * Per-member workload rollup for the org Overview (manager oversight). Fetches
 * the maintainer-gated workload endpoint; a non-manager caller gets a 403,
 * which we swallow so the section simply doesn't render for them. Renders
 * nothing when there are no open assignments, so it never adds noise to an org
 * that isn't using assignments yet.
 */
export function WorkloadRollup({ jwt, orgId }: { jwt: string; orgId: number }) {
  const [rows, setRows] = useState<AssigneeWorkload[] | null>(null)

  useEffect(() => {
    let cancelled = false
    getWorkload(jwt, orgId)
      .then((w) => { if (!cancelled) setRows(w) })
      .catch(() => { if (!cancelled) setRows(null) }) // 403 (non-manager) or transient → hide
    return () => { cancelled = true }
  }, [jwt, orgId])

  if (!rows || rows.length === 0) return null

  return (
    <div className="rounded-lg border p-4">
      <h2 className="text-sm font-semibold">Team workload</h2>
      <div className="mt-3 divide-y">
        {rows.map((w) => {
          const pct = w.cellsTotal > 0 ? Math.round((w.cellsDone / w.cellsTotal) * 100) : 0
          return (
            <div key={w.userId} className="flex items-center gap-4 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{w.username ?? `User ${w.userId}`}</p>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-medium">
                  {w.cellsDone}/{w.cellsTotal}
                </p>
                <p className="text-xs text-muted-foreground">
                  {w.openAssignments} open · {pct}%
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
