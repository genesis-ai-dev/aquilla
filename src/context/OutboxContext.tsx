import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from "react"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { useOutboxFlusher } from "@/hooks/useOutboxFlusher"
import { usePendingOutboxRecords } from "@/hooks/usePendingOutboxRecords"
import { buildProjectAwareMinter } from "@/lib/sync/cqrs-bridge"
import {
  isStoredSessionCurrent,
  listStoredSessions,
  subscribeSession,
} from "@/lib/frontier/session-store"
import type { OutboxRecord } from "@/lib/sync/outbox"
import type { StaleSiblingEntry } from "@/lib/sync/outbox-flush"
import type { OutboxFlushTarget } from "@/hooks/useOutboxFlusher"

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
  /** Reactive view of PENDING outbox records. NOT all records — `failed`
   *  (quarantined) are excluded (AQU-274): overlay + pending-count consumers
   *  (useReconcileOnDrain) depend on this reaching zero when the queue drains. */
  records: OutboxRecord[]
  /** SUB-9: all-status records (pending + failed) for the inspector popover,
   *  so quarantined refusals stay visible with their reason + Retry/Discard.
   *  Do NOT use for overlays or pending-count logic. */
  inspectorRecords: OutboxRecord[]
  staleSiblingCount: number
  staleSiblingEntries: StaleSiblingEntry[]
  clearStaleSiblings: () => void
  staleSourceCount: number
  clearStaleSource: () => void
}

const OutboxContext = createContext<OutboxContextValue | null>(null)

export function OutboxProvider({ children }: { children: ReactNode }) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const activeIdentityRef = useRef<{ ownerKey: string; jwt: string } | null>(null)
  activeIdentityRef.current = session ? { ownerKey: session.username, jwt: session.jwt } : null

  const minter = useMemo(
    () =>
      buildProjectAwareMinter(() => jwt, undefined, {
        onUnauthorized: (failedJwt) => {
          // Only a /sync-token mint 401 (the session JWT itself is dead)
          // reaches here — that genuinely means re-auth. A per-event 403 does
          // not. Keep the queue and every stored account intact while the
          // rejected credential is re-authenticated.
          console.warn("[OutboxProvider] session JWT rejected (401) during outbox drain — requesting re-auth")
          void notifySessionExpiredIfCurrent(failedJwt)
        },
      }),
    // Rebuild the entire per-project/file minter graph at the account boundary.
    // The inner cache also keys tokens by JWT, but discarding its closures here
    // keeps no cross-account machinery alive and composes with authEpoch's
    // in-flight cancellation in useOutboxFlusher.
    [jwt],
  )

  const accountMintersRef = useRef(new Map<string, {
    jwt: string
    minter: ReturnType<typeof buildProjectAwareMinter>
  }>())
  const getFlushTargets = useCallback(async (): Promise<OutboxFlushTarget[]> => {
    const stored = await listStoredSessions()
    const liveOwners = new Set(stored.map(({ key }) => key))
    for (const ownerKey of accountMintersRef.current.keys()) {
      if (!liveOwners.has(ownerKey)) accountMintersRef.current.delete(ownerKey)
    }

    return stored.map(({ key: ownerKey, session: storedSession }) => {
      let cached = accountMintersRef.current.get(ownerKey)
      if (!cached || cached.jwt !== storedSession.jwt) {
        const credentialJwt = storedSession.jwt
        cached = {
          jwt: credentialJwt,
          minter: buildProjectAwareMinter(() => credentialJwt, undefined, {
            onUnauthorized: (failedJwt) => {
              console.warn(
                `[OutboxProvider] stored session ${ownerKey} was rejected (401) during outbox drain`,
              )
              // This raises the foreground re-auth surface only if this exact
              // credential is still active. Inactive accounts remain stored
              // and isolated while their own bounded retry schedule continues.
              void notifySessionExpiredIfCurrent(failedJwt)
            },
          }),
        }
        accountMintersRef.current.set(ownerKey, cached)
      }
      const credentialJwt = cached.jwt
      return {
        ownerKey,
        authEpoch: credentialJwt,
        getTokenForFile: cached.minter,
        isSessionCurrent: () => isStoredSessionCurrent(ownerKey, credentialJwt),
        shouldSurface: () => {
          const active = activeIdentityRef.current
          return active?.ownerKey === ownerKey && active.jwt === credentialJwt
        },
      }
    })
  }, [])

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
    clearStaleSource,
  } = useOutboxFlusher({
    // Drains whenever a session exists — independent of the current route, so
    // the backlog clears on the org dashboard too, not just inside a project.
    enabled: Boolean(jwt),
    getTokenForFile: minter,
    authEpoch: jwt,
    getFlushTargets,
    subscribeFlushTargets: subscribeSession,
  })

  const records = usePendingOutboxRecords({ enabled: Boolean(jwt), fileId: null })
  const inspectorRecords = usePendingOutboxRecords({ enabled: Boolean(jwt), fileId: null, includeFailed: true })

  const value = useMemo<OutboxContextValue>(
    () => ({
      pendingCount,
      failedCount,
      failureStreak,
      flushNow,
      refreshPending,
      records,
      inspectorRecords,
      staleSiblingCount,
      staleSiblingEntries,
      clearStaleSiblings,
      staleSourceCount,
      clearStaleSource,
    }),
    [
      pendingCount,
      failedCount,
      failureStreak,
      flushNow,
      refreshPending,
      records,
      inspectorRecords,
      staleSiblingCount,
      staleSiblingEntries,
      clearStaleSiblings,
      staleSourceCount,
      clearStaleSource,
    ],
  )

  return <OutboxContext.Provider value={value}>{children}</OutboxContext.Provider>
}

export function useOutbox(): OutboxContextValue {
  const ctx = useContext(OutboxContext)
  if (!ctx) throw new Error("useOutbox must be used within an OutboxProvider")
  return ctx
}
