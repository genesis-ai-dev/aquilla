import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"

const STORAGE_KEY = "org:active"

interface OrgContextValue {
  orgs: OrgSummary[]
  activeOrgId: number | null
  activeOrg: OrgSummary | null
  setActiveOrg: (id: number) => void
  isLoading: boolean
  error: string | null
  /** Fetch the latest org list. Returns the freshly loaded orgs so callers
   *  that need the result immediately don't race against a stale closure. */
  refresh: () => Promise<OrgSummary[]>
}

const OrgContext = createContext<OrgContextValue | null>(null)

export function OrgProvider({ children }: { children: ReactNode }) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [orgs, setOrgs] = useState<OrgSummary[]>([])
  const [activeOrgId, setActiveOrgId] = useState<number | null>(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? Number(raw) : null
  })
  const [isLoading, setLoading] = useState<boolean>(!!jwt)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<OrgSummary[]> => {
    if (!jwt) { setOrgs([]); return [] }
    setLoading(true); setError(null)
    try {
      const list = await listMyOrgs(jwt)
      setOrgs(list)
      setActiveOrgId((cur) => (cur != null && list.some((o) => o.id === cur) ? cur : list[0]?.id ?? null))
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

  const setActiveOrg = useCallback((id: number) => {
    setActiveOrgId(id)
    localStorage.setItem(STORAGE_KEY, String(id))
  }, [])

  const activeOrg = orgs.find((o) => o.id === activeOrgId) ?? null

  return (
    <OrgContext.Provider value={{ orgs, activeOrgId, activeOrg, setActiveOrg, isLoading, error, refresh }}>
      {children}
    </OrgContext.Provider>
  )
}

export function useActiveOrg(): OrgContextValue {
  const v = useContext(OrgContext)
  if (!v) throw new Error("useActiveOrg must be used within <OrgProvider>")
  return v
}
