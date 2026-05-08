/**
 * Catch up the local store with the server's change log via paginated
 * GET /projects/:id/changes?since=N. See docs/DATA_PERSISTENCE_PLAN.md §8.4.
 *
 * The fetcher loops until the server reports `more: false`, applying each
 * page atomically through `applyChangeBatch`. Drops batches whose seq does
 * not advance state (handled inside applyChangeBatch).
 */

import {
  applyChangeBatch,
  getLastSeq,
  type CellRow,
  type CommitRecord,
  type LocalStore,
} from "../local-store"

export interface ChangesFetchDeps {
  fetchImpl: typeof fetch
  baseUrl: string
  projectId: string
  getAuthToken: () => Promise<string | null>
  /** Optional server-side max records per page. */
  limit?: number
}

export interface ChangesFetchResult {
  batchesApplied: number
  finalSeq: number
}

interface PageResponse {
  seq: number
  cells?: CellRow[]
  commits?: CommitRecord[]
  more: boolean
}

export async function fetchChanges(
  store: LocalStore,
  deps: ChangesFetchDeps,
): Promise<ChangesFetchResult> {
  const result: ChangesFetchResult = {
    batchesApplied: 0,
    finalSeq: await getLastSeq(store, deps.projectId),
  }

  const token = await deps.getAuthToken()
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`

  let since = result.finalSeq
  while (true) {
    const response = await deps.fetchImpl(
      buildUrl(deps.baseUrl, deps.projectId, since, deps.limit),
      { headers },
    )
    if (!response.ok) {
      throw new Error(
        `changes fetch failed for ${deps.projectId}: ${response.status}`,
      )
    }
    const page = (await response.json()) as PageResponse
    const hasChanges =
      (page.cells?.length ?? 0) > 0 || (page.commits?.length ?? 0) > 0

    if (hasChanges) {
      await applyChangeBatch(store, {
        project_id: deps.projectId,
        seq: page.seq,
        cells: page.cells,
        commits: page.commits,
      })
      result.batchesApplied++
      result.finalSeq = page.seq
    }

    if (!page.more) break
    since = page.seq
  }

  return result
}

function buildUrl(
  baseUrl: string,
  projectId: string,
  since: number,
  limit?: number,
): string {
  const params = new URLSearchParams({ since: String(since) })
  if (limit !== undefined) params.set("limit", String(limit))
  return `${baseUrl}/projects/${projectId}/changes?${params.toString()}`
}
