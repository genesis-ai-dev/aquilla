import { useEffect, useRef, useState, useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  listSessions, addSession, activateSession, removeSession,
  loadActiveSession, subscribeSession, sessionKey,
  type SessionSummary,
} from "@/lib/frontier/session-store"
import { clearAllLocalData } from "@/lib/store/project-index"
import type { FrontierSession } from "@/lib/frontier/types"

export function useAccounts() {
  const qc = useQueryClient()
  const [active, setActive] = useState<FrontierSession | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  // Active session key seen by the last refresh. `undefined` = not yet loaded
  // (so the first load never triggers a clear). When a refresh observes a
  // DIFFERENT active key than before — e.g. another tab switched accounts and
  // pinged us (FRO-367) — drop this tab's React Query cache so no prior-account
  // data survives the switch. The switching tab clears via `activate` too;
  // both clears are idempotent.
  const prevKeyRef = useRef<string | null | undefined>(undefined)

  const refresh = useCallback(async () => {
    const [a, s] = await Promise.all([loadActiveSession(), listSessions()])
    const key = a ? sessionKey(a) : null
    if (prevKeyRef.current !== undefined && prevKeyRef.current !== key) {
      qc.clear()
    }
    prevKeyRef.current = key
    setActive(a)
    setSessions(s)
    setLoading(false)
  }, [qc])

  useEffect(() => {
    let cancelled = false
    refresh().catch(() => { if (!cancelled) setLoading(false) })
    const un = subscribeSession(() => { refresh() })
    return () => { cancelled = true; un() }
  }, [refresh])

  const add = useCallback(async (s: FrontierSession) => { await addSession(s) }, [])
  // Switching accounts drops the prior account's cached projects (thin
  // client: the server re-supplies them for the newly-active session) and
  // wipes the in-memory React Query cache so no prior-account data lingers.
  const activate = useCallback(async (key: string) => {
    await activateSession(key)
    await clearAllLocalData()
    qc.clear()
  }, [qc])
  // Removing the active account auto-promotes another session; clear the
  // query cache so the UI reflects whatever account is now active (or none).
  const remove = useCallback(async (key: string) => {
    await removeSession(key)
    qc.clear()
  }, [qc])

  return { active, sessions, loading, add, activate, remove }
}
