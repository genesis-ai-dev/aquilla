/**
 * AQU-2317 (AQU-1352 §3.6): the one read of
 * `GET /api/v2/orgs/:orgId/access` for the active org, flattened to one row
 * per (person, grant) carrying the grant's scope path, role level and source.
 * Every surface on the Access page — tree, people rows, chips, CSV — reads
 * this, so none of them can disagree about a grant.
 *
 * AD-3 thin client: a plain `useState` + race-guarded `useEffect` read, no
 * React Query. The payload is keyed by the org it was fetched for, so org A's
 * grants can never render (or be exported) under org B while B is loading, and
 * losing the session or the org reads as loading rather than leaving stale
 * rows on screen.
 */
import { useEffect, useMemo, useState } from "react"

import { fetchOrgAccess, type OrgAccessPayload } from "@/components/org/access/org-access-data"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import type { GrantOrigin, ScopePath, ScopeRef } from "@/lib/access/types"

/** One (person, grant) pair: who, where, which role, and where it comes from. */
export interface OrgAccessGrantRow {
  userId: string
  displayName: string
  isGuest: boolean
  /** The place the grant applies at, outermost crumb first. */
  scopePath: ScopePath
  /** Ladder level, or `null` for "no access here". */
  roleLevel: number | null
  /** Server-derived: direct, inherited (with the place it is set at), creator
   *  or platform. The client never recomputes inheritance (§3.7 rule 1). */
  origin: GrantOrigin
}

export type OrgAccessState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready"
      data: OrgAccessPayload
      /** The org at the root of the tree, when the viewer can see it. */
      org: ScopeRef | undefined
      grants: OrgAccessGrantRow[]
    }

type LoadState = { status: "loading" } | { status: "ready"; data: OrgAccessPayload } | { status: "error" }
/** Keyed by the org it was loaded for: a result for another org is never shown. */
type KeyedState = { orgId: number | null; state: LoadState }
const LOADING: LoadState = { status: "loading" }

export function useOrgAccess(): OrgAccessState {
  const { activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [loaded, setLoaded] = useState<KeyedState>({ orgId: null, state: LOADING })

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    fetchOrgAccess(jwt, activeOrgId).then(
      (data) => { if (!cancelled) setLoaded({ orgId: activeOrgId, state: { status: "ready", data } }) },
      () => { if (!cancelled) setLoaded({ orgId: activeOrgId, state: { status: "error" } }) },
    )
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  // On org switch (or signed-out / no org) the previous org's payload must not
  // render or export: anything not loaded for the current org reads as loading.
  const state: LoadState = jwt && activeOrgId != null && loaded.orgId === activeOrgId ? loaded.state : LOADING
  const data = state.status === "ready" ? state.data : undefined

  const grants = useMemo(
    () =>
      (data?.people ?? []).flatMap((p) =>
        p.grants.map((g) => ({
          userId: p.userId,
          displayName: p.displayName,
          isGuest: p.isGuest,
          scopePath: g.scopePath,
          roleLevel: g.roleLevel,
          origin: g.origin,
        })),
      ),
    [data],
  )

  if (state.status !== "ready" || !data) return state.status === "error" ? { status: "error" } : { status: "loading" }
  return { status: "ready", data, org: data.tree[0]?.scope, grants }
}
