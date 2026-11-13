// Local overlay store for the bridge, in IndexedDB. Version 1 keeps everything
// on the device: pending edits, Aquilla's write log (previous/new rawHash per
// unit, for clobber detection), the unit set Aquilla last saw per book, the
// blob hashes of its own writes (echo detection) and per-book holds.
// Version 2 adds `links`: which Aquilla project mirrors which Paratext project
// (so the regular editor can write a book back through the bridge).
//
// Rows belong to one project FOLDER (`BridgeStateId`, see project.ts): keys are
// `pt:{stateId}:{unitId}` for unit-level rows, `pt:{stateId}:{book}` for
// book-level rows and `pt:{stateId}` for the link. The `projectGuid` field of
// a state row holds that id too (it is the `byBook` index path, so the name
// stays). Rows written before state was per folder are keyed by the bare GUID;
// `migrateLegacyLinks` and `adoptLegacyState` below move them.

import { openDB, type DBSchema, type IDBPDatabase, type IDBPTransaction, type StoreNames } from "idb"
import type { UnitSet } from "./units"
import type { PendingEdit } from "./write-back"
import type { WrittenRecord } from "./classify"
import { bridgeStateId, type BridgeStateId } from "./project"

interface BridgeSchema extends DBSchema {
  pendingEdits: { key: string; value: PendingEdit & { key: string; projectGuid: string; book: string; updatedAt: number }; indexes: { byBook: [string, string] } }
  writeLog: { key: string; value: WrittenRecord & { key: string; projectGuid: string; book: string; writtenAt: number }; indexes: { byBook: [string, string] } }
  lastSeen: { key: string; value: { key: string; projectGuid: string; book: string; units: UnitSet; seenAt: number } }
  ownBlobs: { key: string; value: { key: string; projectGuid: string; book: string; blobHash: string; writtenAt: number }; indexes: { byBook: [string, string] } }
  holds: { key: string; value: { key: string; projectGuid: string; book: string; reason: "clobber"; since: number } }
  links: { key: string; value: MirrorLink & { key: string }; indexes: { byProject: string } }
}

/** A Paratext project folder mirrored into a regular Aquilla project. One per folder. */
export interface MirrorLink {
  projectGuid: string
  /** Paratext project folder, as discovery reported it. */
  projectPath: string
  /** The Aquilla project the books were imported into. */
  projectId: string
  /** Book code → the Aquilla file that holds it and the SFM it came from. */
  books: Record<string, { fileId: string; fileName: string }>
  /** Target lane tag the import wrote (`''` = default lane). */
  targetLang: string
  createdAt: number
}

const DB_NAME = "aquilla-paratext-bridge"

let dbPromise: Promise<IDBPDatabase<BridgeSchema>> | null = null

function db(): Promise<IDBPDatabase<BridgeSchema>> {
  dbPromise ??= openDB<BridgeSchema>(DB_NAME, 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore("pendingEdits", { keyPath: "key" }).createIndex("byBook", ["projectGuid", "book"])
        d.createObjectStore("writeLog", { keyPath: "key" }).createIndex("byBook", ["projectGuid", "book"])
        d.createObjectStore("lastSeen", { keyPath: "key" })
        d.createObjectStore("ownBlobs", { keyPath: "key" }).createIndex("byBook", ["projectGuid", "book"])
        d.createObjectStore("holds", { keyPath: "key" })
      }
      if (oldVersion < 2) {
        d.createObjectStore("links", { keyPath: "key" }).createIndex("byProject", "projectId")
      }
    },
  }).then(async (d) => { await migrateLegacyLinks(d); return d })
  return dbPromise
}

const STATE_STORES = ["pendingEdits", "writeLog", "lastSeen", "ownBlobs", "holds"] as const
type StateStore = (typeof STATE_STORES)[number]
type BridgeTx = IDBPTransaction<BridgeSchema, ArrayLike<StoreNames<BridgeSchema>>, "readwrite">

/** Move one store's rows from the bare-GUID keys to a folder's keys. */
async function moveRows<N extends StateStore>(tx: BridgeTx, name: N, guid: string, to: BridgeStateId): Promise<void> {
  const store = tx.objectStore(name)
  const prefix = `pt:${guid}:`
  for (const row of await store.getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`))) {
    await store.delete(row.key)
    await store.put({ ...row, key: `pt:${to}:${row.key.slice(prefix.length)}`, projectGuid: to } as BridgeSchema[N]["value"])
  }
}

/**
 * A link written before state was per folder is keyed by the bare GUID, and
 * names the folder it mirrors. Give that folder the link and the GUID's state.
 * Runs on every open and finds nothing once done.
 */
async function migrateLegacyLinks(d: IDBPDatabase<BridgeSchema>): Promise<void> {
  const legacy = (await d.getAll("links")).filter((l) => !l.key.includes("@"))
  for (const link of legacy) {
    const to = bridgeStateId(link.projectGuid, link.projectPath)
    const tx = d.transaction([...STATE_STORES, "links"], "readwrite")
    for (const name of STATE_STORES) await moveRows(tx, name, link.projectGuid, to)
    await tx.objectStore("links").delete(link.key)
    await tx.objectStore("links").put({ ...link, key: `pt:${to}` })
    await tx.done
  }
}

/** Test hook: drop the cached connection so a fresh fake IDB is used. */
export function resetBridgeStoreForTests(): void {
  dbPromise = null
}

const unitKey = (id: BridgeStateId, unitId: string) => `pt:${id}:${unitId}`
const bookKey = (id: BridgeStateId, book: string) => `pt:${id}:${book}`

export const bridgeStore = {
  /**
   * State left under the bare GUID by a version that kept one state per GUID,
   * for a project that was never mirrored (so no link names its folder): the
   * first folder with that GUID to be opened takes it. Before that version
   * found Paratext 10 and Lite folders a GUID had one folder in practice, so
   * this is the folder the state was made for.
   */
  async adoptLegacyState(guid: string, id: BridgeStateId): Promise<void> {
    const tx = (await db()).transaction(STATE_STORES, "readwrite")
    for (const name of STATE_STORES) await moveRows(tx, name, guid, id)
    await tx.done
  },

  async pendingEdits(id: BridgeStateId, book: string): Promise<PendingEdit[]> {
    const rows = await (await db()).getAllFromIndex("pendingEdits", "byBook", [id, book])
    return rows.map(({ unitId, text, baseRawHash }) => ({ unitId, text, baseRawHash }))
  },
  async putPendingEdit(id: BridgeStateId, book: string, edit: PendingEdit): Promise<void> {
    await (await db()).put("pendingEdits", { ...edit, key: unitKey(id, edit.unitId), projectGuid: id, book, updatedAt: Date.now() })
  },
  async deletePendingEdits(id: BridgeStateId, unitIds: Iterable<string>): Promise<void> {
    const tx = (await db()).transaction("pendingEdits", "readwrite")
    for (const unitId of unitIds) await tx.store.delete(unitKey(id, unitId))
    await tx.done
  },
  async clearPendingEdits(id: BridgeStateId, book: string): Promise<void> {
    const d = await db()
    const rows = await d.getAllFromIndex("pendingEdits", "byBook", [id, book])
    const tx = d.transaction("pendingEdits", "readwrite")
    for (const r of rows) await tx.store.delete(r.key)
    await tx.done
  },

  async writeLog(id: BridgeStateId, book: string): Promise<WrittenRecord[]> {
    const rows = await (await db()).getAllFromIndex("writeLog", "byBook", [id, book])
    return rows.map(({ unitId, previousRawHash, newRawHash }) => ({ unitId, previousRawHash, newRawHash }))
  },
  async recordWrites(id: BridgeStateId, book: string, records: readonly WrittenRecord[]): Promise<void> {
    const tx = (await db()).transaction("writeLog", "readwrite")
    const now = Date.now()
    for (const r of records) await tx.store.put({ ...r, key: unitKey(id, r.unitId), projectGuid: id, book, writtenAt: now })
    await tx.done
  },

  async lastSeen(id: BridgeStateId, book: string): Promise<UnitSet | null> {
    return (await (await db()).get("lastSeen", bookKey(id, book)))?.units ?? null
  },
  async setLastSeen(id: BridgeStateId, book: string, units: UnitSet): Promise<void> {
    await (await db()).put("lastSeen", { key: bookKey(id, book), projectGuid: id, book, units, seenAt: Date.now() })
  },

  async ownBlobHashes(id: BridgeStateId, book: string): Promise<Set<string>> {
    const rows = await (await db()).getAllFromIndex("ownBlobs", "byBook", [id, book])
    return new Set(rows.map((r) => r.blobHash))
  },
  async recordOwnBlob(id: BridgeStateId, book: string, blobHash: string): Promise<void> {
    await (await db()).put("ownBlobs", { key: `${bookKey(id, book)}:${blobHash}`, projectGuid: id, book, blobHash, writtenAt: Date.now() })
  },

  async hold(id: BridgeStateId, book: string): Promise<boolean> {
    return (await (await db()).get("holds", bookKey(id, book))) !== undefined
  },
  async setHold(id: BridgeStateId, book: string, on: boolean): Promise<void> {
    const d = await db()
    if (on) await d.put("holds", { key: bookKey(id, book), projectGuid: id, book, reason: "clobber", since: Date.now() })
    else await d.delete("holds", bookKey(id, book))
  },

  async link(id: BridgeStateId): Promise<MirrorLink | null> {
    const row = await (await db()).get("links", `pt:${id}`)
    if (!row) return null
    const { key: _key, ...link } = row
    return link
  },
  async linkForProject(projectId: string): Promise<MirrorLink | null> {
    const row = await (await db()).getFromIndex("links", "byProject", projectId)
    if (!row) return null
    const { key: _key, ...link } = row
    return link
  },
  async putLink(link: MirrorLink): Promise<void> {
    await (await db()).put("links", { ...link, key: `pt:${bridgeStateId(link.projectGuid, link.projectPath)}` })
  },
  async deleteLink(id: BridgeStateId): Promise<void> {
    await (await db()).delete("links", `pt:${id}`)
  },
}
