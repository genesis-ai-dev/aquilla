import { useEffect, useState } from "react"
import { getWorkload, type AssigneeWorkload } from "@/lib/sync/assignments"
import { Section } from "@/components/ui/page"

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
    <Section title="Team workload" contentClassName="pt-0">
      <div className="divide-y">
        {rows.map((w) => {
          const pct = w.cellsTotal > 0 ? Math.round((w.cellsDone / w.cellsTotal) * 100) : 0
          return (
            <div key={w.userId} className="flex items-center gap-4 py-2.5 first:pt-0">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{w.username ?? `User ${w.userId}`}</p>
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-semibold tabular-nums">
                  {w.cellsDone}/{w.cellsTotal}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {w.openAssignments} open · {pct}%
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </Section>
  )
}
