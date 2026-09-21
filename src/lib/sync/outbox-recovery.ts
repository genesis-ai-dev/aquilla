import type { OutboxRecord } from "./outbox"

const PREFIX = "aquilla:outbox-recovery:v1:"

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

/** Recover before exposing the opened database to readers or the flusher. */
export async function recoverJournal(db: IDBDatabase, store: string): Promise<void> {
  const records: OutboxRecord[] = []
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(PREFIX)) continue
      try {
        const record = JSON.parse(localStorage.getItem(key) ?? "null") as OutboxRecord | null
        if (record?.event?.kind === "target.cell.commit"
          && typeof record.id === "string" && record.id === record.event.id
          && key === PREFIX + record.id
          && (typeof record.ownerKey === "string" || record.ownerKey === null)
          && record.status === "pending") records.push(record)
      } catch { /* malformed data cannot be replayed */ }
    }
  } catch { return }
  if (!records.length) return
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
  for (const record of records) clearJournalRecord(record.id)
}
