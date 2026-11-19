// Waits until no other leader has the offline store's OPFS files open.
//
// LiveStore's AccessHandlePoolVFS opens a sync access handle on every file in
// its directory when it boots (`#acquireAccessHandles`), with no retry: if any
// file is still open in another worker, the leader dies with
// NoModificationAllowedError / InvalidStateError. The leader lock
// (leader-lock.ts) normally rules that out, but not on the first boot after an
// update from v0.2.4 (whose lock was held by the page, and is dropped with it
// before its worker lets go) or after the lock was stolen from a holder that
// was still alive. So the leader worker opens and closes each file itself
// first, and waits while any of them is busy.
//
// Only the files the pool opens are probed: the top level of the current
// storage format's directory. Older format directories and `archive/` are
// never opened by a leader, and probing them would only slow every boot.
//
// Only a dedicated worker can open sync access handles, which is where this runs.
import { liveStoreStorageFormatVersion } from "@livestore/common"

/** LiveStore names its OPFS directory `livestore-<storeId>@<storage format version>`. */
export const opfsStoreDir = (storeId: string): string => `livestore-${storeId}@${liveStoreStorageFormatVersion}`

/** The bits of the OPFS API this needs; structural so tests can fake it. */
export interface OpfsFile {
  kind: "file"
  name: string
  createSyncAccessHandle(): Promise<{ close(): void }>
}
export interface OpfsDir {
  kind: "directory"
  name: string
  values(): AsyncIterable<OpfsFile | OpfsDir>
}

export interface WaitForOpfsFilesOptions {
  root?: () => Promise<OpfsDir>
  timeoutMs?: number
  /** First retry delay; doubles up to 1 s. */
  retryMs?: number
  onBusy: (file: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const BUSY = new Set(["NoModificationAllowedError", "InvalidStateError"])

const isBusy = (error: unknown): boolean => error instanceof DOMException && BUSY.has(error.name)
// A file removed between listing and opening (the old leader cleaning up) can't be held by anyone.
const isGone = (error: unknown): boolean => error instanceof DOMException && error.name === "NotFoundError"

/** Returns the path of the first pool file another context has open, or null when all are free. */
async function findBusyFile(dir: OpfsDir): Promise<string | null> {
  for await (const entry of dir.values()) {
    if (entry.kind !== "file") continue
    try {
      const handle = await entry.createSyncAccessHandle()
      handle.close()
    } catch (error) {
      if (isBusy(error)) return `${dir.name}/${entry.name}`
      if (isGone(error)) continue
      throw error
    }
  }
  return null
}

/** The store's pool directory, or null when there's none yet (first boot) or OPFS is out of reach. */
async function findStoreDir(root: () => Promise<OpfsDir>, name: string): Promise<OpfsDir | null> {
  let rootDir: OpfsDir
  try {
    rootDir = await root()
  } catch {
    // No OPFS (or no access to it): nothing can be holding its files, and
    // LiveStore's own check falls back to in-memory storage from here.
    return null
  }
  for await (const entry of rootDir.values()) {
    if (entry.kind === "directory" && entry.name === name) return entry
  }
  return null
}

const defaultRoot = async (): Promise<OpfsDir> =>
  (await navigator.storage.getDirectory()) as unknown as OpfsDir

/**
 * Resolves once every file in the store's OPFS pool directory can be opened.
 * Rejects after `timeoutMs` if one stays busy, so a leader that never lets go
 * fails the boot (visibly, see livestore.worker.ts) rather than hanging it.
 */
export async function waitForOpfsFilesFree(
  storeId: string,
  {
    root = defaultRoot,
    timeoutMs = 30_000,
    retryMs = 50,
    onBusy,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  }: WaitForOpfsFilesOptions,
): Promise<void> {
  const dirName = opfsStoreDir(storeId)
  const startedAt = now()
  let delay = retryMs
  let reported = false
  for (;;) {
    const dir = await findStoreDir(root, dirName)
    const busy = dir === null ? null : await findBusyFile(dir)
    if (busy === null) return
    if (!reported) {
      reported = true
      onBusy(busy)
    }
    if (now() - startedAt >= timeoutMs) {
      throw new Error(`[offline] ${busy} is still open in another leader after ${timeoutMs} ms`)
    }
    await sleep(delay)
    delay = Math.min(delay * 2, 1_000)
  }
}
