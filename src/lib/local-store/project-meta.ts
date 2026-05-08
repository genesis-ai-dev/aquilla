/**
 * Per-project metadata + the sync cursor.
 * See docs/DATA_PERSISTENCE_PLAN.md §8 — `last_seq` is what the sync engine
 * advances incrementally on every change broadcast or fetch.
 */

import type { LocalStore } from "./db"

export interface ProjectMetaRow {
  project_id: string
  org_id: string
  name: string
  library_doc_id: string
  bound_version_id: string
  source_lang: string
  target_lang: string
  last_seq: number
  snapshot_seq: number | null
  loaded_at: number
}

export async function upsertProjectMeta(
  store: LocalStore,
  meta: ProjectMetaRow,
): Promise<void> {
  await store.run(
    `INSERT OR REPLACE INTO project_meta (
      project_id, org_id, name, library_doc_id, bound_version_id,
      source_lang, target_lang, last_seq, snapshot_seq, loaded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      meta.project_id,
      meta.org_id,
      meta.name,
      meta.library_doc_id,
      meta.bound_version_id,
      meta.source_lang,
      meta.target_lang,
      meta.last_seq,
      meta.snapshot_seq,
      meta.loaded_at,
    ],
  )
}

export async function getProjectMeta(
  store: LocalStore,
  projectId: string,
): Promise<ProjectMetaRow | null> {
  const rows = await store.query<ProjectMetaRow>(
    "SELECT * FROM project_meta WHERE project_id = ?",
    [projectId],
  )
  return rows[0] ?? null
}

/**
 * Returns 0 when the project has no metadata row yet — semantically equivalent
 * to "haven't synced anything yet, please fetch from snapshot_seq=0".
 */
export async function getLastSeq(
  store: LocalStore,
  projectId: string,
): Promise<number> {
  const rows = await store.query<{ last_seq: number }>(
    "SELECT last_seq FROM project_meta WHERE project_id = ?",
    [projectId],
  )
  return rows[0]?.last_seq ?? 0
}

/**
 * Monotonically raises last_seq. A lower newSeq is silently ignored so racing
 * change batches cannot rewind the cursor.
 */
export async function advanceLastSeq(
  store: LocalStore,
  projectId: string,
  newSeq: number,
): Promise<void> {
  await store.run(
    `UPDATE project_meta
     SET last_seq = ?
     WHERE project_id = ? AND last_seq < ?`,
    [newSeq, projectId, newSeq],
  )
}
