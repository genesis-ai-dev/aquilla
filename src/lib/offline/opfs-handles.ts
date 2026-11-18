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
// Only a dedicated worker can open sync access handles, which is where this runs.

/** LiveStore names its OPFS directory `livestore-<storeId>@<storage format version>`. */
export const opfsStoreDirPrefix = (storeId: string): string => `livestore-${storeId}@`

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
  onBusy?: (file: string) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const BUSY = new Set(["NoModificationAllowedError", "InvalidStateError"])

const isBusy = (error: unknown): boolean => error instanceof DOMException && BUSY.has(error.name)

/** Returns the path of the first file another context has open, or null when all are free. */
async function findBusyFile(dir: OpfsDir, path: string): Promise<string | null> {
  for await (const entry of dir.values()) {
    const entryPath = `${path}/${entry.name}`
    if (entry.kind === "directory") {
      const busy = await findBusyFile(entry, entryPath)
      if (busy !== null) return busy
      continue
    }
    try {
      const handle = await entry.createSyncAccessHandle()
      handle.close()
    } catch (error) {
      if (isBusy(error)) return entryPath
      throw error
    }
  }
  return null
}

const defaultRoot = async (): Promise<OpfsDir> =>
  (await navigator.storage.getDirectory()) as unknown as OpfsDir

/**
 * Resolves once every file under the store's OPFS directories can be opened.
 * Rejects after `timeoutMs` if one stays busy, so a leader that never lets go
 * fails the boot (visibly, see livestore.worker.ts) rather than hanging it.
 */
export async function waitForOpfsFilesFree(
  storeId: string,
  {
    root = defaultRoot,
    timeoutMs = 30_000,
    retryMs = 50,
    onBusy = (file) => console.warn(`[offline] leader waiting for another leader to close ${file}`),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = Date.now,
  }: WaitForOpfsFilesOptions = {},
): Promise<void> {
  const prefix = opfsStoreDirPrefix(storeId)
  const startedAt = now()
  let delay = retryMs
  let reported = false
  for (;;) {
    let busy: string | null = null
    for await (const entry of (await root()).values()) {
      if (entry.kind !== "directory" || !entry.name.startsWith(prefix)) continue
      busy = await findBusyFile(entry, entry.name)
      if (busy !== null) break
    }
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
