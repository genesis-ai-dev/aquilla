// The server's copy of a person's undo history for one project (decision 11:
// the history follows the person between devices). Migration 0187.
//
// The document is the client's (src/lib/history/history-merge.ts) and stays
// opaque here: this module stores it and enforces ONE rule, the revision. A
// write names the revision it was built on and lands only if that is still the
// stored one; otherwise the caller gets the current copy back to merge with.
//
// Takes the bare `AquillaDb` handle (db/shim/postgres.ts), like the other
// db/shared modules; identity and authorization stay with the route.

import type { AquillaDb } from "../shim/postgres"

/** A hundred steps of plain data is far below this; it caps a runaway client. */
export const EDIT_HISTORY_MAX_BYTES = 2 * 1024 * 1024

export interface StoredEditHistory {
  /** 0 when the person has no copy yet. */
  revision: number
  /** The client's document, as JSON text; null when there is none. */
  history: string | null
}

export async function readEditHistory(db: AquillaDb, projectId: string, userId: number): Promise<StoredEditHistory> {
  const row = await db
    .prepare("SELECT revision, history FROM edit_histories WHERE project_id = ? AND user_id = ?")
    .bind(projectId, userId)
    .first<{ revision: number; history: string }>()
  return row ? { revision: Number(row.revision), history: row.history } : { revision: 0, history: null }
}

export type EditHistoryWrite =
  | { ok: true; revision: number }
  | { ok: false; current: StoredEditHistory }

/**
 * Store `history` if `baseRevision` is still the stored revision (0 = none
 * yet). The check and the write are one statement, so two devices writing at
 * the same moment cannot both win.
 */
export async function writeEditHistory(
  db: AquillaDb,
  projectId: string,
  userId: number,
  baseRevision: number,
  history: string,
  now = Date.now(),
): Promise<EditHistoryWrite> {
  const result =
    baseRevision === 0
      ? await db
          .prepare(
            `INSERT INTO edit_histories (project_id, user_id, revision, history, updated_at)
             VALUES (?, ?, 1, ?, ?)
             ON CONFLICT (project_id, user_id) DO NOTHING`,
          )
          .bind(projectId, userId, history, now)
          .run()
      : await db
          .prepare(
            `UPDATE edit_histories SET history = ?, revision = revision + 1, updated_at = ?
              WHERE project_id = ? AND user_id = ? AND revision = ?`,
          )
          .bind(history, now, projectId, userId, baseRevision)
          .run()
  if ((result.meta?.changes ?? 0) > 0) return { ok: true, revision: baseRevision + 1 }
  return { ok: false, current: await readEditHistory(db, projectId, userId) }
}
