import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react"
import { listMyOrgs, type OrgSummary } from "@/lib/frontier/orgs"
import { useFrontierSession } from "@/hooks/useFrontierSession"

const STORAGE_KEY = "org:active"

interface OrgContextValue {
  orgs: OrgSummary[]
  activeOrgId: number | null
  activeOrg: OrgSummary | null
  setActiveOrg: (id: number) => void
  isLoading: boolean
  error: string | null
  refresh: () => Promise<void>
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
  const [isLoading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!jwt) { setOrgs([]); return }
    setLoading(true); setError(null)
    try {
      const list = await listMyOrgs(jwt)
      setOrgs(list)
      setActiveOrgId((cur) => (cur != null && list.some((o) => o.id === cur) ? cur : list[0]?.id ?? null))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
