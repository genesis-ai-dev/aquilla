import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOutboxFlusher } from "@/hooks/useOutboxFlusher"
import { usePendingOutboxRecords } from "@/hooks/usePendingOutboxRecords"
import { buildProjectAwareMinter } from "@/lib/sync/cqrs-bridge"
import type { OutboxRecord } from "@/lib/sync/outbox"
import type { StaleSiblingEntry } from "@/lib/sync/outbox-flush"

/**
 * App-shell ownership of the CQRS outbox drain (AQU-221). Historically the
 * flusher was mounted inside ProjectWorkspace and only ran while a project was
 * open — so a backlog sat undrained on the org dashboard or any non-project
 * route. The outbox is global across every project the user touches, so its
 * single background drain belongs at the shell, gated only on having a session.
 *
 * The flusher uses a per-origin Web Lock, so there must be exactly ONE loop;
 * consumers (the workspace status-bar indicator, stale-edit banners) read this
 * context rather than spinning up their own `useOutboxFlusher`.
 */
export interface OutboxContextValue {
  /** Total records in the outbox (pending + failed/quarantined). */
  pendingCount: number
  /** Records that permanently failed / were quarantined (need attention). */
  failedCount: number
  failureStreak: number
  /** Reset backoff + force an immediate flush (Retry / reconnect / re-auth). */
  flushNow: () => void
  /** Re-reads the queue sizes; resolves with the total (pending + failed). */
  refreshPending: () => Promise<number>
  /** Reactive view of all outbox records for the inspector popover. */
  records: OutboxRecord[]
  staleSiblingCount: number
  staleSiblingEntries: StaleSiblingEntry[]
  clearStaleSiblings: () => void
  staleSourceCount: number
}

const OutboxContext = createContext<OutboxContextValue | null>(null)

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { session, logout } = useFrontierSession()
  const navigate = useNavigate()
  const jwt = session?.jwt ?? null

  // Live JWT ref so the minter (built once) always reads the current token.
  const jwtRef = useRef<string | null>(jwt)
  useEffect(() => {
    jwtRef.current = jwt
  }, [jwt])

  const minter = useMemo(
    () =>
      buildProjectAwareMinter(() => jwtRef.current, undefined, {
        onUnauthorized: () => {
          // Only a /sync-token mint 401 (the session JWT itself is dead)
          // reaches here — that genuinely means re-auth. A per-event 403 does
          // not, so the queue advances past forbidden events without logging
          // the user out.
          console.warn("[OutboxProvider] session JWT rejected (401) during outbox drain — clearing session")
          void logout().then(() => navigate("/"))
        },
      }),
    [logout, navigate],
  )

  const {
    pendingCount,
    failedCount,
    failureStreak,
    flushNow,
    refreshPending,
    staleSiblingCount,
    staleSiblingEntries,
    clearStaleSiblings,
    staleSourceCount,
  } = useOutboxFlusher({
    // Drains whenever a session exists — independent of the current route, so
    // the backlog clears on the org dashboard too, not just inside a project.
    enabled: Boolean(jwt),
    getTokenForFile: minter,
    authEpoch: jwt,
  })

  const records = usePendingOutboxRecords({ enabled: Boolean(jwt), fileId: null })

  const value = useMemo<OutboxContextValue>(
    () => ({
      pendingCount,
      failedCount,
      failureStreak,
      flushNow,
      refreshPending,
      records,
      staleSiblingCount,
      staleSiblingEntries,
      clearStaleSiblings,
      staleSourceCount,
    }),
    [
      pendingCount,
      failedCount,
      failureStreak,
      flushNow,
      refreshPending,
      records,
      staleSiblingCount,
      staleSiblingEntries,
      clearStaleSiblings,
      staleSourceCount,
    ],
  )

  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>
}

export function useOutbox(): OutboxContextValue {
  const ctx = useContext(OutboxContext)
  if (!ctx) throw new Error("useOutbox must be used within an OutboxProvider")
  return ctx
}
