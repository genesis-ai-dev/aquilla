/**
 * Typed access to the `waivers` projection — *edit-keyed*.
 *
 * Each row asserts: "rule R is waived for cell C at translation
 * text_snapshot, captured when cell.version was cell_version_at."
 * When the cell's translation moves, the waiver naturally becomes
 * historical (it still exists; its text_snapshot no longer matches
 * the live cell), and the UI renders staleness honestly.
 *
 * See DATA_PERSISTENCE_PLAN.md §4.10 (cell-keyed vs edit-keyed)
 * and §4.11 (edit-keyed signoffs schema).
 */

import type { LocalStore } from "./db"

export type WaiverState = "proposed" | "approved" | "revoked"

export interface WaiverRow {
  id: string
  cell_id: string
  cell_version_at: number
  text_snapshot: string
  rule_id: string
  state: WaiverState
  justification: string
  proposed_by: string
  proposed_at: number
  resolved_by: string | null
  resolved_at: number | null
  seq: number
  org_id: string
}

const UPSERT_SQL = `INSERT OR REPLACE INTO waivers (
  id, cell_id, cell_version_at, text_snapshot, rule_id,
  state, justification,
  proposed_by, proposed_at,
  resolved_by, resolved_at,
  seq, org_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export async function upsertWaiver(
  store: LocalStore,
  w: WaiverRow,
): Promise<void> {
  await store.run(UPSERT_SQL, [
    w.id,
    w.cell_id,
    w.cell_version_at,
    w.text_snapshot,
    w.rule_id,
    w.state,
    w.justification,
    w.proposed_by,
    w.proposed_at,
    w.resolved_by,
    w.resolved_at,
    w.seq,
    w.org_id,
  ])
}

export async function getWaiver(
  store: LocalStore,
  id: string,
): Promise<WaiverRow | null> {
  const rows = await store.query<WaiverRow>(
    "SELECT * FROM waivers WHERE id = ?",
    [id],
  )
  return rows[0] ?? null
}

/** Active = proposed | approved. Revoked rows stay historical. */
export async function getActiveWaiversForCell(
  store: LocalStore,
  cellId: string,
): Promise<WaiverRow[]> {
  return store.query<WaiverRow>(
    `SELECT * FROM waivers
     WHERE cell_id = ? AND state IN ('proposed','approved')
     ORDER BY proposed_at, id`,
    [cellId],
  )
}
