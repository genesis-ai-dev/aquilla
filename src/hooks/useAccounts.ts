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
  addSession, activateSession, clearSession, removeSession,
  loadAccountsSnapshot, publishDataOwner, subscribeSession, sessionKey,
  type SessionSummary,
} from "@/lib/frontier/session-store"
import {
  activateClientDataScope,
  clearPreviousAccountData,
} from "@/lib/frontier/account-data-boundary"
import type { FrontierSession } from "@/lib/frontier/types"

export const SESSION_LOAD_TIMEOUT_MS = 5_000

async function loadSnapshotWithTimeout() {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      loadAccountsSnapshot(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Session storage did not respond")),
          SESSION_LOAD_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
  }
}

class AccountTransitionFailure extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "AccountTransitionFailure"
  }
}

function useAccountsState(enabled = true) {
  const qc = useQueryClient()
  const [active, setActive] = useState<FrontierSession | null>(null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [hydrated, setHydrated] = useState(false)
  const [loadError, setLoadError] = useState<Error | null>(null)
  const [transitionError, setTransitionError] = useState<Error | null>(null)
  const refreshRequestRef = useRef(0)
  // Active session key seen by the last refresh. `undefined` = not yet loaded
  // (so the first load never triggers a clear). When a refresh observes a
  // DIFFERENT active key than before — e.g. another tab switched accounts and
  // pinged us (FRO-367) — drop this tab's React Query cache so no prior-account
  // data survives the switch. The switching tab clears via `activate` too;
  // both clears are idempotent.
  const prevKeyRef = useRef<string | null | undefined>(undefined)

  const applySnapshot = useCallback(async (
    snapshot: Awaited<ReturnType<typeof loadAccountsSnapshot>>,
    requestId: number,
  ) => {
    if (refreshRequestRef.current !== requestId) return
    const { active: nextActive, sessions: nextSessions } = snapshot
    const key = nextActive ? sessionKey(nextActive) : null
    const previousKey = prevKeyRef.current === undefined
      ? snapshot.dataOwner
      : prevKeyRef.current
    const identityChanged = previousKey !== undefined && previousKey !== key
    const leavingAccount = identityChanged && previousKey !== null

    if (identityChanged) {
      setLoading(true)
      qc.clear()
      // A null previous key may represent a real local-only workspace. First
      // login must not erase those projects; only data owned by a prior signed
      // account is disposable during an identity transition.
      if (leavingAccount) {
        try {
          await clearPreviousAccountData()
        } catch (error) {
          throw new AccountTransitionFailure(error)
        }
        if (refreshRequestRef.current !== requestId) return
      }
    }
    // Switch owner-scoped stores before exposing the matching React identity.
    // Until this point consumers either see the prior account or the global
    // neutral loading boundary; they can never pair the new JWT with old data.
    try {
      await activateClientDataScope(key, { claimLegacy: snapshot.dataOwner === undefined })
    } catch (error) {
      throw new AccountTransitionFailure(error)
    }
    const published = await publishDataOwner(key)
    if (!published || refreshRequestRef.current !== requestId) return
    prevKeyRef.current = key
    setActive(nextActive)
    setSessions(nextSessions)
    setHydrated(true)
    setLoadError(null)
    setTransitionError(null)
    setLoading(false)
  }, [qc])

  // `loading` means "the first read hasn't landed yet", NOT "a refresh is in
  // flight". Re-entering it on every notification blanked whole pages behind
  // their loading gate mid-interaction: an email backfill (or any session
  // write) would unmount the open account menu along with the rest of the
  // page, destroying its local `open` state. Revalidations are silent; state
  // swaps atomically when the read resolves.
  const refresh = useCallback(async () => {
    if (!enabled) return
    const requestId = ++refreshRequestRef.current
    setTransitionError(null)
    try {
      const snapshot = await loadSnapshotWithTimeout()
      await applySnapshot(snapshot, requestId)
    } catch (error) {
      if (refreshRequestRef.current !== requestId) return
      const normalized = error instanceof Error ? error : new Error(String(error))
      if (error instanceof AccountTransitionFailure) setTransitionError(normalized)
      else setLoadError(normalized)
    } finally {
      if (refreshRequestRef.current === requestId) setLoading(false)
    }
  }, [applySnapshot, enabled])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void refresh()
    const un = subscribeSession(() => {
      if (!cancelled) void refresh()
    })
    return () => {
      cancelled = true
      // Invalidate an in-flight IDB read so it cannot publish into an
      // unmounted provider after its timeout or storage request resolves.
      refreshRequestRef.current += 1
      un()
    }
  }, [enabled, refresh])

  const adopt = useCallback(async (session: FrontierSession) => {
    const requestId = ++refreshRequestRef.current
    const key = sessionKey(session)
    const previousKey = prevKeyRef.current
    const identityChanged = previousKey !== undefined && previousKey !== key
    const leavingAccount = identityChanged && previousKey !== null
    setTransitionError(null)
    try {
      if (identityChanged) {
        setLoading(true)
        qc.clear()
        if (leavingAccount) {
          await clearPreviousAccountData()
          if (refreshRequestRef.current !== requestId) return
        }
      }
      await activateClientDataScope(key, { claimLegacy: previousKey === undefined })
      const published = await publishDataOwner(key)
      if (!published || refreshRequestRef.current !== requestId) return
      prevKeyRef.current = key
      setActive(session)
      setHydrated(true)
      setSessions((current) => {
        const next: SessionSummary = {
          key,
          username: session.username,
          email: session.email,
          createdAt: session.createdAt,
          active: true,
        }
        return [
          ...current.filter((candidate) => candidate.key !== key).map((candidate) => ({
            ...candidate,
            active: false,
          })),
          next,
        ]
      })
      setLoadError(null)
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      setTransitionError(normalized)
      throw normalized
    } finally {
      if (refreshRequestRef.current === requestId) setLoading(false)
    }
  }, [qc])

  const add = useCallback(async (s: FrontierSession) => {
    await addSession(s)
    await refresh()
  }, [refresh])
  // Switching accounts drops the prior account's cached projects (thin
  // client: the server re-supplies them for the newly-active session) and
  // wipes the in-memory React Query cache so no prior-account data lingers.
  const activate = useCallback(async (key: string) => {
    await activateSession(key)
    await refresh()
  }, [refresh])
  // Removing the active account auto-promotes another session; clear the
  // query cache so the UI reflects whatever account is now active (or none).
  const remove = useCallback(async (key: string) => {
    await removeSession(key)
    await refresh()
  }, [refresh])
  const removeAll = useCallback(async () => {
    await clearSession()
    await refresh()
  }, [refresh])

  return {
    active,
    sessions,
    loading,
    hydrated,
    loadError,
    transitionError,
    retryLoad: refresh,
    retryTransition: refresh,
    adopt,
    add,
    activate,
    remove,
    removeAll,
  }
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
