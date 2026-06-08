import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useFrontierSession } from "./useFrontierSession"
import {
  listSubscriptions,
  type TermbaseSubscription,
} from "@/lib/terminology/subscriptions-api"
import { FRONTIER_BASE } from "@/lib/frontier/auth"
import type { Concept } from "@/lib/terminology/types"

/**
 * Fetch the active concepts of every termbase a project is subscribed to,
 * ordered by subscription priority (lower priority value = higher precedence,
 * emitted first).
 *
 * The merge into the rule engine lives in `useRules`; this hook is the
 * data-source. Subscribed managed concepts stay DETERMINISTIC managed terms —
 * this hook returns plain Concept[]; `useRules` compiles them through the same
 * `compileConceptsToRules` path as local terminology, so the
 * deterministic/probabilistic contract is preserved.
 *
 * ── SWARM-TODO (missing server read endpoint) ───────────────────────────────
 * There is currently NO `/api/v2` route that returns another project's
 * terminology concepts. `GET /api/v2/projects/:id` (ProjectDetailResponse,
 * src/lib/sync/projects-read-types.ts) does NOT include `terminology`, and the
 * publish/subscribe slice (docs/swarm/TERM3-ORG-API.md) only manages
 * subscription ROWS — it explicitly leaves the upstream termbase-DATA read
 * resolver `canReadTermbase(viewerProjectId, termbaseProjectId)` as a server
 * SWARM-TODO.
 *
 * Required server route (proposed):
 *   GET /api/v2/projects/:termbaseProjectId/termbase/concepts
 *     - auth: implicit viewer grant via canReadTermbase — true when a
 *       project_termbase_subscriptions(callerProject, :termbaseProjectId) row
 *       exists (mirror canReadSourceCells in services/project-permissions.ts).
 *       Caller passes its own project id (?subscriberProjectId=...) so the
 *       resolver can find the subscription row.
 *     - 200 { concepts: Concept[] }  // active concepts only
 *
 * Until that route exists, `fetchTermbaseConcepts` requests the proposed path
 * and treats any non-2xx (incl. the expected 404 while the route is absent) as
 * "no concepts yet" — so the ordering/merge wiring below is exercised and
 * tested now, and starts returning real concepts the moment the server route
 * lands, with NO client change required.
 */

const ACTIVE = (c: Concept) => c.status === "active"

/**
 * GET the active concepts for one upstream termbase project via the implicit
 * subscription grant. Returns [] on any error (route absent / no access).
 * Exported for unit testing the ordering merge.
 */
export async function fetchTermbaseConcepts(
  jwt: string,
  subscriberProjectId: string,
  termbaseProjectId: string,
): Promise<Concept[]> {
  try {
    const res = await fetch(
      `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(termbaseProjectId)}/termbase/concepts` +
        `?subscriberProjectId=${encodeURIComponent(subscriberProjectId)}`,
      { headers: { Authorization: `Bearer ${jwt}` } },
    )
    if (!res.ok) return [] // SWARM-TODO: route not yet implemented (see header).
    const body = (await res.json()) as { concepts?: Concept[] }
    return (body.concepts ?? []).filter(ACTIVE)
  } catch {
    return []
  }
}

export interface SubscribedConcepts {
  /** Active concepts from all subscribed termbases, ordered by priority. */
  concepts: Concept[]
  subscriptions: TermbaseSubscription[]
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/**
 * Returns the concepts contributed by a project's termbase subscriptions,
 * flattened in subscription-priority order (priority asc, then createdAt — the
 * order GET /subscriptions already returns), each termbase's active concepts
 * appended in turn. Higher-precedence (lower priority value) termbases come
 * first, so when `useRules` unions them ahead of nothing/local terminology the
 * precedence is preserved in evaluation order.
 */
export function useSubscribedConcepts(projectId: string | null): SubscribedConcepts {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [subscriptions, setSubscriptions] = useState<TermbaseSubscription[]>([])
  const [concepts, setConcepts] = useState<Concept[]>([])
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    if (!jwt || !projectId) {
      setSubscriptions([])
      setConcepts([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const subs = await listSubscriptions(jwt, projectId)
      // subs already arrive ordered by priority asc, then createdAt.
      const onlyLive = subs.filter((s) => s.published)
      const perTermbase = await Promise.all(
        onlyLive.map((s) => fetchTermbaseConcepts(jwt, projectId, s.termbaseProjectId)),
      )
      const flat = perTermbase.flat()
      if (aliveRef.current) {
        setSubscriptions(subs)
        setConcepts(flat)
      }
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (aliveRef.current) setLoading(false)
    }
  }, [jwt, projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return useMemo(
    () => ({ concepts, subscriptions, isLoading, error, refresh }),
    [concepts, subscriptions, isLoading, error, refresh],
  )
}
