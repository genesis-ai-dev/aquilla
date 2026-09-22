/**
 * IndexedDB-backed outbox for CQRS events (Phase 2). Survives tab close;
 * drained by the flusher hook with idempotent POST /events retries.
 *
 * Records carry per-attempt status so the inspector UI can distinguish
 * "just enqueued" from "retried, kept by the server" (401/403 quarantine
 * waiting on a fresh token). Updates are best-effort via `markOutboxAttempt`;
 * a failed write doesn't block the flusher.
 *
 * Tauri desktop offline routing (Phase 4): `enqueueOutboxEvent(s)` first check
 * whether the event should instead land in LiveStore's local `event_queue`
 * (src/lib/offline/schema.ts) — see `routeToOfflineQueueIfEligible` below.
 * This is a no-op everywhere except the Tauri desktop app, so the browser
 * SPA's write path (the vast majority of real traffic) is unaffected.
 */

import type { CqrsRawEvent, OutboxEventKind } from "./outbox-types"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { journalTargetCommit, clearJournalRecord, recoverJournal } from "./outbox-recovery"

const DB_NAME = "aquilla-cqrs-outbox"
/** v3: new records carry the account that created them. */
const DB_VERSION = 3
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
  /** Canonical account key that created this event; null is local-only mode.
   * Undefined exists only on legacy v1/v2 rows until they are claimed. */
  ownerKey?: string | null
  /**
   * SUB-8 (AQU-633 follow-up): wallclock when the user acknowledged this
   * FAILED record's banner ("Dismiss"). Persisted so the forbidden banner
   * doesn't resurrect the same refusal on every reload; the record itself
   * stays visible in the outbox inspector until discarded. Cleared by
   * `requeueOutboxEvents` — a retried-then-refused change must banner again.
   * Absent/undefined = not acknowledged.
   */
  acknowledgedAt?: number
}

let dbPromise: Promise<IDBDatabase> | null = null
let activeOwnerKey: string | null | undefined
let activeOwnerVersion = 0

/**
 * Explicit account boundary for background work. Foreground callers omit this
 * and continue to follow the currently published account boundary.
 */
export interface OutboxOwnerScope {
  ownerKey: string | null
}

/** Set synchronously with the app's published account boundary. */
export function setActiveOutboxOwner(ownerKey: string | null): void {
  if (activeOwnerKey === ownerKey) return
  activeOwnerKey = ownerKey
  activeOwnerVersion += 1
  notifyOutboxChanged()
}

/** Monotonic fence for async work that must not span an account switch. */
export function getActiveOutboxOwnerVersion(): number {
  return activeOwnerVersion
}

function belongsToOwner(
  record: Pick<OutboxRecord, "ownerKey">,
  ownerKey: string | null | undefined,
): boolean {
  return ownerKey === undefined || record.ownerKey === ownerKey
}

function ownerForScope(scope?: OutboxOwnerScope): string | null | undefined {
  return scope ? scope.ownerKey : activeOwnerKey
}

function belongsToMutationScope(
  record: Pick<OutboxRecord, "ownerKey">,
  scope?: OutboxOwnerScope,
): boolean {
  return !scope || record.ownerKey === scope.ownerKey
}

/**
 * Upgrade bridge for rows written before account ownership existed. The first
 * hydrated signed-in account claims them; legacy builds only had one effective
 * writer at a time, and leaving them unowned would silently strand edits.
 */
export async function claimLegacyOutboxEvents(ownerKey: string | null): Promise<void> {
  const db = await openDb()
  let changed = false
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("legacy outbox claim failed"))
    tx.oncomplete = () => resolve()
    const request = tx.objectStore(STORE).openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const record = cursor.value as OutboxRecord
      if (record.ownerKey === undefined) {
        changed = true
        cursor.update({ ...record, ownerKey })
      }
      cursor.continue()
    }
  })
  if (changed) notifyOutboxChanged()
}

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
  activeOwnerKey = undefined
  activeOwnerVersion = 0
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
      req.onsuccess = () => {
        void recoverJournal(req.result, STORE).then(() => resolve(req.result), (error) => {
          req.result.close()
          dbPromise = null
          reject(error)
        })
      }
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
              ownerKey: rec.ownerKey,
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

/**
 * Tauri desktop offline routing (Phase 4): the three event kinds that make
 * sense to keep working entirely offline. Everything else (cell
 * create/delete/reorder, comments, terminology, …) always goes through the
 * normal IndexedDB → HTTP outbox path, even offline in Tauri — the UI is
 * expected to disable those controls when offline; this module isn't
 * responsible for blocking them.
 */
const OFFLINE_ROUTABLE_KINDS: ReadonlySet<OutboxEventKind> = new Set<OutboxEventKind>([
  "target.cell.commit",
  "cell.validate",
  "cell.unvalidate",
])

/**
 * Tauri-only: if `event` is one of the offline-routable kinds AND its project
 * has a ready local LiveStore copy, commit it straight into LiveStore's
 * `event_queue` (Phase 3's sync adapter owns flushing those to the server) and
 * return true — the caller must NOT also write it to IndexedDB.
 *
 * The LiveStore-backed modules (store.ts, offline-reads.ts, schema.ts) are
 * dynamically imported here rather than statically at the top of this file:
 * this file is on every web-build code path, and is-tauri.ts's whole reason
 * for existing separately is to let modules like this one check the runtime
 * without pulling LiveStore/OPFS/wa-sqlite into the plain browser SPA bundle.
 * Checking the kind first (a synchronous Set lookup) also means the common
 * case — an event kind that never routes offline — never pays for the import
 * or a store round-trip at all.
 */
async function routeToOfflineQueueIfEligible(event: CqrsRawEvent): Promise<boolean> {
  if (!OFFLINE_ROUTABLE_KINDS.has(event.kind)) return false
  const [{ getOfflineStore }, { isProjectOfflineReady }, { events: offlineEvents }] = await Promise.all([
    import("@/lib/offline/store"),
    import("@/lib/offline/offline-reads"),
    import("@/lib/offline/schema"),
  ])
  const store = await getOfflineStore()
  if (!isProjectOfflineReady(store, event.projectId)) return false
  store.commit(
    offlineEvents.eventQueued({
      id: event.id,
      projectId: event.projectId,
      fileId: event.fileId ?? null,
      cellId: event.cellId ?? null,
      kind: event.kind,
      payload: event.payload,
      parentId: event.parentId ?? null,
      author: event.author,
      schemaVersion: event.schemaVersion,
      clientTs: new Date(event.clientTs),
      createdAt: new Date(),
    }),
  )
  return true
}

export async function enqueueOutboxEvent(event: CqrsRawEvent): Promise<void> {
  // Tauri desktop offline routing (Phase 4): eligible kinds on a
  // ready-for-offline project bypass IndexedDB entirely — LiveStore's
  // event_queue (+ its own sync adapter) fully replaces the IDB outbox for
  // these. `isTauriRuntime()` is a zero-cost check on the web, so this branch
  // adds no overhead to the browser SPA's write path.
  if (isTauriRuntime() && (await routeToOfflineQueueIfEligible(event))) return

  // Capture before IndexedDB opens. A transition that lands during that await
  // must not reclassify an edit initiated by the previous account.
  const ownerKey = activeOwnerKey
  const rec: OutboxRecord = {
    id: event.id,
    enqueuedAt: Date.now(),
    event,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    status: "pending",
    ownerKey,
  }
  // pagehide cannot await openDb or a transaction. Persist the same event
  // synchronously first, preserving the account that initiated this write.
  if (ownerKey !== undefined) journalTargetCommit(rec)
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("enqueue tx failed"))
    tx.oncomplete = () => resolve()
    tx.objectStore(STORE).put(rec)
  })
  clearJournalRecord(event.id)
  notifyOutboxChanged()
}

/** Enqueue many events in ONE transaction and fire a SINGLE change
 *  notification. Used by bulk import so a large batch produces one overlay
 *  rebuild + one badge refresh instead of N. Same-id `put` overwrites, so a
 *  re-enqueue of already-queued events is a no-op (idempotent).
 *
 *  Tauri desktop offline routing (Phase 4): the batch is partitioned first —
 *  events eligible for offline routing (see `routeToOfflineQueueIfEligible`)
 *  are committed individually into LiveStore's event_queue and never touch
 *  IndexedDB; the remainder still go through the one-transaction/one-notify
 *  IndexedDB write below, unchanged. */
export async function enqueueOutboxEvents(events: CqrsRawEvent[]): Promise<void> {
  if (events.length === 0) return

  let remaining = events
  if (isTauriRuntime()) {
    const toIndexedDb: CqrsRawEvent[] = []
    for (const event of events) {
      if (!(await routeToOfflineQueueIfEligible(event))) toIndexedDb.push(event)
    }
    remaining = toIndexedDb
  }
  if (remaining.length === 0) return

  const ownerKey = activeOwnerKey
  const db = await openDb()
  const now = Date.now()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("bulk enqueue tx failed"))
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const event of remaining) {
      const rec: OutboxRecord = {
        id: event.id,
        enqueuedAt: now,
        event,
        attempts: 0,
        lastAttemptAt: null,
        lastError: null,
        status: "pending",
        ownerKey,
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
  scope?: OutboxOwnerScope,
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
        if (!rec || !rec.id || !rec.event || !belongsToMutationScope(rec, scope)) return
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
          ownerKey: rec.ownerKey,
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
  scope?: OutboxOwnerScope,
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
        if (!rec || !rec.id || !rec.event || !belongsToMutationScope(rec, scope)) return
        const next: OutboxRecord = {
          id: rec.id,
          enqueuedAt: rec.enqueuedAt ?? Date.now(),
          event: rec.event,
          attempts: rec.attempts ?? 0,
          lastAttemptAt: at,
          lastError: error,
          status: (rec.status as OutboxRecord["status"]) ?? "pending",
          ownerKey: rec.ownerKey,
        }
        store.put(next)
      }
    }
  })
  notifyOutboxChanged()
}

/** Oldest-first rows (all statuses), at most `limit`. */
export async function peekOutboxBatch(
  limit: number,
  scope?: OutboxOwnerScope,
): Promise<OutboxRecord[]> {
  const ownerKey = ownerForScope(scope)
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
        const record = cursor.value as OutboxRecord
        if (belongsToOwner(record, ownerKey)) out.push(record)
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
  const ownerKey = activeOwnerKey
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
          if (record?.id && record.event && belongsToOwner(record, ownerKey)) records.push(record)
        }
      }
    })
  } catch {
    return []
  }
}

/**
 * Return every locally durable event for one cell, oldest first. History uses
 * this instead of a capped global peek so a busy project cannot push the
 * current cell's unflushed commit outside an arbitrary batch window.
 */
/**
 * FORTIFY (SUB-48 across reloads): every UNDELIVERED cell.audio.* record for
 * a file, in enqueue order. The optimistic-shadow registry is memory-only, so
 * after a reload a queued attach/remove was invisible until the flusher
 * delivered it — the take "vanished" for up to minutes. The bus rehydrates
 * shadows from these on a file's first read of the session.
 *
 * AQU-924: `failed` records are returned alongside `pending` ones. Restricting
 * this to `pending` meant a quarantined / retry-exhausted attach was skipped on
 * reload, so an uploaded clip disappeared from the cell entirely — no waveform,
 * no error, no retry — even though its bytes were in R2 and its event was still
 * durable right here. A record that never reached the server is exactly the one
 * the user most needs to see; the bus paints it as `syncFailed` (not "saving"),
 * and delivered records are DELETED from the store, so nothing already saved
 * can be resurrected by this.
 */
export async function getOutboxFileAudioRecords(
  projectId: string,
  fileId: string,
): Promise<OutboxRecord[]> {
  const ownerKey = activeOwnerKey
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const records: OutboxRecord[] = []
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("file audio outbox lookup failed"))
      const request = tx.objectStore(STORE).index("enqueuedAt").openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve(records)
          return
        }
        const record = cursor.value as OutboxRecord
        const event = record.event
        if (
          belongsToOwner(record, ownerKey) &&
          (record.status === "pending" || record.status === "failed") &&
          event.projectId === projectId &&
          event.fileId === fileId &&
          typeof event.kind === "string" &&
          event.kind.startsWith("cell.audio.")
        ) {
          records.push(record)
        }
        cursor.continue()
      }
    })
  } catch {
    return []
  }
}

export async function getOutboxRecordsForCell(
  projectId: string,
  fileId: string,
  cellId: string,
): Promise<OutboxRecord[]> {
  const ownerKey = activeOwnerKey
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const records: OutboxRecord[] = []
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("cell outbox lookup failed"))
      const store = tx.objectStore(STORE)
      const index = store.index("enqueuedAt")
      const request = index.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve(records)
          return
        }
        const record = cursor.value as OutboxRecord
        const event = record.event
        if (
          belongsToOwner(record, ownerKey) &&
          event.projectId === projectId &&
          event.fileId === fileId &&
          event.cellId === cellId
        ) {
          records.push(record)
        }
        cursor.continue()
      }
    })
  } catch {
    return []
  }
}

/** Oldest-first rows with status `pending` only, at most `limit`. Used by the flusher. */
export async function peekPendingOutboxBatch(
  limit: number,
  scope?: OutboxOwnerScope,
): Promise<OutboxRecord[]> {
  const ownerKey = ownerForScope(scope)
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const pending: OutboxRecord[] = []
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("pending outbox peek failed"))
      const request = tx.objectStore(STORE).index("enqueuedAt").openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor || pending.length >= limit) {
          resolve(pending)
          return
        }
        const record = cursor.value as OutboxRecord
        if (belongsToOwner(record, ownerKey) && (record.status ?? "pending") === "pending") {
          pending.push(record)
        }
        cursor.continue()
      }
    })
  } catch {
    return []
  }
}

/** Count of records that have permanently failed (exceeded retry cap). */
export async function outboxFailedCount(scope?: OutboxOwnerScope): Promise<number> {
  const ownerKey = ownerForScope(scope)
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
        const record = cursor.value as OutboxRecord
        if (belongsToOwner(record, ownerKey) && record.status === "failed") count++
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
  scope?: OutboxOwnerScope,
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
        if (!rec || !rec.id || !rec.event || !belongsToMutationScope(rec, scope)) return
        const next: OutboxRecord = {
          id: rec.id,
          enqueuedAt: rec.enqueuedAt ?? Date.now(),
          event: rec.event,
          attempts: (rec.attempts ?? 0) + 1,
          lastAttemptAt: at,
          lastError: error,
          status: "failed",
          ownerKey: rec.ownerKey,
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
export async function requeueOutboxEvents(
  ids: string[],
  scope?: OutboxOwnerScope,
): Promise<void> {
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
        if (!rec || !rec.id || !rec.event || !belongsToMutationScope(rec, scope)) return
        const next: OutboxRecord = {
          id: rec.id,
          enqueuedAt: rec.enqueuedAt ?? Date.now(),
          event: rec.event,
          attempts: 0,
          lastAttemptAt: null,
          lastError: null,
          status: "pending",
          ownerKey: rec.ownerKey,
          // acknowledgedAt intentionally omitted (SUB-8): a retried record
          // that gets refused again is a NEW refusal and must banner again.
        }
        store.put(next)
      }
    }
  })
  notifyOutboxChanged()
}

/**
 * SUB-8 (AQU-633 follow-up): mark FAILED records as user-acknowledged so the
 * forbidden banner stops resurfacing them across reloads. Non-destructive —
 * the record keeps its status/lastError and stays in the inspector (where it
 * can be retried or discarded). No-op for ids that don't exist.
 */
export async function acknowledgeOutboxEvents(
  ids: string[],
  scope?: OutboxOwnerScope,
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
        const rec = getReq.result as OutboxRecord | undefined
        if (!rec || !rec.id || !rec.event || !belongsToMutationScope(rec, scope)) return
        store.put({ ...rec, acknowledgedAt: at })
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
export async function requeueTransientlyFailedOutboxEvents(
  scope?: OutboxOwnerScope,
): Promise<void> {
  const ownerKey = ownerForScope(scope)
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
        belongsToOwner(rec, ownerKey) &&
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
          ownerKey: rec.ownerKey,
        }
        cursor.update(next)
      }
      cursor.continue()
    }
  })
  notifyOutboxChanged()
}

export async function removeOutboxEvents(
  ids: string[],
  scope?: OutboxOwnerScope,
): Promise<void> {
  if (ids.length === 0) return
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.onerror = () => reject(tx.error ?? new Error("remove tx failed"))
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      if (!scope) {
        store.delete(id)
        continue
      }
      const request = store.get(id)
      request.onsuccess = () => {
        const record = request.result as OutboxRecord | undefined
        if (record && belongsToMutationScope(record, scope)) store.delete(id)
      }
    }
  })
  notifyOutboxChanged()
}

export async function outboxPendingCount(scope?: OutboxOwnerScope): Promise<number> {
  const ownerKey = ownerForScope(scope)
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("count tx failed"))
      let count = 0
      const req = tx.objectStore(STORE).openCursor()
      req.onsuccess = () => {
        const cursor = req.result
        if (!cursor) { resolve(count); return }
        if (belongsToOwner(cursor.value as OutboxRecord, ownerKey)) count++
        cursor.continue()
      }
    })
  } catch {
    return 0
  }
}

/** Total durable records across every owner, used only by sign-out-all UX. */
export async function outboxRecordCountAllOwners(): Promise<number> {
  try {
    const db = await openDb()
    return await new Promise<number>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly")
      tx.onerror = () => reject(tx.error ?? new Error("all-owner count tx failed"))
      const request = tx.objectStore(STORE).count()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error("all-owner count failed"))
    })
  } catch {
    return 0
  }
}
