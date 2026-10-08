// Concepts from the org termbases a project subscribes to. (AQU-1721)
//
// A project can subscribe to the published termbase of another project in its
// org (auth-worker routes/termbase-subscriptions.ts). The editor applies those
// concepts ahead of the project's own: `useRules` compiles them through the
// same path as local terminology, and the workspace also hands them to source
// highlights, the term-lookup popover and Check file.
//
// They are READ-ONLY here. Each one carries `termbaseProjectId`, the project
// that owns it, and the glossary never receives them: a glossary edit is a
// `term.*` event keyed by concept id under THIS project's id, so the server
// would drop an edit to an upstream concept while the glossary showed it saved.
//
// The read: list the subscriptions (route #4, already in priority-then-age
// order), skip the unpublished ones, and read each remaining termbase's active
// concepts through route #8 (GET /api/v2/projects/:termbaseProjectId/termbase/
// concepts). Route #8's resolver, `canReadTermbase`, is the rule for which
// subscriptions count: the termbase must be published, not archived, and in
// this project's org. A 403 from it is that rule, not a failure, so it gives
// no concepts and no error. Autopilot (`loadSubscribedConcepts`) and the Agent
// API prompt preview apply the same rule.
//
// Lanes (AQU-1777): a termbase is a project with its own lanes, so its
// renderings are stamped with ITS lane ids. Route #8 maps each one onto this
// project's lane of the same language (mapSubscribedConceptLanes in
// src/lib/terminology/rendering-lane.ts) before answering, so `laneId` here is
// always one of THIS project's lanes and every lane filter downstream
// (useRules, Check file, the lookup popover) treats a subscribed rendering
// exactly like a local one. A rendering no lane here matches never arrives.
//
// Thin-client (AD-3): plain `useState` + a race-guarded `useEffect`, like
// `useConcepts`. No React Query hooks.

import { useCallback, useEffect, useRef, useState } from "react"
import { useFrontierSession } from "./useFrontierSession"
import {
  listSubscriptions,
  type TermbaseSubscription,
} from "@/lib/terminology/subscriptions-api"
import { FRONTIER_BASE } from "@/lib/frontier/auth"
import type { Concept } from "@/lib/terminology/types"

const ACTIVE = (c: Concept) => c.status === "active"

/** Stable empties so consumers' memos keep identity across renders. */
const NO_CONCEPTS: Concept[] = []
const NO_SUBSCRIPTIONS: TermbaseSubscription[] = []

/**
 * GET the active concepts of one subscribed termbase through route #8, each
 * marked with the termbase it came from. A 403 means the termbase is gated off
 * (archived, deleted or in another org), so it gives no concepts. Any other
 * failure throws: an empty result would look like a termbase with no terms.
 * Exported for unit testing.
 */
export async function fetchTermbaseConcepts(
  jwt: string,
  subscriberProjectId: string,
  termbaseProjectId: string,
): Promise<Concept[]> {
  const res = await fetch(
    `${FRONTIER_BASE}/api/v2/projects/${encodeURIComponent(termbaseProjectId)}/termbase/concepts` +
      `?subscriberProjectId=${encodeURIComponent(subscriberProjectId)}`,
    { headers: { Authorization: `Bearer ${jwt}` } },
  )
  if (res.status === 403) return NO_CONCEPTS
  if (!res.ok) throw new Error(`subscribed termbase ${termbaseProjectId} could not be read (HTTP ${res.status})`)
  const body = (await res.json()) as { concepts?: Concept[] }
  return (body.concepts ?? []).filter(ACTIVE).map((c) => ({ ...c, termbaseProjectId }))
}

export interface SubscribedConcepts {
  /** Active concepts from every subscribed termbase that counts, in priority order. */
  concepts: Concept[]
  subscriptions: TermbaseSubscription[]
  isLoading: boolean
  /** Set when a read failed. The concepts then stay as they were last read. */
  error: string | null
  refresh: () => Promise<void>
}

/**
 * The concepts a project's termbase subscriptions contribute, flattened in
 * subscription-priority order (priority asc, then createdAt — the order route
 * #4 returns), each termbase's active concepts appended in turn. Higher-
 * precedence termbases come first, so `useRules`, which puts them ahead of
 * local terminology, keeps that precedence in evaluation order.
 */
export function useSubscribedConcepts(projectId: string | null): SubscribedConcepts {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [subscriptions, setSubscriptions] = useState<TermbaseSubscription[]>(NO_SUBSCRIPTIONS)
  const [concepts, setConcepts] = useState<Concept[]>(NO_CONCEPTS)
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Race guard. A slower read for a PREVIOUS project (or token) must never
  // overwrite a newer one's results, which a bare setState in an async body
  // would do on a fast project switch.
  const requestRef = useRef(0)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    const seq = ++requestRef.current
    const settle = (fn: () => void) => {
      // Ignore a response that a newer request (or unmount) has superseded.
      if (aliveRef.current && requestRef.current === seq) fn()
    }
    if (!jwt || !projectId) {
      settle(() => {
        setSubscriptions(NO_SUBSCRIPTIONS)
        setConcepts(NO_CONCEPTS)
        setError(null)
      })
      return
    }
    setLoading(true)
    try {
      const subs = await listSubscriptions(jwt, projectId)
      // Route #8 refuses an unpublished termbase anyway; skip the request.
      const perTermbase = await Promise.all(
        subs
          .filter((s) => s.published)
          .map((s) => fetchTermbaseConcepts(jwt, projectId, s.termbaseProjectId)),
      )
      const flat = perTermbase.flat()
      settle(() => {
        setSubscriptions(subs.length === 0 ? NO_SUBSCRIPTIONS : subs)
        setConcepts(flat.length === 0 ? NO_CONCEPTS : flat)
        setError(null)
      })
    } catch (e) {
      settle(() => setError(e instanceof Error ? e.message : String(e)))
    } finally {
      settle(() => setLoading(false))
    }
  }, [jwt, projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { concepts, subscriptions, isLoading, error, refresh }
}
