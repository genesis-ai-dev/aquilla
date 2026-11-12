/**
 * Resumable bulk-import sessions (AQU-1859).
 *
 * A Bible-sized import is ~31k cells in ~21 chunked POSTs. Every run used to
 * mint fresh ids — file id, `file.create`, the staging `file.delete`, the
 * publication `file.restore`, the R2 artifact — so a chunk that failed
 * half-way left the user one option: import again. That produced a SECOND
 * file, and the first attempt's cells, its staged (hidden) file row and its
 * R2 original stayed forever. A flaky network multiplied the orphans.
 *
 * So the ids and the chunk progress of an in-flight import live here, in
 * IndexedDB, keyed by the project plus a stable description of the source
 * file. A retry resolves the same session, re-sends only the chunks that
 * never landed (the `/import` route is idempotent per chunk), and completes
 * the file the first attempt created. The record is deleted the moment the
 * upload finishes, so a *deliberate* second import of the same file — after a
 * successful one — finds nothing and gets a new file, as it should.
 *
 * Resuming is only safe while a re-parse of the file produces the same cells.
 * Cell ids are only stable when the parser supplies them (scripture and
 * subtitle parsers do; a spreadsheet of unkeyed rows does not), so the record
 * keeps a `fingerprint` of the cell keys. A re-parse whose keys do not match
 * is given a brand-new session rather than being allowed to chunk different
 * cells into the file the first attempt created — which is how you would get
 * duplicate cells. Given a matching fingerprint, `importCellEventId` derives
 * each event id from the session's file id, so the retry's chunks are
 * byte-identical to the ones that already landed and the `/import` route's
 * per-chunk idempotency does the rest.
 *
 * Every function here is best-effort. A browser with IndexedDB blocked, or a
 * non-browser context, falls back to a memory-only record, so an import still
 * runs exactly as it did before sessions existed — it just isn't resumable.
 */

import { v5 as uuidv5, v7 as uuidv7 } from "uuid"

const DB_NAME = "aquilla-import-sessions"
const DB_VERSION = 1
const STORE = "sessions"

/** Abandoned sessions are swept on the next resolve so the store cannot grow
 *  without bound on a machine that imports often and fails occasionally. */
export const IMPORT_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** The ids one import run must keep stable to land in a single file. */
export interface ImportSessionIds {
  /** `files.id` — the file every chunk writes into. */
  fileId: string
  /** `file.create` event id. */
  fileEventId: string
  /** Staging `file.delete` event id (keeps the file hidden while it fills). */
  stageEventId: string
  /** Publication `file.restore` event id (the reveal receipt). */
  publishEventId: string
  /** R2 source-artifact id for the preserved original bytes. */
  artifactId: string
}

export interface ImportSessionRecord extends ImportSessionIds {
  /** `${projectId}::${importKey}` — the IndexedDB primary key. */
  key: string
  projectId: string
  importKey: string
  fileName: string
  /** Digest of the uploaded cell event ids; see the module note. */
  fingerprint: string
  totalCells: number
  chunkSize: number
  /** Chunk offsets the server has already accepted. */
  landedOffsets: number[]
  /** The immutable original has been preserved in R2 already. */
  originalUploaded: boolean
  createdAt: number
  updatedAt: number
}

export interface ResolveImportSessionArgs {
  projectId: string
  /** Stable description of the source file within the project. */
  importKey: string
  fileName: string
  /** The cell keys (`cells.cell_id`) this attempt will upload, in order. */
  cellKeys: readonly string[]
  /** Cells per chunk; a different chunking invalidates recorded offsets. */
  chunkSize: number
}

/**
 * Digest of the cell keys, in order. Not a security hash — it only has to
 * change when the parse produces different cells.
 */
export function importCellFingerprint(cellKeys: readonly string[]): string {
  // FNV-1a over the key stream, plus the count so a prefix cannot collide with
  // the whole.
  let hash = 0x811c9dc5
  for (const key of cellKeys) {
    for (let i = 0; i < key.length; i++) {
      hash ^= key.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
    hash ^= 0x2f
    hash = Math.imul(hash, 0x01000193)
  }
  return `${cellKeys.length}:${(hash >>> 0).toString(16)}`
}

/**
 * The event id for one imported row, derived from the session's file id so a
 * re-parse of the same file mints the SAME id and its chunk is a true replay.
 * The position is part of the name because a parser may legitimately repeat a
 * cell key (an unkeyed spreadsheet column), and two rows must never collapse
 * into one event.
 *
 * A file id is a UUID, so it serves as the v5 namespace directly: ids are
 * unique per (file, position, key) and cannot collide across files or
 * projects.
 */
export function importCellEventId(
  fileId: string,
  index: number,
  cellKey: string,
  lane: "source" | "target" = "source",
): string {
  return uuidv5(`${lane}:${index}:${cellKey}`, fileId)
}

function sessionKey(projectId: string, importKey: string): string {
  return `${projectId}::${importKey}`
}

function freshIds(): ImportSessionIds {
  return {
    fileId: uuidv7(),
    fileEventId: uuidv7(),
    stageEventId: uuidv7(),
    publishEventId: uuidv7(),
    artifactId: uuidv7(),
  }
}

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * Keys an import run in THIS tab currently owns. Two files dropped together
 * can share a session key — the same name, in the same project, parsed to the
 * same cells — and letting both resolve it would chunk two files into one.
 * Concurrency inside a tab is the only case we can see, and it is the only one
 * that can happen, since a session key names a file the user picked locally.
 */
const claimedKeys = new Set<string>()

/** Give up this tab's claim. The stored record is untouched, so a retry (or
 *  another tab) can still resume from it. */
export function releaseImportSession(key: string): void {
  claimedKeys.delete(key)
}

async function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("indexedDB unavailable")
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onerror = () => reject(req.error ?? new Error("IDB open failed"))
      req.onsuccess = () => resolve(req.result)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "key" })
        }
      }
    }).catch((error) => {
      // A rejected singleton would poison every later call in the session.
      dbPromise = null
      throw error
    })
  }
  return dbPromise
}

/** Closes the singleton connection and drops every claim (tests only). */
export async function resetImportSessionConnectionForTests(): Promise<void> {
  claimedKeys.clear()
  if (!dbPromise) return
  try {
    const db = await dbPromise
    db.close()
  } catch {
    /* ignore */
  }
  dbPromise = null
}

async function readRecord(key: string): Promise<ImportSessionRecord | undefined> {
  const db = await openDb()
  return new Promise<ImportSessionRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly")
    const request = tx.objectStore(STORE).get(key)
    request.onsuccess = () => resolve(request.result as ImportSessionRecord | undefined)
    tx.onerror = () => reject(tx.error ?? new Error("import session read failed"))
    tx.onabort = () => reject(tx.error ?? new Error("import session read aborted"))
  })
}

async function writeRecord(record: ImportSessionRecord): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("import session write failed"))
    tx.onabort = () => reject(tx.error ?? new Error("import session write aborted"))
  })
}

/**
 * Read-modify-write one session inside a single IndexedDB transaction, so two
 * chunks landing at the same moment cannot clobber each other's offsets.
 * Resolves false when the record is gone (a completed or swept import).
 */
async function mutateRecord(
  key: string,
  mutate: (record: ImportSessionRecord) => ImportSessionRecord,
): Promise<boolean> {
  const db = await openDb()
  return new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const request = store.get(key)
    let found = false
    request.onsuccess = () => {
      const existing = request.result as ImportSessionRecord | undefined
      if (!existing) return
      found = true
      store.put(mutate(existing))
    }
    tx.oncomplete = () => resolve(found)
    tx.onerror = () => reject(tx.error ?? new Error("import session update failed"))
    tx.onabort = () => reject(tx.error ?? new Error("import session update aborted"))
  })
}

async function sweepStaleSessions(now: number): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite")
    const request = tx.objectStore(STORE).openCursor()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("import session sweep failed"))
    tx.onabort = () => reject(tx.error ?? new Error("import session sweep aborted"))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const record = cursor.value as ImportSessionRecord
      if (now - record.updatedAt > IMPORT_SESSION_MAX_AGE_MS) cursor.delete()
      cursor.continue()
    }
  })
}

/**
 * The session an import run should use: the unfinished one for this
 * (project, file) when a re-parse produced the same cells, otherwise a fresh
 * one. Never throws — an unusable IndexedDB yields a memory-only record, which
 * simply isn't resumable.
 *
 * Returns null when another run in this tab already owns the key, which asks
 * the caller to import that file one-shot (the pre-AQU-1859 behaviour) rather
 * than share a file with it. Release the claim with `releaseImportSession`
 * when the run ends — `bulkUploadSource` does that for the session it is given.
 */
export async function resolveImportSession(
  args: ResolveImportSessionArgs,
): Promise<ImportSessionRecord | null> {
  const now = Date.now()
  const key = sessionKey(args.projectId, args.importKey)
  if (claimedKeys.has(key)) return null
  claimedKeys.add(key)
  const fingerprint = importCellFingerprint(args.cellKeys)
  const fresh: ImportSessionRecord = {
    key,
    projectId: args.projectId,
    importKey: args.importKey,
    fileName: args.fileName,
    fingerprint,
    totalCells: args.cellKeys.length,
    chunkSize: args.chunkSize,
    landedOffsets: [],
    originalUploaded: false,
    createdAt: now,
    updatedAt: now,
    ...freshIds(),
  }

  let existing: ImportSessionRecord | undefined
  try {
    await sweepStaleSessions(now)
    existing = await readRecord(key)
  } catch {
    // Memory-only: the run still gets one coherent set of ids, it just cannot
    // be resumed after the tab goes away.
    return fresh
  }

  // A re-parse that produced different cells, or a different chunking, makes
  // the recorded offsets meaningless: chunking different cells into the same
  // file would duplicate rows. Start over with a new file id instead — the
  // abandoned staged file is the server-side import sweep's to reclaim.
  const resumable = existing !== undefined
    && existing.fingerprint === fingerprint
    && existing.chunkSize === args.chunkSize
    && now - existing.updatedAt <= IMPORT_SESSION_MAX_AGE_MS

  const record: ImportSessionRecord = resumable && existing
    ? { ...existing, fileName: args.fileName, updatedAt: now }
    : fresh

  try {
    await writeRecord(record)
  } catch {
    /* memory-only; the import still runs, it just isn't resumable */
  }
  return record
}

/** Note that the server accepted the chunk starting at `offset`. */
export async function recordLandedChunk(key: string, offset: number): Promise<void> {
  try {
    await mutateRecord(key, (record) => (
      record.landedOffsets.includes(offset)
        ? record
        : {
            ...record,
            landedOffsets: [...record.landedOffsets, offset].sort((a, b) => a - b),
            updatedAt: Date.now(),
          }
    ))
  } catch {
    /* best effort: a lost note only costs a re-sent idempotent chunk */
  }
}

/** Note that the immutable original is already preserved in R2. */
export async function recordOriginalUploaded(key: string): Promise<void> {
  try {
    await mutateRecord(key, (record) => (
      record.originalUploaded ? record : { ...record, originalUploaded: true, updatedAt: Date.now() }
    ))
  } catch {
    /* best effort: a lost note only costs a re-uploaded (idempotent) original */
  }
}

/** Forget a finished import, so importing the same file again starts clean. */
export async function completeImportSession(key: string): Promise<void> {
  releaseImportSession(key)
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite")
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error("import session delete failed"))
      tx.onabort = () => reject(tx.error ?? new Error("import session delete aborted"))
    })
  } catch {
    /* a surviving record is swept by age, and re-resolves harmlessly */
  }
}

/**
 * Unfinished imports for a project, newest first — the "you left an import
 * half-finished" offer. Empty when IndexedDB is unusable.
 */
export async function listResumableImportSessions(
  projectId: string,
): Promise<ImportSessionRecord[]> {
  try {
    const db = await openDb()
    const records = await new Promise<ImportSessionRecord[]>((resolve, reject) => {
      const found: ImportSessionRecord[] = []
      const tx = db.transaction(STORE, "readonly")
      const request = tx.objectStore(STORE).openCursor()
      tx.oncomplete = () => resolve(found)
      tx.onerror = () => reject(tx.error ?? new Error("import session list failed"))
      tx.onabort = () => reject(tx.error ?? new Error("import session list aborted"))
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const record = cursor.value as ImportSessionRecord
        if (record.projectId === projectId) found.push(record)
        cursor.continue()
      }
    })
    return records.sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}
