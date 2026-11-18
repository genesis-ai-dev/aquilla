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
 * (src/lib/offline/schema.ts) — see `planOfflineRouting` in offline-routing.ts.
 * This is a no-op everywhere except the Tauri desktop app, so the browser
 * SPA's write path (the vast majority of real traffic) is unaffected.
 */

import type { CqrsRawEvent } from "./outbox-types"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import {
  journalTargetCommit,
  clearJournalRecord,
  journalBatch,
  splitForJournal,
  clearJournalBatch,
  readJournal,
  journalKeysLockedElsewhere,
  clearJournal,
  releaseJournal,
  forgetInFlightJournalForTests,
  addOutboxRecords,
  type JournalContents,
} from "./outbox-recovery"
import { planOfflineRouting } from "./offline-routing"
import {
  holdJournalUntilPersisted,
  rescueUnpersistedOfflineWrites as rescueStalledOfflineWrites,
  type WhenPersisted,
} from "./offline-stall-rescue"
import { purgeCellsCacheForQuota } from "./cells-cache"
import { withStorageQuotaRecovery } from "@/lib/storage/storage-pressure"

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
  heldIds.clear()
  forgetInFlightJournalForTests()
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
        const db = req.result
        // Entries another live tab or window is still writing are its own;
        // replaying them here would queue them a second time.
        void journalKeysLockedElsewhere().then((lockedElsewhere) => {
          // Recover before exposing the database to readers or the flusher.
          const journal = readJournal(lockedElsewhere)
          if (journal.records.length === 0) {
            clearJournal(journal.keys)
            resolve(db)
            return
          }
          // On desktop a recovered edit may belong in the offline queue, next
          // to the edits it chains on. Finding out can wait on the offline
          // store (bounded by its boot timeout), and readers still wait for
          // it: an editor that opened first would show server text and chain
          // the next commit on the server head, a sibling of the recovered one.
          // Only a launch with something to recover pays this.
          if (isTauriRuntime()) {
            void recoverIntoQueues(db, journal).finally(() => resolve(db))
            return
          }
          addOutboxRecords(db, STORE, journal.records).then(() => {
            clearJournal(journal.keys)
            resolve(db)
          }, (error: unknown) => {
            releaseJournal(journal.keys)
            db.close()
            dbPromise = null
            reject(error)
          })
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

/** Which of `ids` are in the outbox, in any status and for any account. */
async function lookupOutboxIds(ids: readonly string[]): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set()
  // An id whose write is still running may be on its way into IndexedDB:
  // wait for where it went rather than miss it (a write only ever waits on
  // earlier ones, so this can't deadlock).
  const found = new Set<string>()
  const unsettled: string[] = []
  await Promise.all(ids.map(async (id) => {
    const destination = writeDestinations.get(id)
    if (destination && (await destination).has(id)) found.add(id)
    else unsettled.push(id)
  }))
  for (const id of await lookupOutboxIdsIn(await openDb(), unsettled)) found.add(id)
  return found
}

/** Which of `ids` are in the IndexedDB outbox, in any status (any owner). */
export function outboxHasIds(ids: readonly string[]): Promise<ReadonlySet<string>> {
  return lookupOutboxIds(ids)
}

/**
 * Writes still running in this page, by event id: each resolves to the ids
 * that write put (or is putting) in IndexedDB, once it has decided — so a
 * write that chains on one of them, routing meanwhile, sees a parent that
 * is headed for IndexedDB but not there yet, and stays in the same queue.
 */
const writeDestinations = new Map<string, Promise<ReadonlySet<string>>>()

/** `lookupOutboxIds` on an already-open database (recovery runs before openDb resolves). */
async function lookupOutboxIdsIn(db: IDBDatabase, ids: readonly string[]): Promise<ReadonlySet<string>> {
  const found = new Set<string>()
  if (ids.length === 0) return found
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly")
    tx.onerror = () => reject(tx.error ?? new Error("outbox lookup failed"))
    // An abort without a request error fires neither of the others.
    tx.onabort = () => reject(tx.error ?? new Error("outbox lookup aborted"))
    tx.oncomplete = () => resolve()
    const store = tx.objectStore(STORE)
    for (const id of ids) {
      const request = store.getKey(id)
      request.onsuccess = () => {
        if (request.result !== undefined) found.add(id)
      }
    }
  })
  return found
}

/**
 * Desktop crash recovery: replays journaled records through the same offline
 * routing a live enqueue takes, so a recovered commit lands in the queue its
 * parent is waiting in instead of always in IndexedDB. Only the signed-in
 * account's records may take the offline queue (as with a live enqueue);
 * anything else, and everything when no account is known yet, waits in
 * IndexedDB under its own owner. On failure the journal stays for next launch.
 */
async function recoverIntoQueues(db: IDBDatabase, { records, keys }: JournalContents): Promise<void> {
  try {
    // Already queued in IndexedDB: the crash came after that write landed.
    const lookup = (ids: readonly string[]) => lookupOutboxIdsIn(db, ids)
    const present = await lookup(records.map((record) => record.id))
    const pending = records.filter((record) => !present.has(record.id))
    const owner = activeOwnerKey
    const routable = owner === undefined ? [] : pending.filter((record) => record.ownerKey === owner)
    const routing = routable.length > 0
      ? await planOfflineRouting(routable.map((record) => record.event), lookup)
      : null
    const routedIds = new Set(routing?.routed.map((event) => event.id))
    await addOutboxRecords(db, STORE, pending.filter((record) => !routedIds.has(record.id)))
    let whenPersisted: WhenPersisted | null = null
    if (routing && routedIds.size > 0) {
      try {
        whenPersisted = routing.commit()
      } catch (error) {
        console.warn("[outbox] Offline queue refused recovered edits; using the HTTP outbox", error)
        await addOutboxRecords(db, STORE, pending.filter((record) => routedIds.has(record.id)))
      }
    }
    if (whenPersisted) {
      holdJournalUntilPersisted(pending.filter((record) => routedIds.has(record.id)), whenPersisted, () => clearJournal(keys))
    } else {
      clearJournal(keys)
    }
    if (pending.length > 0) notifyOutboxChanged()
  } catch (error) {
    releaseJournal(keys)
    console.warn("[outbox] Couldn't recover journaled edits; will retry on next launch", error)
  }
}

/**
 * The offline store's leader has stopped persisting (OfflineLeaderWatchdog):
 * copies every edit it hasn't confirmed into the IndexedDB outbox, so a
 * restart, or the page dying, can't lose it, and it uploads over HTTP when
 * online. See offline-stall-rescue.ts.
 */
export async function rescueUnpersistedOfflineWrites(): Promise<boolean> {
  let copied = false
  const safe = await rescueStalledOfflineWrites(async (records) => {
    // Add-not-put: an id already in IndexedDB keeps its state.
    await addRecordsWithQuotaRecovery(records)
    copied = true
  })
  if (copied) notifyOutboxChanged()
  return safe
}

/**
 * Ids an `enqueueOutboxEvents` in this page has written to IndexedDB but may
 * still take back (its offline commit and fallback haven't settled). The
 * flusher leaves them alone until then, so an undo never removes a record the
 * server already has.
 */
const heldIds = new Set<string>()

/**
 * Run an outbox write, reclaiming origin bytes once if the browser says there is
 * no room (AQU-1865).
 *
 * Every durable store in this app shares one origin quota, and the caches —
 * cells snapshots above all — are far the biggest tenants. They are also the
 * only disposable ones: re-reading a projection costs a round trip, while a
 * dropped outbox record costs a contributor their edit. So a `QuotaExceededError`
 * on an enqueue buys itself room by emptying the cells cache and tries again,
 * instead of handing the caller a failure it cannot do anything about.
 */
function withOutboxQuotaRecovery(write: () => Promise<void>): Promise<void> {
  // A second failure is a genuinely full disk with nothing left to reclaim, and
  // `withStorageQuotaRecovery` lets it propagate — the journal and the caller's
  // error handling are what keep the edit recoverable from there.
  return withStorageQuotaRecovery(write, purgeCellsCacheForQuota)
}

/** A fresh pending outbox record for `event`. */
function toOutboxRecord(event: CqrsRawEvent, ownerKey: OutboxRecord["ownerKey"], enqueuedAt: number): OutboxRecord {
  return {
    id: event.id,
    enqueuedAt,
    event,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    status: "pending",
    ownerKey,
  }
}

export async function enqueueOutboxEvent(event: CqrsRawEvent, scope?: OutboxOwnerScope): Promise<void> {
  // Capture before any await. A transition that lands during one must not
  // reclassify an edit initiated by the previous account.
  const ownerKey = ownerForScope(scope)
  const rec = toOutboxRecord(event, ownerKey, Date.now())
  // pagehide cannot await the offline store, openDb or a transaction. Persist
  // the same event synchronously first, preserving the account that
  // initiated this write.
  if (ownerKey !== undefined) journalTargetCommit(rec)
  // Tauri desktop offline routing (Phase 4): eligible kinds on a
  // ready-for-offline project bypass IndexedDB entirely — LiveStore's
  // event_queue (+ its own sync adapter) fully replaces the IDB outbox for
  // these. `isTauriRuntime()` is a zero-cost check on the web, so this branch
  // adds no overhead to the browser SPA's write path.
  // A scoped (guest) write never takes the signed-in desktop's offline queue.
  // Same write as a batch of one, so both entry points share idempotency (an
  // already-queued id keeps its attempts and quarantine state) and failure
  // handling (the journal entry goes either way: a refusal means not queued).
  await writeOutboxRecords([rec], {
    routeOffline: !scope && isTauriRuntime(),
    clearJournal: () => clearJournalRecord(event.id),
  })
}

/** Enqueue many events in ONE transaction and fire a SINGLE change
 *  notification. Used by bulk import so a large batch produces one overlay
 *  rebuild + one badge refresh instead of N. An id that is already queued is
 *  left as it is (its attempts and quarantine state included), so a
 *  re-enqueue of already-queued events is a no-op (idempotent).
 *
 *  Tauri desktop offline routing (Phase 4): the batch is partitioned first —
 *  events eligible for offline routing (see `planOfflineRouting`)
 *  are committed together into LiveStore's event_queue and never touch
 *  IndexedDB; the remainder go through the one-transaction/one-notify
 *  IndexedDB write below, which runs first. */
export async function enqueueOutboxEvents(
  events: CqrsRawEvent[],
  options: EnqueueBatchOptions = {},
): Promise<void> {
  if (events.length === 0) return

  // Capture before any await, as enqueueOutboxEvent does: routing can wait
  // seconds for the offline store, and an account switch in that window must
  // not reassign these edits to the next account.
  const ownerKey = activeOwnerKey
  const now = Date.now()
  const records = events.map((event) => toOutboxRecord(event, ownerKey, now))
  // Journal the whole batch as one entry, so pagehide recovery restores all of
  // it or none (a commit is never replayed without its create). Too big a
  // batch (replace-all, import) stays out of localStorage, which it could fill.
  if (!options.splitToJournal || ownerKey === undefined) {
    await writeJournaledBatch(records, ownerKey)
    return
  }
  // In order, each run its own transaction, offline commit and journal
  // entry, so at most one run's worth sits in localStorage at a time.
  for (const run of splitForJournal(records)) await writeJournaledBatch(run, ownerKey)
}

export interface EnqueueBatchOptions {
  /**
   * A batch too big to journal whole is written as consecutive runs that
   * each fit, instead of going unjournaled. Reload recovery then covers all
   * of it, but a failure part way leaves the runs before it queued — use it
   * only where the events would otherwise be enqueued one by one (agent
   * apply), never where all-or-nothing matters more than recovery.
   */
  splitToJournal?: boolean
}

/** One batch write, journaled whole when it fits (or, for a lone target
 *  commit too big for a batch entry, under its own per-commit entry). */
async function writeJournaledBatch(records: OutboxRecord[], ownerKey: OutboxRecord["ownerKey"] | undefined): Promise<void> {
  let clearEntry = () => {}
  if (ownerKey !== undefined) {
    const journalKey = journalBatch(records)
    if (journalKey) {
      clearEntry = () => clearJournalBatch(journalKey)
    } else if (records.length === 1 && records[0].event.kind === "target.cell.commit") {
      journalTargetCommit(records[0])
      clearEntry = () => clearJournalRecord(records[0].id)
    }
  }
  await writeOutboxRecords(records, { routeOffline: isTauriRuntime(), clearJournal: clearEntry })
}

/**
 * The write behind both enqueue entry points: routes what it can to the
 * offline queue (when `routeOffline`), adds the rest to IndexedDB without
 * overwriting ids already there, and clears the caller's journal entry once
 * the write has settled, failed or not — a refusal means nothing was queued,
 * so nothing may be replayed on the next launch either.
 */
async function writeOutboxRecords(
  records: readonly OutboxRecord[],
  { routeOffline, clearJournal }: { routeOffline: boolean; clearJournal: () => void },
): Promise<void> {
  const events = records.map((rec) => rec.event)
  const byEvent = new Map(records.map((rec) => [rec.event, rec]))
  const toRecords = (list: readonly CqrsRawEvent[]) => list.map((event) => byEvent.get(event)!)

  let wrote: boolean
  // Set once the offline queue took the routed events: their journal entry
  // then waits for the leader to persist them (holdJournalUntilPersisted).
  let offlineCommit: { routed: readonly OutboxRecord[]; whenPersisted: WhenPersisted } | null = null
  // Ids this call added to IndexedDB. A record that was already queued before
  // it (a re-enqueue) isn't ours to remove on failure.
  let added: string[] = []
  let held: string[] = []
  // Published before the first await, settled once the destination is known.
  let settle: (inIndexedDb: ReadonlySet<string>) => void = () => {}
  const destination = new Promise<ReadonlySet<string>>((resolve) => { settle = resolve })
  for (const rec of records) writeDestinations.set(rec.id, destination)
  try {
    const routing = routeOffline ? await planOfflineRouting(events, lookupOutboxIds) : null
    // IndexedDB first: if it fails, nothing has reached the offline queue
    // either, so a refusal means none of the batch was queued.
    const toWrite = routing ? toRecords(routing.rest) : records
    // A later step can still fail and undo this write: keep the flusher off
    // these records until then, so nothing undone has reached the server.
    if (routing && routing.routed.length > 0) {
      held = toWrite.map((rec) => rec.id)
      for (const id of held) heldIds.add(id)
    }
    added = await addRecordsWithQuotaRecovery(toWrite)
    wrote = toWrite.length > 0
    const inIndexedDb = new Set(toWrite.map((rec) => rec.id))
    if (routing && routing.routed.length > 0) {
      try {
        offlineCommit = { routed: toRecords(routing.routed), whenPersisted: routing.commit() }
      } catch (error) {
        // The offline store refused them (shut down, a materializer error):
        // send them over HTTP instead, so the batch still lands whole.
        console.warn("[outbox] Offline queue refused a batch; using the HTTP outbox", error)
        for (const event of routing.routed) inIndexedDb.add(event.id)
        settle(inIndexedDb)
        added = [...added, ...(await addRecordsWithQuotaRecovery(toRecords(routing.routed)))]
        wrote = true
      }
    }
    settle(inIndexedDb)
  } catch (error) {
    // Undo what did land, so the caller's retry can't queue it twice.
    if (added.length > 0) {
      await removeOutboxEvents(added).catch((cleanupError: unknown) => {
        console.warn("[outbox] Couldn't undo a partly queued batch", cleanupError)
      })
    }
    clearJournal()
    throw error
  } finally {
    for (const id of held) heldIds.delete(id)
    // A failed write queued nothing (its rows were undone above).
    settle(new Set())
    for (const rec of records) {
      if (writeDestinations.get(rec.id) === destination) writeDestinations.delete(rec.id)
    }
  }
  if (offlineCommit) holdJournalUntilPersisted(offlineCommit.routed, offlineCommit.whenPersisted, clearJournal)
  else clearJournal()
  if (wrote) notifyOutboxChanged()
}

/**
 * Adds `records` to the IndexedDB outbox in one transaction, and returns the
 * ids that weren't already in it (those it leaves untouched).
 */
async function addRecordsWithQuotaRecovery(records: readonly OutboxRecord[]): Promise<string[]> {
  if (records.length === 0) return []
  const db = await openDb()
  let added: string[] = []
  await withOutboxQuotaRecovery(async () => {
    added = await addOutboxRecords(db, STORE, records)
  })
  return added
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

/** Oldest-first rows with status `pending` only, at most `limit`. Used by the flusher.
 *  `skip` drops rows the caller is deliberately holding back (OPS-44) before
 *  they count toward `limit`, so a large held backlog cannot fill the window
 *  and hide the rows behind it. */
export async function peekPendingOutboxBatch(
  limit: number,
  scope?: OutboxOwnerScope,
  skip?: (record: OutboxRecord) => boolean,
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
        if (
          belongsToOwner(record, ownerKey) &&
          (record.status ?? "pending") === "pending" &&
          !heldIds.has(record.id) &&
          !skip?.(record)
        ) {
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

/** Throws when IndexedDB is unreadable (unlike `outboxPendingCount`), so unreadable ≠ empty. */
export async function readOutboxCounts(scope?: OutboxOwnerScope): Promise<{ count: number; failed: number }> {
  const ownerKey = ownerForScope(scope)
  const db = await openDb()
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly")
    tx.onerror = () => reject(tx.error ?? new Error("count tx failed"))
    let count = 0
    let failed = 0
    const req = tx.objectStore(STORE).openCursor()
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) { resolve({ count, failed }); return }
      const record = cursor.value as OutboxRecord
      if (belongsToOwner(record, ownerKey)) {
        count++
        if (record.status === "failed") failed++
      }
      cursor.continue()
    }
  })
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
