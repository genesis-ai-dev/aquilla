import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  listSessions, addSession, activateSession, removeSession,
  loadActiveSession, subscribeSession, sessionKey,
  type SessionSummary,
} from "@/lib/frontier/session-store"
import { clearAllLocalData } from "@/lib/store/project-index"
import type { FrontierSession } from "@/lib/frontier/types"

function useAccountsState(enabled = true) {
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

  // `loading` means "the first read hasn't landed yet", NOT "a refresh is in
  // flight". Re-entering it on every notification blanked whole pages behind
  // their loading gate mid-interaction: an email backfill (or any session
  // write) would unmount the open account menu along with the rest of the
  // page, destroying its local `open` state. Revalidations are silent; state
  // swaps atomically when the read resolves.
  const refresh = useCallback(async () => {
    if (!enabled) return
    const [a, s] = await Promise.all([loadActiveSession(), listSessions()])
    const key = a ? sessionKey(a) : null
    if (prevKeyRef.current !== undefined && prevKeyRef.current !== key) {
      qc.clear()
    }
    prevKeyRef.current = key
    setActive(a)
    setSessions(s)
    setLoading(false)
  }, [enabled, qc])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    refresh().catch(() => { if (!cancelled) setLoading(false) })
    const un = subscribeSession(() => {
      void refresh().catch(() => { if (!cancelled) setLoading(false) })
    })
    return () => { cancelled = true; un() }
  }, [enabled, refresh])

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

type AccountsContextValue = ReturnType<typeof useAccountsState>

const AccountsContext = createContext<AccountsContextValue | null>(null)

/**
 * Loads the browser's active account once and shares it with every session
 * consumer. Without this provider each useFrontierSession/useAccounts caller
 * independently read IndexedDB and subscribed to account changes, producing
 * staggered first-paint states and unnecessary storage work.
 */
export function AccountsProvider({ children }: { children: ReactNode }) {
  const value = useAccountsState()
  return createElement(AccountsContext.Provider, { value }, children)
}

export function useAccounts() {
  const shared = useContext(AccountsContext)
  // Keep hooks/components independently renderable in focused tests and small
  // standalone entry points. The disabled local state performs no IDB reads or
  // subscriptions when the app-level provider is present.
  const local = useAccountsState(shared == null)
  return shared ?? local
}
