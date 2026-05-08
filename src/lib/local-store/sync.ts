/**
 * Apply a change batch broadcast by the project DO (or fetched via
 * `/changes?since=N`) to the local store. Atomic and seq-monotonic.
 * See docs/DATA_PERSISTENCE_PLAN.md §8.7.
 */

import type { LocalStore } from "./db"
import { upsertCell, type CellRow } from "./cells"
import { advanceLastSeq, getLastSeq } from "./project-meta"

export interface CommitRecord {
  id: string
  project_id: string
  seq: number
  kind: string
  actor_id: string
  message: string
  payload: string
  created_at: number
}

export interface ChangeBatch {
  project_id: string
  /** Highest seq covered by this batch. Equals max(cells[].seq, commits[].seq). */
  seq: number
  cells?: ReadonlyArray<CellRow>
  commits?: ReadonlyArray<CommitRecord>
}

/**
 * Apply a batch atomically. Drops the batch silently if `batch.seq` is not
 * strictly greater than the current `last_seq` for the project — older
 * batches (replays, network reorder) cannot rewind state.
 */
export async function applyChangeBatch(
  store: LocalStore,
  batch: ChangeBatch,
): Promise<void> {
  const currentSeq = await getLastSeq(store, batch.project_id)
  if (batch.seq <= currentSeq) return

  await store.transaction(async () => {
    if (batch.cells) {
      for (const cell of batch.cells) {
        await upsertCell(store, cell)
      }
    }
    if (batch.commits) {
      for (const commit of batch.commits) {
        await store.run(
          `INSERT OR REPLACE INTO commits (
            id, project_id, seq, kind, actor_id, message, payload, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            commit.id,
            commit.project_id,
            commit.seq,
            commit.kind,
            commit.actor_id,
            commit.message,
            commit.payload,
            commit.created_at,
          ],
        )
      }
    }
    await advanceLastSeq(store, batch.project_id, batch.seq)
  })
}
