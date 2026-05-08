/**
 * Fetch a project snapshot and ingest it into the local store.
 * See docs/DATA_PERSISTENCE_PLAN.md §8.3 (initial load).
 *
 * Server contract: GET /projects/:id/snapshot returns gzipped JSONL
 * (transparently decompressed by fetch). The first line is a
 * snapshot_meta header; subsequent lines are project_meta, library_doc,
 * library_version, cell, and commit records.
 */

import {
  ingestSnapshot,
  type LocalStore,
  type SnapshotIngestResult,
} from "../local-store"

export interface SnapshotLoaderDeps {
  fetchImpl: typeof fetch
  baseUrl: string
  projectId: string
  getAuthToken: () => Promise<string | null>
}

export async function loadSnapshot(
  store: LocalStore,
  deps: SnapshotLoaderDeps,
): Promise<SnapshotIngestResult> {
  const token = await deps.getAuthToken()
  const headers: Record<string, string> = {}
  if (token) headers["Authorization"] = `Bearer ${token}`

  const response = await deps.fetchImpl(
    `${deps.baseUrl}/projects/${deps.projectId}/snapshot`,
    { headers },
  )

  if (!response.ok) {
    throw new Error(
      `snapshot fetch failed for ${deps.projectId}: ${response.status}`,
    )
  }

  return ingestSnapshot(store, streamLines(response))
}

async function* streamLines(response: Response): AsyncIterable<string> {
  const text = await response.text()
  for (const line of text.split("\n")) {
    yield line
  }
}
