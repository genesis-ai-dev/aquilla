/**
 * Drain pending outbox records to the server.
 * See docs/DATA_PERSISTENCE_PLAN.md §8.6.
 *
 * Per-record protocol:
 *   200 + { cell }    → upsert local cell from response, delete record
 *   409               → mark conflict (UI surfaces 3-way diff)
 *   other 4xx         → mark failed (non-retryable)
 *   5xx | network     → bump attempts; mark pending if < maxAttempts else failed
 */

import {
  deleteOutboxRecord,
  listPending,
  markConflict,
  markFailed,
  markInFlight,
  markPending,
  upsertCell,
  type CellRow,
  type LocalStore,
  type OutboxRecord,
} from "../local-store"

export interface FlushDeps {
  fetchImpl: typeof fetch
  baseUrl: string
  getAuthToken: () => Promise<string | null>
  /** Override clock for tests. */
  now?: () => number
  /** Maximum attempts before a retryable failure becomes terminal. */
  maxAttempts?: number
}

export interface FlushResult {
  drained: number
  conflicts: number
  failed: number
}

const DEFAULT_MAX_ATTEMPTS = 5

export async function flushOutbox(
  store: LocalStore,
  deps: FlushDeps,
): Promise<FlushResult> {
  const result: FlushResult = { drained: 0, conflicts: 0, failed: 0 }

  const token = await deps.getAuthToken()
  if (!token) return result

  const pending = await listPending(store)
  if (pending.length === 0) return result

  const now = deps.now ?? (() => Date.now())
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS

  for (const record of pending) {
    await sendOne(store, record, deps, token, now, maxAttempts, result)
  }
  return result
}

async function sendOne(
  store: LocalStore,
  record: OutboxRecord,
  deps: FlushDeps,
  token: string,
  now: () => number,
  maxAttempts: number,
  result: FlushResult,
): Promise<void> {
  const attemptCountAfterSend = record.attempts + 1
  await markInFlight(store, record.local_id, now())

  let response: Response
  try {
    response = await deps.fetchImpl(deps.baseUrl + record.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: record.payload,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await handleRetryable(
      store,
      record.local_id,
      message,
      now,
      attemptCountAfterSend,
      maxAttempts,
      result,
    )
    return
  }

  if (response.status === 200) {
    let cell: CellRow | null = null
    try {
      const body = (await response.json()) as { cell?: CellRow }
      cell = body.cell ?? null
    } catch {
      // tolerate empty body
    }
    if (cell) {
      await upsertCell(store, cell)
    }
    await deleteOutboxRecord(store, record.local_id)
    result.drained++
    return
  }

  if (response.status === 409) {
    const message = await safeReadError(response, "version_mismatch")
    await markConflict(store, record.local_id, message, now())
    result.conflicts++
    return
  }

  if (response.status >= 400 && response.status < 500) {
    const message = await safeReadError(
      response,
      `http_${response.status}`,
    )
    await markFailed(store, record.local_id, message, now())
    result.failed++
    return
  }

  // 5xx
  const message = await safeReadError(response, `http_${response.status}`)
  await handleRetryable(
    store,
    record.local_id,
    message,
    now,
    attemptCountAfterSend,
    maxAttempts,
    result,
  )
}

async function handleRetryable(
  store: LocalStore,
  localId: string,
  message: string,
  now: () => number,
  attemptCountAfterSend: number,
  maxAttempts: number,
  result: FlushResult,
): Promise<void> {
  if (attemptCountAfterSend >= maxAttempts) {
    await markFailed(store, localId, message, now())
    result.failed++
  } else {
    await markPending(store, localId, now(), message)
  }
}

async function safeReadError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return fallback
    return text.length > 200 ? text.slice(0, 200) : text
  } catch {
    return fallback
  }
}
