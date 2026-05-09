/**
 * Typed access to the `threads` and `thread_messages` projections.
 * Cell-keyed entities — see DATA_PERSISTENCE_PLAN.md §4.12.
 *
 * Both tables use INSERT OR REPLACE so the mirror's "re-sync the whole
 * thread tree on any change" pattern stays cheap and idempotent.
 */

import type { LocalStore } from "./db"
import { storeEvents } from "./store-events"

export interface ThreadRow {
  id: string
  cell_id: string
  status: string
  created_by: string
  created_at: number
  resolved_by: string | null
  resolved_at: number | null
  seq: number
}

export interface ThreadMessageRow {
  id: string
  thread_id: string
  author_id: string
  body: string
  created_at: number
  seq: number
}

const UPSERT_THREAD_SQL = `INSERT OR REPLACE INTO threads (
  id, cell_id, status, created_by, created_at, resolved_by, resolved_at, seq
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`

export async function upsertThread(
  store: LocalStore,
  thread: ThreadRow,
): Promise<void> {
  await store.run(UPSERT_THREAD_SQL, [
    thread.id,
    thread.cell_id,
    thread.status,
    thread.created_by,
    thread.created_at,
    thread.resolved_by,
    thread.resolved_at,
    thread.seq,
  ])
  storeEvents.emit({ type: "threads.changed", cellId: thread.cell_id })
}

export async function getThread(
  store: LocalStore,
  id: string,
): Promise<ThreadRow | null> {
  const rows = await store.query<ThreadRow>(
    "SELECT * FROM threads WHERE id = ?",
    [id],
  )
  return rows[0] ?? null
}

export async function getThreadsByCell(
  store: LocalStore,
  cellId: string,
): Promise<ThreadRow[]> {
  return store.query<ThreadRow>(
    "SELECT * FROM threads WHERE cell_id = ? ORDER BY created_at, id",
    [cellId],
  )
}

const UPSERT_MESSAGE_SQL = `INSERT OR REPLACE INTO thread_messages (
  id, thread_id, author_id, body, created_at, seq
) VALUES (?, ?, ?, ?, ?, ?)`

export async function appendThreadMessage(
  store: LocalStore,
  msg: ThreadMessageRow,
): Promise<void> {
  await store.run(UPSERT_MESSAGE_SQL, [
    msg.id,
    msg.thread_id,
    msg.author_id,
    msg.body,
    msg.created_at,
    msg.seq,
  ])
  storeEvents.emit({
    type: "thread_messages.changed",
    threadId: msg.thread_id,
  })
}

export async function getMessagesByThread(
  store: LocalStore,
  threadId: string,
): Promise<ThreadMessageRow[]> {
  return store.query<ThreadMessageRow>(
    "SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY created_at, id",
    [threadId],
  )
}

/**
 * Move a thread to `resolved`, recording who closed it and when. No-op if
 * the thread doesn't exist (mirror's eventual-consistency contract).
 */
export async function resolveThreadStatus(
  store: LocalStore,
  threadId: string,
  by: { resolved_by: string; resolved_at: number },
): Promise<void> {
  await store.run(
    `UPDATE threads
     SET status = 'resolved', resolved_by = ?, resolved_at = ?
     WHERE id = ?`,
    [by.resolved_by, by.resolved_at, threadId],
  )
}
