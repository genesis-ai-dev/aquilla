/**
 * useAgentSessionHistory — the caller's own Team chats on a project (AQU-1653).
 *
 * Read-hook convention (AD-3): plain `useState` + a race-guarded `useEffect`
 * over the typed client. No React Query hooks — `useQueryClient` invalidation
 * is the only part of it this app uses.
 *
 * The three states the menu renders are DERIVED rather than written in the
 * effect body, so nothing sets state synchronously during a render pass: a
 * result is stamped with the request it answers, and anything else reads as
 * still loading. That also makes the stale-response guard explicit — a reply
 * for the previous project can neither be shown under the new one nor leave
 * the hook reporting "ready" for a request that has not landed.
 *
 * The list is refetched on demand (`reload`) rather than polled: it changes
 * only when this user sends a turn or starts a chat, both of which the caller
 * already knows about.
 */

import { useCallback, useEffect, useState } from "react"
import { listAgentSessions, type AgentSessionSummary } from "@/lib/agent/session-history"

export type AgentSessionHistoryStatus = "loading" | "ready" | "error"

/** Stable empty list, so a consumer memoizing on `sessions` does not rerun. */
const NO_SESSIONS: AgentSessionSummary[] = []

interface Loaded {
  /** The request this answers; a result for any other request is ignored. */
  key: string
  sessions: AgentSessionSummary[]
  status: "ready" | "error"
}

export function useAgentSessionHistory(
  jwt: string | null,
  projectId: string,
): {
  sessions: AgentSessionSummary[]
  status: AgentSessionHistoryStatus
  reload: () => void
} {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [nonce, setNonce] = useState(0)
  const key = `${jwt ?? ""}\u0000${projectId}\u0000${nonce}`

  useEffect(() => {
    // Signed out: no chats to list, and no request worth making.
    if (!jwt) return
    let live = true
    listAgentSessions(jwt, projectId)
      .then((rows) => {
        if (live) setLoaded({ key, sessions: rows, status: "ready" })
      })
      .catch(() => {
        if (live) setLoaded({ key, sessions: NO_SESSIONS, status: "error" })
      })
    return () => {
      live = false
    }
  }, [jwt, projectId, key])

  const current = loaded?.key === key ? loaded : null
  // Signed out reads as "ready with nothing", not as a failure — the menu must
  // say "no previous chats" rather than blaming a read that never happened.
  const status: AgentSessionHistoryStatus = !jwt ? "ready" : (current?.status ?? "loading")
  const sessions = current?.sessions ?? NO_SESSIONS

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { sessions, status, reload }
}
