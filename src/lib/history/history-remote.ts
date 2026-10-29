/**
 * The server's copy of a person's history for one project: what lets the
 * history follow them to another computer or browser. (Decision 11.)
 *
 *   GET /api/v2/projects/:projectId/edit-history?since=<revision>
 *   PUT /api/v2/projects/:projectId/edit-history   { baseRevision, history }
 *
 * (auth-worker/src/routes/edit-history.ts.) The server keeps one row per
 * (project, person) with a revision number; a write names the revision it was
 * built on and is refused with 409 and the current copy when another device
 * wrote first, so the caller merges and tries again (history-merge.ts).
 *
 * Every helper answers null on a network error or a refusal other than the
 * conflict: the history then simply stays on this device until the next try.
 */
import { AUTH_API_URL } from "@/lib/sync/sync-token"
import { normalizeHistoryDoc, type HistoryDoc } from "./history-merge"

export type RemoteRead =
  | { kind: "unchanged"; revision: number }
  | { kind: "copy"; revision: number; history: HistoryDoc | null }

export type RemoteWrite =
  | { kind: "saved"; revision: number }
  | { kind: "conflict"; revision: number; history: HistoryDoc | null }

export interface HistoryRemote {
  read(projectId: string, since: number | null): Promise<RemoteRead | null>
  write(projectId: string, baseRevision: number, history: HistoryDoc): Promise<RemoteWrite | null>
}

const url = (projectId: string) => `${AUTH_API_URL}/api/v2/projects/${encodeURIComponent(projectId)}/edit-history`

/** The server copy through the identity worker, signed with the person's session. */
export function httpHistoryRemote(getJwt: () => string | null): HistoryRemote {
  const headers = (jwt: string): HeadersInit => ({ "Content-Type": "application/json", Authorization: `Bearer ${jwt}` })
  return {
    async read(projectId, since) {
      const jwt = getJwt()
      if (!jwt) return null
      try {
        const res = await fetch(`${url(projectId)}${since != null ? `?since=${since}` : ""}`, { headers: headers(jwt) })
        if (!res.ok) return null
        const body = (await res.json()) as { revision?: number; unchanged?: boolean; history?: unknown }
        if (typeof body.revision !== "number") return null
        if (body.unchanged) return { kind: "unchanged", revision: body.revision }
        return { kind: "copy", revision: body.revision, history: body.history ? normalizeHistoryDoc(body.history) : null }
      } catch {
        return null
      }
    },
    async write(projectId, baseRevision, history) {
      const jwt = getJwt()
      if (!jwt) return null
      try {
        const res = await fetch(url(projectId), {
          method: "PUT",
          headers: headers(jwt),
          body: JSON.stringify({ baseRevision, history }),
        })
        const body = (await res.json().catch(() => null)) as { revision?: number; history?: unknown } | null
        if (res.status === 409 && typeof body?.revision === "number") {
          return { kind: "conflict", revision: body.revision, history: body.history ? normalizeHistoryDoc(body.history) : null }
        }
        if (!res.ok || typeof body?.revision !== "number") return null
        return { kind: "saved", revision: body.revision }
      } catch {
        return null
      }
    },
  }
}
