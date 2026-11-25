import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { getOrg } from "@/lib/frontier/get-org"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { isJwtExpired } from "@/lib/frontier/auth"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { rememberListedProjects } from "@/lib/sync/project-record-seed"
import {
  ALL_ORGS_PARAM,
  ORG_STORAGE_KEY,
  parseOrgPath,
} from "@/lib/navigation/org-paths"

/** AQU-473: an org the caller can reach only via a project-level grant —
 *  not an org membership. Surfaced in the org switcher tagged "Guest". */
export interface GuestOrg {
  id: number
  name: string | null
}

interface OrgContextValue {
  orgs: OrgSummary[]
  activeOrgId: number | null
  activeOrg: OrgSummary | null
  /**
   * AQU-790: the guest org currently in scope — the `guestOrgs` entry whose id
   * matches `activeOrgId` when that org is *not* a membership. Non-null exactly
   * when the path names a guest org (`/orgs/:guestId`). Lets chrome describe the
   * guest org without pretending it's a membership (`activeOrg` stays null).
   */
  activeGuestOrg: GuestOrg | null
  isAllOrgs: boolean
  /** Orgs reached only through a direct project grant (no org membership). */
  guestOrgs: GuestOrg[]
  /** One app-wide project discovery result, shared by dashboard/sidebar users. */
  accessibleProjects: CloudProjectSummary[]
  accessibleProjectsLoading: boolean
  /**
   * AQU-883: the project-directory fetch failed. Tracked separately from
   * `error` (the organizations fetch) because the two fail independently —
   * orgs can load fine while the directory 401s/5xxs, and the directory is the
   * *only* source of guest orgs and shared projects. Without this, every such
   * failure collapsed into an empty list and read as "nothing is shared with
   * you". Consumers surface it with a Retry that calls
   * `refreshAccessibleProjects`.
   */
  accessibleProjectsError: string | null
  setActiveOrg: (id: number) => void
  setAllOrgs: () => void
  isLoading: boolean
  error: string | null
  /** Fetch the latest org list. Returns the freshly loaded orgs so callers
   *  that need the result immediately don't race against a stale closure. */
  refresh: () => Promise<OrgSummary[]>
  refreshAccessibleProjects: () => Promise<CloudProjectSummary[]>
  /**
   * AQU-882: recover from a failed organizations load in place. Re-issues the
   * org fetch *and* the dependent project-directory fetch, so surfaces showing
   * the failure (the `/orgs/all` dashboard, the sidebar switcher) can offer a
   * Retry instead of forcing a full page reload.
   */
  retryOrgLoad: () => Promise<void>
  /**
   * An org the caller can open without belonging to it — one a platform admin
   * reaches through the switcher catalog — is in neither `orgs` (memberships)
   * nor `guestOrgs` (project grants), so it is fetched by id. This is the
   * answer so far: `undefined` while it is not in, `null` when the server
   * refused or has no such org. Chrome that names an org by id goes through
   * `useOrgLookup`, which also asks.
   */
  lookedUpOrg: (id: number) => OrgSummary | null | undefined
  /** Ask for one such org. Repeat calls cost one request per id per load of the org list. */
  requestOrgLookup: (id: number) => void
}

/** Orgs fetched one id at a time (see `lookedUpOrg`), for the account that asked. */
interface OrgLookups {
  jwt: string | null
  byId: ReadonlyMap<number, OrgSummary | null>
}

const NO_ORG_LOOKUPS: OrgLookups = { jwt: null, byId: new Map() }

const OrgContext = createContext<OrgContextValue | null>(null)

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session, loading: sessionLoading } = useFrontierSession()
  const location = useLocation()
  const jwt = session?.jwt ?? null
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  // Seed from localStorage for non-/orgs routes (e.g. /project/...)/editor until
  // the user navigates into an org shell; `/orgs/...` always wins (below).
  const [activeOrgId, setActiveOrgId] = useState<number | null>(() => {
    const raw = localStorage.getItem(ORG_STORAGE_KEY)
    if (!raw || raw === ALL_ORGS_PARAM) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  })
  // Start unresolved even before IndexedDB supplies the session. Initializing
  // from `!!jwt` painted a false-ready org context for one render on cold load.
  const [isLoading, setLoading] = useState(true)
  const [resolvedOrgJwt, setResolvedOrgJwt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [accessibleProjects, setAccessibleProjects] = useState<CloudProjectSummary[]>([])
  const [accessibleProjectsLoading, setAccessibleProjectsLoading] = useState(true)
  const [accessibleProjectsError, setAccessibleProjectsError] = useState<string | null>(null)
  const [resolvedProjectsJwt, setResolvedProjectsJwt] = useState<string | null>(null)
  // Keyed by org id, so a name can never be shown under another org's id.
  const [orgLookups, setOrgLookups] = useState<OrgLookups>(NO_ORG_LOOKUPS)
  // Bumped by every load of the org list. That list cannot say anything about
  // a looked-up org (renamed, access taken away), so each one still on screen
  // is asked for again — while its last answer stays up.
  const [orgLookupEpoch, setOrgLookupEpoch] = useState(0)
  const orgLookupAskedRef = useRef(new Map<number, string>())
  const currentJwtRef = useRef(jwt)
  useEffect(() => { currentJwtRef.current = jwt }, [jwt])
  const orgRequestRef = useRef(0)
  const projectsRequestRef = useRef(0)
  // Route changes update org scope in the dedicated effect below; they must
  // not recreate `refresh` and refetch the membership directory. Keep the
  // latest path in a ref so an explicit/account-driven refresh can still
  // respect whichever URL is authoritative when its request resolves.
  const pathnameRef = useRef(location.pathname)
  pathnameRef.current = location.pathname
  const projectsInFlightRef = useRef<{
    jwt: string
    requestId: number
    promise: Promise<CloudProjectSummary[]>
  } | null>(null)

  const refresh = useCallback(async (): Promise<OrgSummary[]> => {
    const requestId = ++orgRequestRef.current
    if (sessionLoading) {
      setLoading(true)
      return []
    }
    if (!jwt) {
      setOrgs([])
      setActiveOrgId(null)
      setResolvedOrgJwt(null)
      setLoading(false)
      return []
    }
    // AQU-885: the token's `exp` is knowable without a round-trip, so don't
    // spend a doomed request (and a 401) on a session we already know is dead.
    // Signal the expiry instead and let ExpiredSessionGate / the AQU-293 banner
    // drive re-auth — the previous behavior rendered an empty all-orgs
    // dashboard with no org picker and no explanation.
    if (isJwtExpired(jwt)) {
      setOrgs([])
      setActiveOrgId(null)
      setResolvedOrgJwt(jwt)
      setLoading(false)
      void notifySessionExpiredIfCurrent(jwt)
      return []
    }
    setLoading(true); setError(null)
    try {
      const list = await listMyOrgs(jwt)
      if (orgRequestRef.current !== requestId) return []
      setOrgs(list)
      setOrgLookupEpoch((epoch) => epoch + 1)
      // When the URL already names an org, don't clamp away from it here —
      // OrgRouteGate owns unauthorized/missing UX. Only auto-pick when the
      // path isn't driving org context (project routes, etc.).
      const fromPath = parseOrgPath(pathnameRef.current)
      if (fromPath) return list
      setActiveOrgId((cur) =>
        list.length === 0 ? null
        : list.length === 1 ? list[0].id
        : cur != null && list.some((o) => o.id === cur) ? cur
        : null
      )
      return list
    } catch (e) {
      if (orgRequestRef.current !== requestId) return []
      setOrgs([])
      setActiveOrgId(null)
      if (e instanceof UserError && e.category === "session-expired") {
        // Guarded: a 401 from a JWT that re-login has since replaced must not
        // re-raise the banner (see lib/frontier/session-expiry.ts).
        void notifySessionExpiredIfCurrent(jwt)
      }
      setError(e instanceof Error ? e.message : String(e))
      return []
    } finally {
      if (orgRequestRef.current === requestId) {
        setResolvedOrgJwt(jwt)
        setLoading(false)
      }
    }
  }, [jwt, sessionLoading])

  useEffect(() => { void refresh() }, [refresh])

  // Fetch the accessible-project directory once per account. Previously the
  // provider, sidebar, and dashboard each issued this same expensive request,
  // and this provider issued it twice as `orgs` changed during startup.
  const refreshAccessibleProjects = useCallback(async (): Promise<CloudProjectSummary[]> => {
    if (sessionLoading) {
      setAccessibleProjectsLoading(true)
      return []
    }
    if (!jwt) {
      projectsRequestRef.current += 1
      projectsInFlightRef.current = null
      setAccessibleProjects([])
      setAccessibleProjectsError(null)
      setResolvedProjectsJwt(null)
      setAccessibleProjectsLoading(false)
      return []
    }
    // AQU-885: same short-circuit as the org fetch — an expired token can only
    // produce a 401 here, and swallowing that 401 is what made the directory
    // look empty rather than unauthenticated.
    if (isJwtExpired(jwt)) {
      projectsRequestRef.current += 1
      projectsInFlightRef.current = null
      setAccessibleProjects([])
      setAccessibleProjectsError(null)
      setResolvedProjectsJwt(jwt)
      setAccessibleProjectsLoading(false)
      return []
    }

    // Account/session hydration can briefly re-enter `loading` while retaining
    // the same JWT. Reuse the pending directory request rather than invalidating
    // it and issuing an identical GET when hydration settles again.
    const pending = projectsInFlightRef.current
    if (pending?.jwt === jwt) return pending.promise

    const requestId = ++projectsRequestRef.current
    setAccessibleProjectsLoading(true)
    // AQU-883: clear the previous failure up front so a retry drops consumers
    // back through their loading state instead of leaving a stale error card
    // on screen next to a spinner.
    setAccessibleProjectsError(null)
    const promise = (async () => {
      try {
        const result = await fetchAccessibleProjectsResult(jwt)
        if (!result.ok) {
          if (result.reason === "unauthenticated") {
            void notifySessionExpiredIfCurrent(jwt)
            throw new UserError(401, "")
          }
          if (result.reason === "forbidden") throw new UserError(403, "")
          if (result.reason === "unreachable") throw new Error("Failed to fetch")
          throw new UserError(result.status ?? 500, "")
        }
        const projects = result.projects
        if (projectsRequestRef.current !== requestId) return []
        setAccessibleProjects(projects)
        return projects
      } catch (e) {
        // AQU-883: this used to swallow every failure into an empty list, so a
        // blocked/401/5xx directory fetch was indistinguishable from "you have
        // no shared projects" — guest orgs and shared projects just vanished.
        if (projectsRequestRef.current === requestId) {
          setAccessibleProjects([])
          setAccessibleProjectsError(e instanceof Error ? e.message : String(e))
        }
        return []
      } finally {
        if (projectsInFlightRef.current?.requestId === requestId) {
          projectsInFlightRef.current = null
        }
        if (projectsRequestRef.current === requestId) {
          setResolvedProjectsJwt(jwt)
          setAccessibleProjectsLoading(false)
        }
      }
    })()
    projectsInFlightRef.current = { jwt, requestId, promise }
    return promise
  }, [jwt, sessionLoading])

  useEffect(() => { void refreshAccessibleProjects() }, [refreshAccessibleProjects])

  // AQU-882: `refresh()` clears `error` before re-fetching, so a retry drops
  // consumers back through their loading state rather than leaving the stale
  // failure on screen next to a spinner.
  const retryOrgLoad = useCallback(async (): Promise<void> => {
    await Promise.all([refresh(), refreshAccessibleProjects()])
  }, [refresh, refreshAccessibleProjects])

  // AQU-473: derive guest orgs from the shared project directory instead of
  // refetching it whenever the member-org list changes.
  const guestOrgs = useMemo(() => {
    const memberOrgIds = new Set(orgs.map((o) => o.id))
    const seen = new Map<number, GuestOrg>()
    for (const p of accessibleProjects) {
      if (p.orgId == null || memberOrgIds.has(p.orgId)) continue
      if (!seen.has(p.orgId)) seen.set(p.orgId, { id: p.orgId, name: p.orgName ?? null })
    }
    return Array.from(seen.values())
  }, [accessibleProjects, orgs])

  const requestOrgLookup = useCallback((id: number) => {
    if (!jwt) return
    const asked = orgLookupAskedRef.current
    const ask = `${orgLookupEpoch}\0${jwt}`
    if (asked.get(id) === ask) return
    asked.set(id, ask)
    const settle = (org: OrgSummary | null | undefined) => {
      // Superseded by a later ask for this org, or the account changed while
      // the request was out.
      if (asked.get(id) !== ask || currentJwtRef.current !== jwt) return
      setOrgLookups((prev) => {
        const known = prev.jwt === jwt ? prev.byId : NO_ORG_LOOKUPS.byId
        // A re-check that failed outright says nothing new: keep the last answer.
        const answer = org === undefined ? known.get(id) ?? null : org
        const byId = new Map(known)
        byId.set(id, answer)
        return { jwt, byId }
      })
    }
    void getOrg(jwt, id).then(settle, () => settle(undefined))
  }, [jwt, orgLookupEpoch])

  const lookedUpOrg = useCallback((id: number): OrgSummary | null | undefined => {
    // Signed out there is nobody to ask, so nothing is ever pending.
    if (!jwt) return null
    return orgLookups.jwt === jwt ? orgLookups.byId.get(id) : undefined
  }, [jwt, orgLookups])

  // When the URL names an org that is neither a membership nor a guest org
  // (platform-admin catalog), look it up so the switcher trigger can show the
  // name without pulling the whole tenancy into `orgs`. Wait for the project
  // directory so a guest org is not probed as a catalog row.
  useEffect(() => {
    if (!jwt || isLoading || accessibleProjectsLoading) return
    if (activeOrgId == null) return
    if (orgs.some((o) => o.id === activeOrgId)) return
    if (guestOrgs.some((o) => o.id === activeOrgId)) return
    requestOrgLookup(activeOrgId)
  }, [jwt, isLoading, accessibleProjectsLoading, activeOrgId, orgs, guestOrgs, requestOrgLookup])

  // Path is authoritative on `/orgs/...`. localStorage only resumes `/`.
  useEffect(() => {
    const parsed = parseOrgPath(location.pathname)
    if (!parsed) return
    if (parsed.orgKey === ALL_ORGS_PARAM) {
      setActiveOrgId(null)
      return
    }
    setActiveOrgId(parsed.orgKey)
  }, [location.pathname])

  // Persist for `/` resume. Skip writing a stale id when the URL names an
  // org the user can't access — OrgRouteGate shows not-found, and we don't
  // want reload to resurrect that id as the resume target. Guest + member
  // orgs are both "known".
  useEffect(() => {
    const parsed = parseOrgPath(location.pathname)
    if (parsed?.orgKey === ALL_ORGS_PARAM) {
      localStorage.setItem(ORG_STORAGE_KEY, ALL_ORGS_PARAM)
      return
    }
    if (typeof parsed?.orgKey === "number") {
      const known =
        orgs.some((o) => o.id === parsed.orgKey) ||
        guestOrgs.some((o) => o.id === parsed.orgKey) ||
        lookedUpOrg(parsed.orgKey) != null
      // Still loading membership — don't clobber storage yet.
      if (isLoading) return
      if (!known) return
      localStorage.setItem(ORG_STORAGE_KEY, String(parsed.orgKey))
      return
    }
    // FRO-367: off org paths, persist only the null (clamped) case. Explicit
    // selections persist in the setters below; a non-null id that reaches
    // state without a setter is the single-org auto-select in refresh(),
    // which is a default, not a choice — persisting it would keep a user
    // scoped to their original org after they join a second one.
    if (activeOrgId == null) localStorage.setItem(ORG_STORAGE_KEY, ALL_ORGS_PARAM)
  }, [activeOrgId, guestOrgs, lookedUpOrg, isLoading, location.pathname, orgs])

  const setActiveOrg = useCallback((id: number) => {
    setActiveOrgId(id)
    localStorage.setItem(ORG_STORAGE_KEY, String(id))
  }, [])

  const setAllOrgs = useCallback(() => {
    setActiveOrgId(null)
    localStorage.setItem(ORG_STORAGE_KEY, ALL_ORGS_PARAM)
  }, [])

  const orgsReady = !sessionLoading && resolvedOrgJwt === jwt
  const projectsReady = !sessionLoading && resolvedProjectsJwt === jwt
  // A JWT change is visible during render, before the effects above can clear
  // their previous-account state. Mask that state at the provider boundary so
  // consumers cannot paint an old directory merely because they forgot to
  // honor the accompanying loading flag perfectly.
  const visibleOrgs = orgsReady ? orgs : []
  const visibleAccessibleProjects = projectsReady ? accessibleProjects : []
  // Every project list in the app is drawn from this directory, so it is what
  // a page opened from one of them can paint before its own read answers
  // (see project-record-seed.ts). Masked the same way: never the last account's.
  useEffect(() => {
    rememberListedProjects(projectsReady ? accessibleProjects : [])
  }, [projectsReady, accessibleProjects])
  const visibleGuestOrgs = orgsReady && projectsReady ? guestOrgs : []
  const resolvedMemberOrg = visibleOrgs.find((org) => org.id === activeOrgId) ?? null
  // A confirmed membership is safe as soon as the org directory resolves.
  // Any other id may be a guest org, whose access is known only after the
  // project directory resolves; keep that id masked in the meantime so guest
  // pages cannot issue speculative requests during an account switch.
  const visibleActiveOrgId = orgsReady && (resolvedMemberOrg != null || projectsReady)
    ? activeOrgId
    : null
  const isAllOrgs = visibleOrgs.length > 1 && visibleActiveOrgId == null
  // A membership wins, then a guest org (below — never presented as
  // `activeOrg`); only an org that is neither is named by its lookup.
  const activeOrg = visibleActiveOrgId == null
    ? null
    : resolvedMemberOrg ??
      (visibleGuestOrgs.some((g) => g.id === visibleActiveOrgId) ? null : lookedUpOrg(visibleActiveOrgId) ?? null)
  // AQU-790: only a guest org when the active id is not one of the caller's
  // memberships — a membership always wins (never misrepresent role).
  const activeGuestOrg =
    visibleActiveOrgId != null && activeOrg == null
      ? visibleGuestOrgs.find((g) => g.id === visibleActiveOrgId) ?? null
      : null

  return (
    <OrgContext.Provider value={{
      orgs: visibleOrgs,
      activeOrgId: visibleActiveOrgId,
      activeOrg,
      activeGuestOrg,
      isAllOrgs,
      guestOrgs: visibleGuestOrgs,
      accessibleProjects: visibleAccessibleProjects,
      accessibleProjectsLoading: accessibleProjectsLoading || !projectsReady,
      accessibleProjectsError: projectsReady ? accessibleProjectsError : null,
      setActiveOrg,
      setAllOrgs,
      isLoading: isLoading || !orgsReady,
      error: orgsReady ? error : null,
      refresh,
      refreshAccessibleProjects,
      retryOrgLoad,
      lookedUpOrg,
      requestOrgLookup,
    }}>
      {children}
    </OrgContext.Provider>
  )
}

export function useActiveOrg(): OrgContextValue {
  const v = useContext(OrgContext)
  if (!v) throw new Error("useActiveOrg must be used within <OrgProvider>")
  return v
}

/**
 * Non-throwing variant of {@link useActiveOrg}. Returns `null` when rendered
 * outside an `<OrgProvider>` instead of throwing. Use on surfaces that can be
 * embedded without org context (or unit-tested in isolation) and only need the
 * active org opportunistically — e.g. MembersTab, which falls back to a
 * free-text add-member field when no org roster is available.
 */
export function useActiveOrgOptional(): OrgContextValue | null {
  return useContext(OrgContext)
}
