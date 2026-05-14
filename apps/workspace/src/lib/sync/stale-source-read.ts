// Typed fetch wrapper for the sync-worker stale-source query (Phase 5 / AD-9).
//
//   GET /api/v1/projects/:projectId/files/:fileId/stale-source
//
// Runs the AD-9 pointer-comparison query against the `cells` projection
// (server-side it joins source rows from the upstream project — falls
// back to the same project for self-contained projects). Returns the set
// of target-side cells whose source has advanced since translation.
//
// Pattern matches `cells-read.ts`: sync-token JWT in the Authorization
// header, throws `StaleSourceError` on non-2xx with the body truncated.

import { syncWorkerHttpOrigin } from "./sync-worker-url"
import type {
  StaleCellId,
  StaleSourceResponse,
} from "./stale-source-read-types"

export class StaleSourceError extends Error {
  status: number
  body: string
  constructor(status: number, body: string) {
    super(`stale-source-read failed: HTTP ${status} — ${body.slice(0, 200)}`)
    this.status = status
    this.body = body
    this.name = "StaleSourceError"
  }
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new StaleSourceError(res.status, body)
  }
  return (await res.json()) as T
}

function authHeaders(jwt: string): HeadersInit {
  return { Authorization: `Bearer ${jwt}` }
}

/**
 * GET /api/v1/projects/:projectId/files/:fileId/stale-source
 *
 * Resolves to the array of cell ids whose source-side `event_id` no
 * longer equals the target row's pinned `source_event_id`. An empty
 * array is the steady-state for an up-to-date project.
 *
 * Convenience wrapper around the full response — `useStaleSourceCells`
 * materializes a Set from this array internally for O(1) membership.
 */
export async function fetchStaleSourceCells(
  projectId: string,
  fileId: string,
  jwt: string,
): Promise<StaleCellId[]> {
  const url =
    `${syncWorkerHttpOrigin()}/api/v1/projects/${encodeURIComponent(projectId)}` +
    `/files/${encodeURIComponent(fileId)}/stale-source`
  const res = await fetch(url, { headers: authHeaders(jwt) })
  const body = await readJson<StaleSourceResponse>(res)
  return body.staleCellIds ?? []
}
