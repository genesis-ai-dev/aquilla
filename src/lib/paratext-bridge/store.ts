// Local overlay store for the bridge, in IndexedDB. Version 1 keeps everything
// on the device: pending edits, Aquilla's write log (previous/new rawHash per
// unit, for clobber detection), the unit set Aquilla last saw per book, the
// blob hashes of its own writes (echo detection) and per-book holds.
//
// Keys follow the plan: `pt:{projectGuid}:{unitId}` for unit-level rows and
// `pt:{projectGuid}:{book}` for book-level rows.

import { openDB, type DBSchema, type IDBPDatabase } from "idb"
import type { UnitSet } from "./units"
import type { PendingEdit } from "./write-back"
import type { WrittenRecord } from "./classify"

interface BridgeSchema extends DBSchema {
  pendingEdits: { key: string; value: PendingEdit & { key: string; projectGuid: string; book: string; updatedAt: number }; indexes: { byBook: [string, string] } }
  writeLog: { key: string; value: WrittenRecord & { key: string; projectGuid: string; book: string; writtenAt: number }; indexes: { byBook: [string, string] } }
  lastSeen: { key: string; value: { key: string; projectGuid: string; book: string; units: UnitSet; seenAt: number } }
  ownBlobs: { key: string; value: { key: string; projectGuid: string; book: string; blobHash: string; writtenAt: number }; indexes: { byBook: [string, string] } }
  holds: { key: string; value: { key: string; projectGuid: string; book: string; reason: "clobber"; since: number } }
}

const DB_NAME = "aquilla-paratext-bridge"

let dbPromise: Promise<IDBPDatabase<BridgeSchema>> | null = null

function db(): Promise<IDBPDatabase<BridgeSchema>> {
  dbPromise ??= openDB<BridgeSchema>(DB_NAME, 1, {
    upgrade(d) {
      d.createObjectStore("pendingEdits", { keyPath: "key" }).createIndex("byBook", ["projectGuid", "book"])
      d.createObjectStore("writeLog", { keyPath: "key" }).createIndex("byBook", ["projectGuid", "book"])
      d.createObjectStore("lastSeen", { keyPath: "key" })
      d.createObjectStore("ownBlobs", { keyPath: "key" }).createIndex("byBook", ["projectGuid", "book"])
      d.createObjectStore("holds", { keyPath: "key" })
    },
  })
  return dbPromise
}

/** Test hook: drop the cached connection so a fresh fake IDB is used. */
export function resetBridgeStoreForTests(): void {
  dbPromise = null
}

const unitKey = (guid: string, unitId: string) => `pt:${guid}:${unitId}`
const bookKey = (guid: string, book: string) => `pt:${guid}:${book}`

export const bridgeStore = {
  async pendingEdits(guid: string, book: string): Promise<PendingEdit[]> {
    const rows = await (await db()).getAllFromIndex("pendingEdits", "byBook", [guid, book])
    return rows.map(({ unitId, text, baseRawHash }) => ({ unitId, text, baseRawHash }))
  },
  async putPendingEdit(guid: string, book: string, edit: PendingEdit): Promise<void> {
    await (await db()).put("pendingEdits", { ...edit, key: unitKey(guid, edit.unitId), projectGuid: guid, book, updatedAt: Date.now() })
  },
  async deletePendingEdits(guid: string, unitIds: Iterable<string>): Promise<void> {
    const tx = (await db()).transaction("pendingEdits", "readwrite")
    for (const id of unitIds) await tx.store.delete(unitKey(guid, id))
    await tx.done
  },
  async clearPendingEdits(guid: string, book: string): Promise<void> {
    const d = await db()
    const rows = await d.getAllFromIndex("pendingEdits", "byBook", [guid, book])
    const tx = d.transaction("pendingEdits", "readwrite")
    for (const r of rows) await tx.store.delete(r.key)
    await tx.done
  },

  async writeLog(guid: string, book: string): Promise<WrittenRecord[]> {
    const rows = await (await db()).getAllFromIndex("writeLog", "byBook", [guid, book])
    return rows.map(({ unitId, previousRawHash, newRawHash }) => ({ unitId, previousRawHash, newRawHash }))
  },
  async recordWrites(guid: string, book: string, records: readonly WrittenRecord[]): Promise<void> {
    const tx = (await db()).transaction("writeLog", "readwrite")
    const now = Date.now()
    for (const r of records) await tx.store.put({ ...r, key: unitKey(guid, r.unitId), projectGuid: guid, book, writtenAt: now })
    await tx.done
  },

  async lastSeen(guid: string, book: string): Promise<UnitSet | null> {
    return (await (await db()).get("lastSeen", bookKey(guid, book)))?.units ?? null
  },
  async setLastSeen(guid: string, book: string, units: UnitSet): Promise<void> {
    await (await db()).put("lastSeen", { key: bookKey(guid, book), projectGuid: guid, book, units, seenAt: Date.now() })
  },

  async ownBlobHashes(guid: string, book: string): Promise<Set<string>> {
    const rows = await (await db()).getAllFromIndex("ownBlobs", "byBook", [guid, book])
    return new Set(rows.map((r) => r.blobHash))
  },
  async recordOwnBlob(guid: string, book: string, blobHash: string): Promise<void> {
    await (await db()).put("ownBlobs", { key: `${bookKey(guid, book)}:${blobHash}`, projectGuid: guid, book, blobHash, writtenAt: Date.now() })
  },

  async hold(guid: string, book: string): Promise<boolean> {
    return (await (await db()).get("holds", bookKey(guid, book))) !== undefined
  },
  async setHold(guid: string, book: string, on: boolean): Promise<void> {
    const d = await db()
    if (on) await d.put("holds", { key: bookKey(guid, book), projectGuid: guid, book, reason: "clobber", since: Date.now() })
    else await d.delete("holds", bookKey(guid, book))
  },
}
