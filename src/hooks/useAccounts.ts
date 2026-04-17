import { useEffect, useState, useCallback } from "react"
import {
  listSessions, addSession, activateSession, removeSession,
  loadActiveSession, subscribeSession,
  type SessionSummary,
} from "@/lib/frontier/session-store"
import type { FrontierSession } from "@/lib/frontier/types"

export function useAccounts() {
  const [active, setActive] = useState<FrontierSession | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    const [a, s] = await Promise.all([loadActiveSession(), listSessions()])
    setActive(a)
    setSessions(s)
    setLoading(false)
  }, [])

  useEffect(() => {
    let cancelled = false
    refresh().catch(() => { if (!cancelled) setLoading(false) })
    const un = subscribeSession(() => { refresh() })
    return () => { cancelled = true; un() }
  }, [refresh])

  const add = useCallback(async (s: FrontierSession) => { await addSession(s) }, [])
  const activate = useCallback(async (key: string) => { await activateSession(key) }, [])
  const remove = useCallback(async (key: string) => { await removeSession(key) }, [])

  return { active, sessions, loading, add, activate, remove }
}
