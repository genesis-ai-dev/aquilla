/**
 * IndexedDB-backed outbox for CQRS events (Phase 2). Survives tab close;
 * drained by the flusher hook with idempotent POST /events retries.
 *
 * Records carry per-attempt status so the inspector UI can distinguish
 * "just enqueued" from "retried, kept by the server" (401/403 quarantine
 * waiting on a fresh token). Updates are best-effort via `markOutboxAttempt`;
 * a failed write doesn't block the flusher.
 */

import type { CqrsRawEvent } from "./outbox-types"

const DB_NAME = "aquilla-cqrs-outbox"
/** v2: adds `attempts`, `lastAttemptAt`, `lastError` to existing rows. */
const DB_VERSION = 2
const STORE = "outbox"

export interface OutboxAttemptError {
  status: number
  reason: string
}

/** Records that exceed this many failed attempts are moved to `failed` status. */
export const OUTBOX_MAX_ATTEMPTS = 5

export interface OutboxRecord {
  id: string
  enqueuedAt: number
  event: CqrsRawEvent
  /** How many flush attempts have hit the server for this record. 0 = never tried. */
  attempts: number
  /** Wallclock of the most recent attempt; null when attempts === 0. */
  lastAttemptAt: number | null
  /** Last server-side rejection that didn't cause removal (auth quarantine,
   *  or 5xx/network on a non-final outcome). null when last attempt landed
   *  the record (which by then would've been deleted) or when never tried. */
  lastError: OutboxAttemptError | null
  /**
   * `pending` (default) → actively retried by the flusher.
   * `failed` → exceeded OUTBOX_MAX_ATTEMPTS; flusher skips it; shown as
   *             permanent error in the indicator.
   */
  status: "pending" | "failed"
}

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * Subscribers fired whenever the outbox contents change (enqueue or remove).
 * Used by overlay hooks to refresh pending-event views without polling. The
 * IDB write itself is the durable record; this is just an in-process notify.
 */
type OutboxListener = () => void
const listeners = new Set<OutboxListener>()

export function subscribeToOutbox(cb: OutboxListener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function notifyOutboxChanged(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch {
      /* listener errors don't impair the writer */
    }
  }
}

/** Closes the singleton connection (tests only). */
export async function resetOutboxConnectionForTests(): Promise<void> {
  if (!dbPromise) return
  try {
    const db = await dbPromise
    db.close()
  } catch {
    /* ignore */
  }
  dbPromise = null
  listeners.clear()
}

async function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("indexedDB unavailable"))
  }
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onerror = () => reject(req.error ?? new Error("IDB open failed"))
      req.onsuccess = () => resolve(req.result)
      req.onupgradeneeded = (ev) => {
        const db = req.result
        const tx = req.transaction
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" })
          store.createIndex("enqueuedAt", "enqueuedAt", { unique: false })
          return
        }
        // v1 → v2: backfill the new fields on existing rows so reads/writes
        // that assume their presence don't have to handle undefined.
        const upgradeEv = ev as IDBVersionChangeEvent
        if (upgradeEv.oldVersion < 2 && tx) {
          const store = tx.objectStore(STORE)
          const cursorReq = store.openCursor()
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result
            if (!cursor) return
            const rec = cursor.value as Partial<OutboxRecord>
            const next: OutboxRecord = {
              id: rec.id!,
              enqueuedAt: rec.enqueuedAt ?? Date.now(),
              event: rec.event!,
              attempts: rec.attempts ?? 0,
              lastAttemptAt: rec.lastAttemptAt ?? null,
              lastError: rec.lastError ?? null,
              status: (rec as Partial<OutboxRecord>).status ?? "pending",
            }
            cursor.update(next)
            cursor.continue()
          }
        }
      }
    })
  }
  return dbPromise
}

export async function enqueueOutboxEvent(event: CqrsRawEvent): Promise<void> {
  const db = await openDb()
  const rec: OutboxRecord = {
    id: event.id,
    enqueuedAt: Date.now(),
    event,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    status: "pending",
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("enqueue tx failed"))
    tx.oncomplete = () => resolve()
    tx.objectStore(STORE).put(rec)
  })
  notifyOutboxChanged()
}

/** Enqueue many events in ONE transaction and fire a SINGLE change
 *  notification. Used by bulk import so a large batch produces one overlay
 *  rebuild + one badge refresh instead of N. Same-id `put` overwrites, so a
 *  re-enqueue of already-queued events is a no-op (idempotent). */
export async function enqueueOutboxEvents(events: CqrsRawEvent[]): Promise<void> {
  if (events.length === 0) return
  const db = await openDb()
  const now = Date.now()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("bulk enqueue tx failed"))
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const event of events) {
      const rec: OutboxRecord = {
        id: event.id,
        enqueuedAt: now,
        event,
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        status: "pending",
      }
      store.put(rec)
    }
  })
  notifyOutboxChanged()
}

/**
 * Record an attempt outcome on the kept-back records. Called by the flusher
 * after a POST resolves: each record that wasn't accepted (or permanently
 * rejected) gets its `attempts` bumped and, if applicable, a `lastError`
 * stamped. Best-effort — IDB write failures are swallowed so the flusher
 * keeps draining.
 */
export async function markOutboxAttempt(
  ids: string[],
  outcome: { error: OutboxAttemptError | null; at?: number },
): Promise<void> {
  if (ids.length === 0) return
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  const at = outcome.at ?? Date.now()
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite")
    // Don't reject the caller on individual write errors — flusher progress
    // matters more than per-attempt bookkeeping.
    tx.onerror = () => resolve()
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const rec = getReq.result as Partial<OutboxRecord> | undefined
        if (!rec || !rec.id || !rec.event) return
        const newAttempts = (rec.attempts ?? 0) + 1
        const next: OutboxRecord = {
          id: rec.id,
          enqueuedAt: rec.enqueuedAt ?? Date.now(),
          event: rec.event,
          // Coalesce in case the v1 → v2 upgrade hasn't reached this row yet
          // (defense-in-depth; the upgrade-on-open should have backfilled).
          attempts: newAttempts,
          lastAttemptAt: at,
          lastError: outcome.error,
          status: newAttempts >= OUTBOX_MAX_ATTEMPTS ? "failed" : ((rec.status as OutboxRecord["status"]) ?? "pending"),
        }
        store.put(next)
      }
    }
  })
  notifyOutboxChanged()
}

/**
 * Stamp a `lastError` (and `lastAttemptAt`) on records WITHOUT incrementing
 * `attempts` or flipping them to `failed`. Used for token-mint failures that
 * are recoverable without user action — a 401 (stale JWT, self-heals on
 * re-auth) or a transient 5xx/offline mint. We must surface *why* the record
 * is sitting around (so the inspector shows "Sign in to retry" / "Retrying"
 * instead of a bland "Pending"), but we must NOT burn the retry budget: a
 * recoverable auth blip should never push a record over OUTBOX_MAX_ATTEMPTS
 * into `failed`, because `failed` records are skipped by the flusher and would
 * then NOT auto-drain after re-auth. Best-effort; write failures are swallowed.
 */
export async function stampOutboxError(
  ids: string[],
  error: OutboxAttemptError,
): Promise<void> {
  if (ids.length === 0) return
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  const at = Date.now()
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => resolve()
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const rec = getReq.result as Partial<OutboxRecord> | undefined
        if (!rec || !rec.id || !rec.event) return
        const next: OutboxRecord = {
          id: rec.id,
          enqueuedAt: rec.enqueuedAt ?? Date.now(),
          event: rec.event,
          attempts: rec.attempts ?? 0,
          lastAttemptAt: at,
          lastError: error,
          status: (rec.status as OutboxRecord["status"]) ?? "pending",
        }
        store.put(next)
      }
    }
  })
  notifyOutboxChanged()
}

/** Oldest-first rows (all statuses), at most `limit`. */
export async function peekOutboxBatch(limit: number): Promise<OutboxRecord[]> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const out: OutboxRecord[] = []
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("peek tx failed"))
      const store = tx.objectStore(STORE)
      const idx = store.index("enqueuedAt")
      const req = idx.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor || out.length >= limit) {
          resolve(out)
          return
        }
        out.push(cursor.value as OutboxRecord)
        cursor.continue()
      }
    })
  } catch {
    return []
  }
}

/**
 * Resolve a small known set of records by id. Callers that persisted a local
 * overlay use this to prove that its events are still actually pending after
 * a tab restart, without scanning the entire outbox.
 */
export async function getOutboxRecords(ids: readonly string[]): Promise<OutboxRecord[]> {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  if (uniqueIds.length === 0) return []
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const records: OutboxRecord[] = []
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("outbox lookup failed"))
      tx.oncomplete = () => resolve(records)
      const store = tx.objectStore(STORE)
      for (const id of uniqueIds) {
        const request = store.get(id)
        request.onsuccess = () => {
          const record = request.result as OutboxRecord | undefined
          if (record?.id && record.event) records.push(record)
        }
      }
    })
  } catch {
    return []
  }
}

/** Oldest-first rows with status `pending` only, at most `limit`. Used by the flusher. */
export async function peekPendingOutboxBatch(limit: number): Promise<OutboxRecord[]> {
  const all = await peekOutboxBatch(limit + 50) // fetch extra to filter
  return all.filter((r) => (r.status ?? "pending") === "pending").slice(0, limit)
}

/** Count of records that have permanently failed (exceeded retry cap). */
export async function outboxFailedCount(): Promise<number> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      let count = 0
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("count tx failed"))
      const store = tx.objectStore(STORE)
      const req = store.openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) { resolve(count); return }
        if ((cursor.value as OutboxRecord).status === "failed") count++
        cursor.continue()
      }
    })
  } catch {
    return 0
  }
}

/**
 * Force records into `failed` status immediately, without waiting for the
 * attempt cap. Used for *non-retryable* server rejections (e.g. 403 — the
 * caller lacks permission, or the event is scoped to a project the current
 * session can't mint a token for). Retrying these forever is what wedged the
 * queue and produced the misleading "session expired, sign in to retry" loop:
 * a quarantined record is skipped by `peekPendingOutboxBatch`, so the flusher
 * advances past it to other files instead of head-of-line blocking. The record
 * is preserved (not deleted) so the inspector can show it and the user can
 * discard or resolve it — no silent data loss.
 */
export async function quarantineOutboxEvents(
  ids: string[],
  error: OutboxAttemptError,
): Promise<void> {
  if (ids.length === 0) return
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  const at = Date.now()
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => resolve()
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const rec = getReq.result as Partial<OutboxRecord> | undefined
        if (!rec || !rec.id || !rec.event) return
        const next: OutboxRecord = {
          id: rec.id,
          enqueuedAt: rec.enqueuedAt ?? Date.now(),
          event: rec.event,
          attempts: (rec.attempts ?? 0) + 1,
          lastAttemptAt: at,
          lastError: error,
          status: "failed",
        }
        store.put(next)
      }
    }
  })
  notifyOutboxChanged()
}

/**
 * Revive records back to `pending` so the flusher will retry them: clears
 * `status` to pending, resets `attempts` to 0, and drops `lastError`. Used by
 * the inspector's explicit "Retry" affordance for quarantined/`failed` records
 * (403 no-permission / stuck). The caller should also nudge the flusher
 * (reset backoff + force a flush) so the retry happens immediately rather than
 * after the next backoff window.
 */
export async function requeueOutboxEvents(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => resolve()
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      const getReq = store.get(id)
      getReq.onsuccess = () => {
        const rec = getReq.result as Partial<OutboxRecord> | undefined
        if (!rec || !rec.id || !rec.event) return
        const next: OutboxRecord = {
          id: rec.id,
          enqueuedAt: rec.enqueuedAt ?? Date.now(),
          event: rec.event,
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
          status: "pending",
        }
        store.put(next)
      }
    }
  })
  notifyOutboxChanged()
}

/**
 * RES-2: Re-enqueue all `failed` records that failed due to transient errors
 * (status 0 or 5xx, stamped WITHOUT burning the budget by stampOutboxError).
 * Records permanently quarantined by 4xx errors are left untouched.
 *
 * Call this on network reconnect or authEpoch change so a temporary outage
 * (short connectivity loss, server restart) doesn't permanently strand edits
 * after the max-attempt cap would have been reached under the old policy.
 * The caller should also call flushNow() to drain immediately.
 */
export async function requeueTransientlyFailedOutboxEvents(): Promise<void> {
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => resolve()
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    const req = store.openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return
      const rec = cursor.value as Partial<OutboxRecord>
      // Only revive records whose last error was transient (status 0 or 5xx).
      // 4xx quarantines are permanent and must survive a reconnect.
      if (
        rec.status === "failed" &&
        rec.lastError != null &&
        (rec.lastError.status === 0 || rec.lastError.status >= 500)
      ) {
        const next: OutboxRecord = {
          id: rec.id!,
          enqueuedAt: rec.enqueuedAt ?? Date.now(),
          event: rec.event!,
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
          status: "pending",
        }
        cursor.update(next)
      }
      cursor.continue()
    }
  })
  notifyOutboxChanged()
}

export async function removeOutboxEvents(ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("remove tx failed"))
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      store.delete(id)
    }
  })
  notifyOutboxChanged()
}

export async function outboxPendingCount(): Promise<number> {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("count tx failed"))
      const req = tx.objectStore(STORE).count()
      req.onsuccess = () => resolve(req.result)
    })
  } catch {
    return 0
  }
}
