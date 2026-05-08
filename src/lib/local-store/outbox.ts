/**
 * Client-only durable queue of pending mutations.
 * See docs/DATA_PERSISTENCE_PLAN.md §8.6 for the lifecycle.
 *
 * Status transitions:
 *   pending -> in_flight -> (ack: row deleted) | conflict | failed
 *   conflict -> pending (after user resolution)
 */

import type { LocalStore } from "./db"

export type OutboxStatus = "pending" | "in_flight" | "conflict" | "failed"

export interface OutboxRecord {
  local_id: string
  project_id: string
  endpoint: string
  payload: string
  expected_version: number | null
  status: OutboxStatus
  attempts: number
  last_error: string | null
  created_at: number
  updated_at: number
}

export interface NewOutboxRecord {
  local_id: string
  project_id: string
  endpoint: string
  payload: string
  expected_version: number | null
  created_at: number
}

export async function enqueueOutboxRecord(
  store: LocalStore,
  record: NewOutboxRecord,
): Promise<void> {
  await store.run(
    `INSERT INTO outbox (
      local_id, project_id, endpoint, payload, expected_version,
      status, attempts, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)`,
    [
      record.local_id,
      record.project_id,
      record.endpoint,
      record.payload,
      record.expected_version,
      record.created_at,
      record.created_at,
    ],
  )
}

export async function getOutboxRecord(
  store: LocalStore,
  localId: string,
): Promise<OutboxRecord | null> {
  const rows = await store.query<OutboxRecord>(
    "SELECT * FROM outbox WHERE local_id = ?",
    [localId],
  )
  return rows[0] ?? null
}

export interface ListPendingOptions {
  projectId?: string
}

export async function listPending(
  store: LocalStore,
  opts: ListPendingOptions = {},
): Promise<OutboxRecord[]> {
  if (opts.projectId !== undefined) {
    return store.query<OutboxRecord>(
      `SELECT * FROM outbox
       WHERE status = 'pending' AND project_id = ?
       ORDER BY created_at ASC`,
      [opts.projectId],
    )
  }
  return store.query<OutboxRecord>(
    `SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC`,
  )
}

export async function markInFlight(
  store: LocalStore,
  localId: string,
  now: number,
): Promise<void> {
  await store.run(
    `UPDATE outbox
     SET status = 'in_flight', attempts = attempts + 1, updated_at = ?
     WHERE local_id = ?`,
    [now, localId],
  )
}

export async function markConflict(
  store: LocalStore,
  localId: string,
  error: string,
  now: number,
): Promise<void> {
  await store.run(
    `UPDATE outbox
     SET status = 'conflict', last_error = ?, updated_at = ?
     WHERE local_id = ?`,
    [error, now, localId],
  )
}

/**
 * Return an in_flight record to pending after a retryable failure. Does not
 * change `attempts` (markInFlight already incremented it on send).
 */
export async function markPending(
  store: LocalStore,
  localId: string,
  now: number,
  lastError: string | null,
): Promise<void> {
  await store.run(
    `UPDATE outbox
     SET status = 'pending', last_error = ?, updated_at = ?
     WHERE local_id = ?`,
    [lastError, now, localId],
  )
}

export async function markFailed(
  store: LocalStore,
  localId: string,
  error: string,
  now: number,
): Promise<void> {
  await store.run(
    `UPDATE outbox
     SET status = 'failed', last_error = ?, updated_at = ?
     WHERE local_id = ?`,
    [error, now, localId],
  )
}

export async function deleteOutboxRecord(
  store: LocalStore,
  localId: string,
): Promise<void> {
  await store.run("DELETE FROM outbox WHERE local_id = ?", [localId])
}
