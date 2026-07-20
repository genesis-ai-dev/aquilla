import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects } from "@/lib/sync/cloud-projects"
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
  setActiveOrg: (id: number) => void
  setAllOrgs: () => void
  isLoading: boolean
  error: string | null
  /** Fetch the latest org list. Returns the freshly loaded orgs so callers
   *  that need the result immediately don't race against a stale closure. */
  refresh: () => Promise<OrgSummary[]>
}

const OrgContext = createContext<OrgContextValue | null>(null)

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session } = useFrontierSession()
  const location = useLocation()
  const jwt = session?.jwt ?? null
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [activeOrgId, setActiveOrgId] = useState<number | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw || raw === ALL_ORGS_VALUE) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  })
  const [isLoading, setLoading] = useState<boolean>(!!jwt)
  const [error, setError] = useState<string | null>(null)
  const [guestOrgs, setGuestOrgs] = useState<GuestOrg[]>([])
  const guestAliveRef = useRef(true)

  const refresh = useCallback(async (): Promise<OrgSummary[]> => {
    if (!jwt) { setOrgs([]); return [] }
    setLoading(true); setError(null)
    try {
      const list = await listMyOrgs(jwt)
      setOrgs(list)
      setActiveOrgId((cur) =>
        list.length === 0 ? null
        : list.length === 1 ? list[0].id
        : cur != null && list.some((o) => o.id === cur) ? cur
        : null
      )
      return list
    } catch (e) {
      if (e instanceof UserError && e.category === "session-expired") {
        notifySessionExpired()
      }
      setError(e instanceof Error ? e.message : String(e))
      return []
    } finally {
      setLoading(false)
    }
  }, [jwt])

  useEffect(() => { void refresh() }, [refresh])

  // AQU-473: derive guest orgs (accessible-project orgs the caller isn't a
  // member of) so the org switcher can surface them tagged "Guest". Race-
  // guarded like the other org-scoped effects in this file/hooks.
  const refreshGuestOrgs = useCallback(async (): Promise<void> => {
    if (!jwt) { if (guestAliveRef.current) setGuestOrgs([]); return }
    const projects = await fetchAccessibleProjects(jwt)
    if (!guestAliveRef.current) return
    const memberOrgIds = new Set(orgs.map((o) => o.id))
    const seen = new Map<number, GuestOrg>()
    for (const p of projects) {
      if (p.orgId == null || memberOrgIds.has(p.orgId)) continue
      if (!seen.has(p.orgId)) seen.set(p.orgId, { id: p.orgId, name: p.orgName ?? null })
    }
    setGuestOrgs(Array.from(seen.values()))
  }, [jwt, orgs])

  useEffect(() => {
    guestAliveRef.current = true
    return () => { guestAliveRef.current = false }
  }, [])

  useEffect(() => { void refreshGuestOrgs() }, [refreshGuestOrgs])

  // FRO-367: persist the active-org selection whenever it settles, as an
  // effect (state updaters must stay pure). This covers the clamp path: when
  // another tab switches to an account that can't see the org this tab had
  // active, refresh() drops it from state — but the stale id used to survive
  // in localStorage, so a reload resurrected it (→ the "org I can't access"
  // 403). The direct setters below also write the key; this write is
  // idempotent alongside them.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, activeOrgId == null ? ALL_ORGS_VALUE : String(activeOrgId))
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

  return (
    <OrgContext.Provider value={{ orgs, activeOrgId, activeOrg, isAllOrgs, guestOrgs, setActiveOrg, setAllOrgs, isLoading, error, refresh }}>
      {children}
    </OrgContext.Provider>
  )
}

export function useActiveOrg(): OrgContextValue {
  const v = useContext(OrgContext)
  if (!v) throw new Error("useActiveOrg must be used within <OrgProvider>")
  return v
}
