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
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { desktopConnectivity, useDesktopConnectivity } from "@/lib/offline/connectivity"
import { readOrgDirectory, rememberOrgDirectory } from "@/lib/offline/org-directory-cache"
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
   * Desktop: the server couldn't be reached (or the session has lapsed), so
   * `orgs` / `guestOrgs` are the lists last loaded online (org-directory-cache.ts)
   * and `accessibleProjects` is empty. Org pages show only what's downloaded.
   */
  offline: boolean
}

const OrgContext = createContext<OrgContextValue | null>(null)

/** Desktop: how often the cached (offline) lists retry the server. */
const OFFLINE_RETRY_MS = 30_000

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session, loading: sessionLoading } = useFrontierSession()
  const location = useLocation()
  const jwt = session?.jwt ?? null
  const username = session?.username ?? null
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
  const [hydratedOrg, setHydratedOrg] = useState<OrgSummary | null>(null)
  // Desktop offline fallbacks: the org list and the guest orgs come from the
  // last online load instead of the server (see `offline` above).
  const [orgsFromCache, setOrgsFromCache] = useState(false)
  const [cachedGuestOrgs, setCachedGuestOrgs] = useState<GuestOrg[] | null>(null)
  // Read by the fetches at call time: a retry from the cached lists keeps them
  // on screen instead of dropping consumers into their loading state.
  const orgsFromCacheRef = useRef(false)
  useEffect(() => { orgsFromCacheRef.current = orgsFromCache }, [orgsFromCache])
  // Desktop, expired session: the cached lists stand in only while the probe
  // says offline. Online, sign-in follows (ExpiredSessionGate); before the
  // first probe, wait rather than paint either answer.
  const online = useDesktopConnectivity()
  const expiredCache: "use" | "wait" | "skip" =
    !isTauriRuntime() || !jwt || !isJwtExpired(jwt) ? "skip"
    : online === false ? "use"
    : online == null ? "wait"
    : "skip"
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
    // When the URL already names an org, don't clamp away from it here —
    // OrgRouteGate owns unauthorized/missing UX. Only auto-pick when the
    // path isn't driving org context (project routes, etc.).
    const applyOrgs = (list: OrgSummary[]) => {
      setOrgs(list)
      if (parseOrgPath(pathnameRef.current)) return
      setActiveOrgId((cur) =>
        list.length === 0 ? null
        : list.length === 1 ? list[0].id
        : cur != null && list.some((o) => o.id === cur) ? cur
        : null
      )
    }
    // Desktop only: the lists last loaded online, used when the server can't be.
    const cached = isTauriRuntime() && username ? readOrgDirectory(username) : null
    // `orgsFromCache` is cleared only once the server answers: a retry while
    // still unreachable must not flash the online pages for its duration.
    if (sessionLoading) {
      setLoading(true)
      return []
    }
    if (!jwt) {
      setOrgs([])
      setActiveOrgId(null)
      setOrgsFromCache(false)
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
      // Desktop: a session that lapsed in the field still reaches its
      // downloaded projects — sign-in can't happen until it's back online.
      if (cached && expiredCache === "wait") {
        setLoading(true)
        return []
      }
      if (cached && expiredCache === "use") {
        applyOrgs(cached.orgs)
        setOrgsFromCache(true)
      } else {
        setOrgs([])
        setActiveOrgId(null)
        setOrgsFromCache(false)
      }
      setResolvedOrgJwt(jwt)
      setLoading(false)
      void notifySessionExpiredIfCurrent(jwt)
      return cached && expiredCache === "use" ? cached.orgs : []
    }
    const retryingFromCache = orgsFromCacheRef.current
    if (!retryingFromCache) setLoading(true)
    setError(null)
    try {
      const list = await listMyOrgs(jwt)
      if (orgRequestRef.current !== requestId) return []
      applyOrgs(list)
      setOrgsFromCache(false)
      // Leaving the cached view: the online pages must wait for a directory
      // request that is still out rather than paint it as empty.
      if (retryingFromCache && projectsInFlightRef.current) setAccessibleProjectsLoading(true)
      return list
    } catch (e) {
      if (orgRequestRef.current !== requestId) return []
      // A UserError is the server answering; anything else is a request that
      // never got one (offline, timeout) — the case the cache is for.
      if (cached && !(e instanceof UserError)) {
        applyOrgs(cached.orgs)
        setOrgsFromCache(true)
        return cached.orgs
      }
      setOrgs([])
      setActiveOrgId(null)
      setOrgsFromCache(false)
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
  }, [jwt, sessionLoading, username, expiredCache])

  useEffect(() => { void refresh() }, [refresh])

  // Fetch the accessible-project directory once per account. Previously the
  // provider, sidebar, and dashboard each issued this same expensive request,
  // and this provider issued it twice as `orgs` changed during startup.
  const refreshAccessibleProjects = useCallback(async (): Promise<CloudProjectSummary[]> => {
    const cached = isTauriRuntime() && username ? readOrgDirectory(username) : null
    if (sessionLoading) {
      setAccessibleProjectsLoading(true)
      return []
    }
    if (!jwt) {
      projectsRequestRef.current += 1
      projectsInFlightRef.current = null
      setAccessibleProjects([])
      setAccessibleProjectsError(null)
      setCachedGuestOrgs(null)
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
      if (cached && expiredCache === "wait") {
        setAccessibleProjectsLoading(true)
        return []
      }
      setAccessibleProjects([])
      setAccessibleProjectsError(null)
      setCachedGuestOrgs(cached && expiredCache === "use" ? cached.guestOrgs : null)
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
    // `cachedGuestOrgs` stays until the server answers (see `orgsFromCache`).
    if (!orgsFromCacheRef.current) setAccessibleProjectsLoading(true)
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
        setCachedGuestOrgs(null)
        return projects
      } catch (e) {
        // AQU-883: this used to swallow every failure into an empty list, so a
        // blocked/401/5xx directory fetch was indistinguishable from "you have
        // no shared projects" — guest orgs and shared projects just vanished.
        if (projectsRequestRef.current === requestId) {
          setAccessibleProjects([])
          // Unreachable: the cached guest orgs stand in, but only if the org
          // list is cached too (`offline`). When `/orgs` answered, this is a
          // directory failure like any other and the error is what shows.
          setCachedGuestOrgs(cached && !(e instanceof UserError) ? cached.guestOrgs : null)
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
  }, [jwt, sessionLoading, username, expiredCache])

  useEffect(() => { void refreshAccessibleProjects() }, [refreshAccessibleProjects])

  // AQU-882: `refresh()` clears `error` before re-fetching, so a retry drops
  // consumers back through their loading state rather than leaving the stale
  // failure on screen next to a spinner.
  const retryOrgLoad = useCallback(async (): Promise<void> => {
    await Promise.all([refresh(), refreshAccessibleProjects()])
  }, [refresh, refreshAccessibleProjects])

  // AQU-473: derive guest orgs from the shared project directory instead of
  // refetching it whenever the member-org list changes.
  // Offline is decided by the org list alone: a directory that failed while
  // `/orgs` answered is the AQU-883 error state, not the offline pages.
  const offline = orgsFromCache
  const guestOrgs = useMemo(() => {
    if (offline && cachedGuestOrgs) return cachedGuestOrgs.filter((g) => !orgs.some((o) => o.id === g.id))
    const memberOrgIds = new Set(orgs.map((o) => o.id))
    const seen = new Map<number, GuestOrg>()
    for (const p of accessibleProjects) {
      if (p.orgId == null || memberOrgIds.has(p.orgId)) continue
      if (!seen.has(p.orgId)) seen.set(p.orgId, { id: p.orgId, name: p.orgName ?? null })
    }
    return Array.from(seen.values())
  }, [accessibleProjects, cachedGuestOrgs, offline, orgs])

  // Desktop: keep the last good lists for offline use, and leave the cached
  // ones as soon as the server answers again.
  useEffect(() => {
    if (!isTauriRuntime() || !username || !jwt || isJwtExpired(jwt)) return
    if (offline || isLoading || accessibleProjectsLoading || error || accessibleProjectsError) return
    if (resolvedOrgJwt !== jwt || resolvedProjectsJwt !== jwt) return
    rememberOrgDirectory(username, { orgs, guestOrgs })
  }, [username, jwt, offline, isLoading, accessibleProjectsLoading, error, accessibleProjectsError, resolvedOrgJwt, resolvedProjectsJwt, orgs, guestOrgs])

  // Leave the cached lists once the server answers again. The change event
  // covers a reconnect; the timer covers a failure the probe never saw (a blip
  // between its polls, a timeout, a captive portal) — or a reconnect retry
  // that failed — after which no change event will come.
  useEffect(() => {
    if (!offline || !jwt || isJwtExpired(jwt)) return
    const unsubscribe = desktopConnectivity.subscribe((online) => {
      if (online) void retryOrgLoad()
    })
    const timer = setInterval(() => {
      if (desktopConnectivity.current() !== false) void retryOrgLoad()
    }, OFFLINE_RETRY_MS)
    return () => {
      unsubscribe()
      clearInterval(timer)
    }
  }, [offline, jwt, retryOrgLoad])

  // When the URL names an org that is not a membership (platform-admin
  // catalog), hydrate its summary so the switcher trigger can show the name
  // without pulling the whole tenancy into `orgs`. Wait for the project
  // directory so a guest org is not probed as a catalog row.
  useEffect(() => {
    if (!jwt || isLoading || accessibleProjectsLoading) return
    if (activeOrgId == null) {
      setHydratedOrg(null)
      return
    }
    if (orgs.some((o) => o.id === activeOrgId)) {
      setHydratedOrg(null)
      return
    }
    if (guestOrgs.some((o) => o.id === activeOrgId)) {
      setHydratedOrg(null)
      return
    }
    let cancelled = false
    void getOrg(jwt, activeOrgId).then(
      (org) => {
        if (!cancelled) setHydratedOrg(org)
      },
      () => {
        if (!cancelled) setHydratedOrg(null)
      },
    )
    return () => {
      cancelled = true
    }
  }, [jwt, isLoading, accessibleProjectsLoading, activeOrgId, orgs, guestOrgs])

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
        hydratedOrg?.id === parsed.orgKey
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
  }, [activeOrgId, guestOrgs, hydratedOrg, isLoading, location.pathname, orgs])

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
  const activeOrg = visibleActiveOrgId == null ? null : resolvedMemberOrg ?? hydratedOrg
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
      // Offline, the directory failing is expected; the offline pages say so.
      accessibleProjectsError: projectsReady && !offline ? accessibleProjectsError : null,
      setActiveOrg,
      setAllOrgs,
      isLoading: isLoading || !orgsReady,
      error: orgsReady ? error : null,
      refresh,
      refreshAccessibleProjects,
      retryOrgLoad,
      offline: offline && orgsReady && projectsReady,
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
