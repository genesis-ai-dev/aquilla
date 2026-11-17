import { v7 as uuidv7 } from "uuid"
import type { OutboxRecord } from "./outbox"

const PREFIX = "aquilla:outbox-recovery:v1:"
const BATCH_PREFIX = "aquilla:outbox-recovery:batch:v1:"

// Largest batch journal entry, in UTF-16 code units (~2 bytes each). The
// origin's ~5MB Web Storage quota is shared with the prefs store.
const BATCH_JOURNAL_MAX_CHARS = 256 * 1024
// Above this many events, don't even look at the batch's size.
const BATCH_JOURNAL_MAX_EVENTS = 500

/**
 * Journal keys whose write is still running in this page. Recovery leaves
 * them alone: the outbox database can first open (and recover) while an
 * enqueue is between journaling and writing, and replaying its entry then
 * would queue the same events a second time — in IndexedDB as well as the
 * offline queue the enqueue is about to commit them to.
 */
const inFlight = new Set<string>()

const LOCK_PREFIX = "aquilla:outbox-journal:"
/** Releases the cross-page lock on each of this page's journal entries. */
const lockReleases = new Map<string, () => void>()

function webLocks(): LockManager | null {
  return typeof navigator !== "undefined" && navigator.locks ? navigator.locks : null
}

/**
 * Hold a Web Lock named for `key` until the entry is cleared, so another
 * page's recovery can tell the entry is still being written (localStorage is
 * shared across tabs and windows; `inFlight` only covers this page). A page
 * that dies releases its locks, so a crashed page's entries become
 * recoverable as soon as it is gone.
 */
function lockJournalKey(key: string): void {
  const locks = webLocks()
  if (!locks) return
  void locks.request(LOCK_PREFIX + key, () => new Promise<void>((resolve) => {
    // Cleared before the lock was even granted: let it go at once.
    if (!inFlight.has(key)) resolve()
    else lockReleases.set(key, resolve)
  })).catch(() => { /* recovery falls back to inFlight alone */ })
}

/**
 * Journal keys another live page is still writing (its lock held or
 * requested), so recovery leaves them to it. Empty without Web Locks.
 */
export async function journalKeysLockedElsewhere(): Promise<ReadonlySet<string>> {
  const locks = webLocks()
  if (!locks) return new Set()
  try {
    const { held = [], pending = [] } = await locks.query()
    const keys = new Set<string>()
    for (const { name } of [...held, ...pending]) {
      if (name?.startsWith(LOCK_PREFIX)) keys.add(name.slice(LOCK_PREFIX.length))
    }
    return keys
  } catch {
    return new Set()
  }
}

/**
 * Bridge the document-teardown gap before an async IndexedDB transaction.
 * The record is the SAME account-scoped event envelope, not a second draft.
 * Per-event keys avoid cross-tab read/modify/write races. Server event IDs
 * make replay idempotent if a crash happens after IDB commits but before the
 * journal entry is removed. Single events journal only target commits;
 * `journalBatch` covers bulk writes small enough to fit.
 */
export function journalTargetCommit(record: OutboxRecord): void {
  if (record.event.kind !== "target.cell.commit") return
  const key = PREFIX + record.id
  inFlight.add(key)
  lockJournalKey(key)
  try {
    localStorage.setItem(key, JSON.stringify(record))
  } catch {
    // IndexedDB remains the normal writer when Web Storage is unavailable.
    console.warn("[outbox] Reload recovery storage unavailable; keep the page open until saved")
  }
}

export function clearJournalRecord(id: string): void {
  clearJournalKey(PREFIX + id)
}

/**
 * Rough JSON size of `value`, in characters, or Infinity once it passes
 * `budget` — so an oversized batch is rejected without serializing it.
 */
function estimateChars(value: unknown, budget: number): number {
  let total = 0
  const stack: unknown[] = [value]
  while (stack.length > 0) {
    const next = stack.pop()
    if (typeof next === "string") total += next.length + 2
    else if (next !== null && typeof next === "object") {
      for (const [key, child] of Object.entries(next)) {
        total += key.length + 4
        stack.push(child)
      }
    } else total += 8
    if (total > budget) return Infinity
  }
  return total
}

/**
 * Journal a whole bulk enqueue as ONE entry, so recovery restores all of it or
 * none: a commit is never replayed without the create it chains on, or a
 * validate without its edit. Returns the entry's key, or null when the batch
 * wasn't journaled — too big for the shared quota, or storage unavailable.
 * Each call gets its own key, so two in-flight batches never share one.
 */
export function journalBatch(records: readonly OutboxRecord[]): string | null {
  if (records.length === 0 || records.length > BATCH_JOURNAL_MAX_EVENTS) return null
  if (estimateChars(records, BATCH_JOURNAL_MAX_CHARS) > BATCH_JOURNAL_MAX_CHARS) return null
  const json = JSON.stringify(records)
  if (json.length > BATCH_JOURNAL_MAX_CHARS) return null
  const key = BATCH_PREFIX + uuidv7()
  inFlight.add(key)
  lockJournalKey(key)
  try {
    localStorage.setItem(key, json)
    return key
  } catch {
    clearJournalKey(key)
    console.warn("[outbox] Reload recovery storage unavailable; keep the page open until saved")
    return null
  }
}

/**
 * Splits `records`, in order, into consecutive runs `journalBatch` will take
 * whole. A single record too big for any run stands alone (and goes
 * unjournaled as a batch). Splitting gives up the batch's all-or-nothing:
 * only use it where the writes would otherwise go out one by one.
 */
export function splitForJournal(records: readonly OutboxRecord[]): OutboxRecord[][] {
  const runs: OutboxRecord[][] = []
  let run: OutboxRecord[] = []
  // JSON array brackets, plus a comma per record.
  let chars = 2
  for (const record of records) {
    const size = estimateChars(record, BATCH_JOURNAL_MAX_CHARS) + 1
    if (run.length > 0 && (run.length >= BATCH_JOURNAL_MAX_EVENTS || chars + size > BATCH_JOURNAL_MAX_CHARS)) {
      runs.push(run)
      run = []
      chars = 2
    }
    run.push(record)
    chars += size
  }
  if (run.length > 0) runs.push(run)
  return runs
}

export function clearJournalBatch(key: string): void {
  clearJournalKey(key)
}

function clearJournalKey(key: string): void {
  inFlight.delete(key)
  lockReleases.get(key)?.()
  lockReleases.delete(key)
  try { localStorage.removeItem(key) } catch { /* unavailable storage */ }
}

function isReplayable(record: OutboxRecord | null | undefined): record is OutboxRecord {
  return typeof record?.event?.kind === "string"
    && typeof record.id === "string" && record.id === record.event.id
    && (typeof record.ownerKey === "string" || record.ownerKey === null)
    && record.status === "pending"
}

/** What a previous page left in the journal. */
export interface JournalContents {
  /** Records to replay, each batch whole and in order. */
  records: OutboxRecord[]
  /** Every entry read, replayable or not; clear them once the records land. */
  keys: string[]
}

/**
 * Reads the entries a previous page left behind, skipping this page's own
 * in-flight writes and those another live page holds a lock on
 * (`journalKeysLockedElsewhere`). Malformed entries are listed in `keys` (to clear) but
 * contribute no records. The keys stay marked in flight until cleared, so a
 * recovery that hasn't finished isn't read twice.
 */
export function readJournal(lockedElsewhere: ReadonlySet<string> = new Set()): JournalContents {
  const records: OutboxRecord[] = []
  const keys: string[] = []
  try {
    for (const key of Object.keys(localStorage)) {
      if (inFlight.has(key) || lockedElsewhere.has(key)) continue
      if (key.startsWith(BATCH_PREFIX)) {
        keys.push(key)
        try {
          const batch = JSON.parse(localStorage.getItem(key) ?? "null") as OutboxRecord[] | null
          // All or nothing: a partial batch could replay a commit without its parent.
          if (Array.isArray(batch) && batch.length > 0 && batch.every(isReplayable)) records.push(...batch)
        } catch { /* malformed data cannot be replayed */ }
        continue
      }
      if (!key.startsWith(PREFIX)) continue
      keys.push(key)
      try {
        const record = JSON.parse(localStorage.getItem(key) ?? "null") as OutboxRecord | null
        if (isReplayable(record) && record.event.kind === "target.cell.commit"
          && key === PREFIX + record.id) records.push(record)
      } catch { /* malformed data cannot be replayed */ }
    }
  } catch { return { records: [], keys: [] } }
  for (const key of keys) inFlight.add(key)
  return { records, keys }
}

/** Clears the entries `readJournal` returned, once their records have landed. */
export function clearJournal(keys: readonly string[]): void {
  for (const key of keys) clearJournalKey(key)
}

/** Forgets this page's in-flight keys, as a reload would (tests only). */
export function forgetInFlightJournalForTests(): void {
  inFlight.clear()
  for (const release of lockReleases.values()) release()
  lockReleases.clear()
}

/** Gives up on recovering `keys` in this page, leaving them for the next one. */
export function releaseJournal(keys: readonly string[]): void {
  for (const key of keys) inFlight.delete(key)
}

/**
 * Adds `records` to the outbox store in one transaction, leaving any id that
 * is already there untouched — never overwrite an existing event's
 * attempts/quarantine state. Returns the ids it added.
 */
export function addOutboxRecords(
  db: IDBDatabase,
  store: string,
  records: readonly OutboxRecord[],
): Promise<string[]> {
  if (records.length === 0) return Promise.resolve([])
  return new Promise<string[]>((resolve, reject) => {
    const added: string[] = []
    const tx = db.transaction(store, "readwrite")
    tx.oncomplete = () => resolve(added)
    tx.onabort = () => reject(tx.error ?? new Error("outbox write aborted"))
    tx.onerror = () => reject(tx.error ?? new Error("outbox write failed"))
    const objectStore = tx.objectStore(store)
    for (const record of records) {
      const request = objectStore.add(record)
      request.onsuccess = () => { added.push(record.id) }
      request.onerror = (event) => {
        if (request.error?.name === "ConstraintError") {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }
  })
}
