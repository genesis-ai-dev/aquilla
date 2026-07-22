import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"

const STORAGE_KEY = "org:active"
const ALL_ORGS_VALUE = "all"

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
  isAllOrgs: boolean
  /** Orgs reached only through a direct project grant (no org membership). */
  guestOrgs: GuestOrg[]
  /** One app-wide project discovery result, shared by dashboard/sidebar users. */
  accessibleProjects: CloudProjectSummary[]
  accessibleProjectsLoading: boolean
  setActiveOrg: (id: number) => void
  setAllOrgs: () => void
  isLoading: boolean
  error: string | null
  /** Fetch the latest org list. Returns the freshly loaded orgs so callers
   *  that need the result immediately don't race against a stale closure. */
  refresh: () => Promise<OrgSummary[]>
  refreshAccessibleProjects: () => Promise<CloudProjectSummary[]>
}

const OrgContext = createContext<OrgContextValue | null>(null)

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session, loading: sessionLoading } = useFrontierSession()
  const location = useLocation()
  const jwt = session?.jwt ?? null
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [activeOrgId, setActiveOrgId] = useState<number | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw || raw === ALL_ORGS_VALUE) return null
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
  const [resolvedProjectsJwt, setResolvedProjectsJwt] = useState<string | null>(null)
  const orgRequestRef = useRef(0)
  const projectsRequestRef = useRef(0)

  const refresh = useCallback(async (): Promise<OrgSummary[]> => {
    const requestId = ++orgRequestRef.current
    if (sessionLoading) {
      setLoading(true)
      return []
    }
    if (!jwt) {
      setOrgs([])
      setResolvedOrgJwt(null)
      setLoading(false)
      return []
    }
    setLoading(true); setError(null)
    try {
      const list = await listMyOrgs(jwt)
      if (orgRequestRef.current !== requestId) return []
      setOrgs(list)
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
        notifySessionExpired()
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
    const requestId = ++projectsRequestRef.current
    if (sessionLoading) {
      setAccessibleProjectsLoading(true)
      return []
    }
    if (!jwt) {
      setAccessibleProjects([])
      setResolvedProjectsJwt(null)
      setAccessibleProjectsLoading(false)
      return []
    }
    setAccessibleProjectsLoading(true)
    try {
      const projects = await fetchAccessibleProjects(jwt)
      if (projectsRequestRef.current !== requestId) return []
      setAccessibleProjects(projects)
      return projects
    } catch {
      if (projectsRequestRef.current === requestId) setAccessibleProjects([])
      return []
    } finally {
      if (projectsRequestRef.current === requestId) {
        setResolvedProjectsJwt(jwt)
        setAccessibleProjectsLoading(false)
      }
    }
  }, [jwt, sessionLoading])

  useEffect(() => { void refreshAccessibleProjects() }, [refreshAccessibleProjects])

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

  // FRO-367: persist the CLAMP path as an effect (state updaters must stay
  // pure): when another tab switches to an account that can't see the org this
  // tab had active, refresh() drops it from state — but the stale id used to
  // survive in localStorage, so a reload resurrected it (→ the "org I can't
  // access" 403). Only the null (clamped) case is written here — explicit
  // selections persist in the setters / URL handler below. A non-null id that
  // reaches state without a setter is the single-org auto-select in refresh(),
  // which is a default, not a choice: persisting it would keep a user scoped
  // to their original org after they join a second one.
  useEffect(() => {
    if (activeOrgId == null) localStorage.setItem(STORAGE_KEY, ALL_ORGS_VALUE)
  }, [activeOrgId])

  useEffect(() => {
    if (location.pathname !== "/") return
    const value = new URLSearchParams(location.search).get("org")
    if (!value) return
    if (value === ALL_ORGS_VALUE) {
      setActiveOrgId(null)
      localStorage.setItem(STORAGE_KEY, ALL_ORGS_VALUE)
      return
    }
    const nextId = Number(value)
    if (!Number.isFinite(nextId)) return
    setActiveOrgId(nextId)
    localStorage.setItem(STORAGE_KEY, String(nextId))
  }, [location.pathname, location.search])

  const setActiveOrg = useCallback((id: number) => {
    setActiveOrgId(id)
    localStorage.setItem(STORAGE_KEY, String(id))
  }, [])

  const setAllOrgs = useCallback(() => {
    setActiveOrgId(null)
    localStorage.setItem(STORAGE_KEY, ALL_ORGS_VALUE)
  }, [])

  const isAllOrgs = orgs.length > 1 && activeOrgId == null
  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null
  const orgsReady = !sessionLoading && (jwt == null || resolvedOrgJwt === jwt)
  const projectsReady = !sessionLoading && (jwt == null || resolvedProjectsJwt === jwt)

  return (
    <OrgContext.Provider value={{
      orgs,
      activeOrgId,
      activeOrg,
      isAllOrgs,
      guestOrgs,
      accessibleProjects,
      accessibleProjectsLoading: accessibleProjectsLoading || !projectsReady,
      setActiveOrg,
      setAllOrgs,
      isLoading: isLoading || !orgsReady,
      error,
      refresh,
      refreshAccessibleProjects,
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
