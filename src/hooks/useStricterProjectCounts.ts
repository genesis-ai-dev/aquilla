// AQU-1771 / AQU-2306: the org Security page's "N projects are stricter than
// this" counts, with the projects behind them (AQU-1938).
//
// Lifted out of RosterProgressSection when the import floor grew the same line
// (AQU-2306), so there is one reader of the route rather than two copies of
// this effect. Each section passes the floors ITS count depends on and re-reads
// only when those move: the roster rows on the two visibility floors, the
// import row on the org's import floor. The triggers genuinely differ, so the
// state stays per section rather than hoisted to the page.
//
// AQU-2654: the REQUEST is shared, though. Both sections mount in the same
// frame and the server answers for the whole org either way, so two sections
// asking together send one request. A section that asks later — because a
// floor it depends on moved — never joins an older request: it waits for it
// and reads again, so a count is never computed from before the change.
//
// Plain useState + a race-guarded useEffect, per AD-3 — never useQuery.

import { useEffect, useState } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { createRequestCoalescer } from "@/lib/request-coalescer"
import { fetchVisibilityOverrideCounts, type VisibilityOverrideCounts } from "@/lib/sync/org-settings"

const countsCoalescer = createRequestCoalescer<VisibilityOverrideCounts | null>({ joinWindowMs: 250 })

/**
 * Null until known — and on a server without the route, where the line says
 * nothing rather than claiming every project follows the org.
 *
 * `floors` are the values a change in which should re-read the counts; they are
 * read as a key, not sent, since the server resolves the org's floors itself.
 */
export function useStricterProjectCounts(
  orgId: number | null | undefined,
  floors: readonly number[],
): VisibilityOverrideCounts | null {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [counts, setCounts] = useState<{ key: string; value: VisibilityOverrideCounts | null } | null>(null)
  const key = `${orgId ?? ""}:${floors.join(":")}`
  useEffect(() => {
    if (!jwt || orgId == null) return
    let cancelled = false
    void countsCoalescer
      .run(`${jwt}:${orgId}`, () => fetchVisibilityOverrideCounts(jwt, orgId))
      .then((value) => {
        if (!cancelled) setCounts({ key, value })
      })
    return () => { cancelled = true }
  }, [jwt, orgId, key])
  return counts?.key === key ? counts.value : null
}
