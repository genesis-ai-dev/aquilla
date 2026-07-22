import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects } from "@/lib/sync/cloud-projects"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
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
  // Seed from localStorage for non-/orgs routes (e.g. /project/...)/editor until
  // the user navigates into an org shell; `/orgs/...` always wins (below).
  const [activeOrgId, setActiveOrgId] = useState<number | null>(() => {
    const raw = localStorage.getItem(ORG_STORAGE_KEY)
    if (!raw || raw === ALL_ORGS_PARAM) return null
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
      // When the URL already names an org, don't clamp away from it here —
      // OrgRouteGate owns unauthorized/missing UX. Only auto-pick when the
      // path isn't driving org context (project routes, etc.).
      const fromPath = parseOrgPath(location.pathname)
      if (fromPath) return list
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
  }, [jwt, location.pathname])

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
        guestOrgs.some((o) => o.id === parsed.orgKey)
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
  }, [activeOrgId, guestOrgs, isLoading, location.pathname, orgs])

  const setActiveOrg = useCallback((id: number) => {
    setActiveOrgId(id)
    localStorage.setItem(ORG_STORAGE_KEY, String(id))
  }, [])

  const setAllOrgs = useCallback(() => {
    setActiveOrgId(null)
    localStorage.setItem(ORG_STORAGE_KEY, ALL_ORGS_PARAM)
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
