// AD-2 first-child arbitration via the `chain_claims` table (audit RACE-2,
// tasks M1-1/M1-2).
//
// The route's `isWinningChild` SELECT is a check-then-act: two concurrent
// requests both see "no sibling yet" and both used to project (last commit
// wins, neither flagged stale, and replay disagreed with live). The claim
// row closes that window ATOMICALLY, inside the same transaction as the
// event insert:
//
//   1. The handler emits `INSERT INTO chain_claims … ON CONFLICT DO NOTHING`
//      BEFORE the cells projection statements.
//   2. Every chain-advancing cells write is gated on
//      `EXISTS (… chain_claims … AND event_id = <this event>)` — so the
//      transaction that loses the claim still logs its event (history) but
//      its projection writes are no-ops.
//   3. After commit, the route reads the claims back (`readClaimWinners`)
//      and reports losers via the response `stale` array so the existing
//      client banner fires (M1-2).
//
// Ordering guarantee: the per-project seq counter row lock (event-insert.ts)
// serializes same-project transactions, and the claim is taken inside that
// critical section — so the claim winner is always the LOWEST-server_seq
// sibling, which is exactly rebuild.ts's replay tie-break (replay == live).
//
// parent_key: unique indexes treat NULLs as distinct, so genesis events
// (parent_id IS NULL) use the '<null>' sentinel — the same sentinel
// rebuild.ts uses in its in-memory childKey.

/** Sentinel for genesis events (parent_id IS NULL) in chain_claims.parent_key. */
export const GENESIS_PARENT_KEY = '<null>'

export function parentKeyOf(parentId: string | null | undefined): string {
  return parentId ?? GENESIS_PARENT_KEY
}

/** One AD-2 chain slot: (project, file, cell, parent). */
export interface ChainSlot {
  projectId: string
  fileId: string
  cellId: string
  parentKey: string
}

/**
 * Claim the chain slot for `eventId`. First transaction to commit wins;
 * losers no-op (and their gated projection writes no-op with them).
 * Idempotent for replays of the winner: the existing row already carries
 * this event's id, so the EXISTS gate still passes.
 */
export function buildChainClaimStmt(
  db: AquillaDb,
  slot: ChainSlot,
  eventId: string,
): AquillaStatement {
  return db
    .prepare(
      `INSERT INTO chain_claims (project_id, file_id, cell_id, parent_key, event_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id, file_id, cell_id, parent_key) DO NOTHING`,
    )
    .bind(slot.projectId, slot.fileId, slot.cellId, slot.parentKey, eventId)
}

/**
 * Read back the winning event_id per slot (post-commit). Returns a map keyed
 * by `slotKey()`. Used by the route to flag claim losers as stale in the
 * response.
 */
export async function readClaimWinners(
  db: AquillaDb,
  slots: ChainSlot[],
): Promise<Map<string, string>> {
  const winners = new Map<string, string>()
  if (slots.length === 0) return winners

  const placeholders = slots.map(() => '(?, ?, ?, ?)').join(', ')
  const binds: unknown[] = []
  for (const s of slots) binds.push(s.projectId, s.fileId, s.cellId, s.parentKey)

  const { results } = await db
    .prepare(
      `SELECT project_id, file_id, cell_id, parent_key, event_id
       FROM chain_claims
       WHERE (project_id, file_id, cell_id, parent_key) IN (${placeholders})`,
    )
    .bind(...binds)
    .all<{
      project_id: string
      file_id: string
      cell_id: string
      parent_key: string
      event_id: string
    }>()

  for (const r of results) {
    winners.set(
      slotKey({
        projectId: r.project_id,
        fileId: r.file_id,
        cellId: r.cell_id,
        parentKey: r.parent_key,
      }),
      r.event_id,
    )
  }
  return winners
}

export function slotKey(slot: ChainSlot): string {
  return `${slot.projectId}\0${slot.fileId}\0${slot.cellId}\0${slot.parentKey}`
}
