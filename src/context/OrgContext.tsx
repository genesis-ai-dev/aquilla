import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { useLocation } from "react-router-dom"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"

const STORAGE_KEY = "org:active"
const ALL_ORGS_VALUE = "all"

interface OrgContextValue {
  orgs: OrgSummary[]
  activeOrgId: number | null
  activeOrg: OrgSummary | null
  isAllOrgs: boolean
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

  const refresh = useCallback(async (): Promise<OrgSummary[]> => {
    if (!jwt) { setOrgs([]); return [] }
    setLoading(true); setError(null)
    try {
      const list = await listMyOrgs(jwt)
      setOrgs(list)
      setActiveOrgId((cur) => {
        if (list.length === 0) return null
        if (list.length === 1) return list[0].id
        if (cur != null && list.some((o) => o.id === cur)) return cur
        return null
      })
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
    <OrgContext.Provider value={{ orgs, activeOrgId, activeOrg, isAllOrgs, setActiveOrg, setAllOrgs, isLoading, error, refresh }}>
      {children}
    </OrgContext.Provider>
  )
}

export function useActiveOrg(): OrgContextValue {
  const v = useContext(OrgContext)
  if (!v) throw new Error("useActiveOrg must be used within <OrgProvider>")
  return v
}
