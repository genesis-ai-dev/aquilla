import type { OutboxRecord } from "./outbox"

const PREFIX = "aquilla:outbox-recovery:v1:"
const BATCH_PREFIX = "aquilla:outbox-recovery:batch:v1:"

// Largest batch journal entry, in UTF-16 code units (~2 bytes each). The
// origin's ~5MB Web Storage quota is shared with the prefs store.
const BATCH_JOURNAL_MAX_CHARS = 256 * 1024
// Above this many events, don't even serialize the batch to measure it.
const BATCH_JOURNAL_MAX_EVENTS = 500

/**
 * Bridge the document-teardown gap before an async IndexedDB transaction.
 * The record is the SAME account-scoped event envelope, not a second draft.
 * Per-event keys avoid cross-tab read/modify/write races. Server event IDs
 * make replay idempotent if a crash happens after IDB commits but before the
 * journal entry is removed. Only small foreground target commits use this.
 */
export function journalTargetCommit(record: OutboxRecord): void {
  if (record.event.kind !== "target.cell.commit") return
  try {
    localStorage.setItem(PREFIX + record.id, JSON.stringify(record))
  } catch {
    // IndexedDB remains the normal writer when Web Storage is unavailable.
    console.warn("[outbox] Reload recovery storage unavailable; keep the page open until saved")
  }
}

export function clearJournalRecord(id: string): void {
  try { localStorage.removeItem(PREFIX + id) } catch { /* unavailable storage */ }
}

/**
 * Journal a whole bulk enqueue as ONE entry, so recovery restores all of it or
 * none: a commit is never replayed without the create it chains on, or a
 * validate without its edit. Returns the entry's key, or null when the batch
 * wasn't journaled — too big for the shared quota, or storage unavailable.
 */
export function journalBatch(records: readonly OutboxRecord[]): string | null {
  if (records.length === 0 || records.length > BATCH_JOURNAL_MAX_EVENTS) return null
  const json = JSON.stringify(records)
  if (json.length > BATCH_JOURNAL_MAX_CHARS) return null
  const key = BATCH_PREFIX + records[0].id
  try {
    localStorage.setItem(key, json)
    return key
  } catch {
    console.warn("[outbox] Reload recovery storage unavailable; keep the page open until saved")
    return null
  }
}

export function clearJournalBatch(key: string): void {
  try { localStorage.removeItem(key) } catch { /* unavailable storage */ }
}

function isReplayable(record: OutboxRecord | null | undefined): record is OutboxRecord {
  return typeof record?.event?.kind === "string"
    && typeof record.id === "string" && record.id === record.event.id
    && (typeof record.ownerKey === "string" || record.ownerKey === null)
    && record.status === "pending"
}

/** Recover before exposing the opened database to readers or the flusher. */
export async function recoverJournal(db: IDBDatabase, store: string): Promise<void> {
  const records: OutboxRecord[] = []
  const keys: string[] = []
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(BATCH_PREFIX)) {
        keys.push(key)
        try {
          const batch = JSON.parse(localStorage.getItem(key) ?? "null") as OutboxRecord[] | null
          // All or nothing: a partial batch could replay a commit without its parent.
          if (Array.isArray(batch) && batch.length > 0 && batch.every(isReplayable)
            && key === BATCH_PREFIX + batch[0].id) records.push(...batch)
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
  } catch { return }
  if (!records.length) {
    for (const key of keys) clearJournalBatch(key)
    return
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, "readwrite")
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error("Outbox recovery aborted"))
    tx.onerror = () => reject(tx.error ?? new Error("Outbox recovery failed"))
    for (const record of records) {
      // Never overwrite an existing event's attempts/quarantine state.
      const request = tx.objectStore(store).add(record)
      request.onerror = (event) => {
        if (request.error?.name === "ConstraintError") {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }
  })
  for (const key of keys) clearJournalBatch(key)
}
