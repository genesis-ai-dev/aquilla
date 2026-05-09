/**
 * Recovery action for "wipe and re-bootstrap from server snapshot."
 * See DATA_PERSISTENCE_PLAN.md §13.5.
 *
 * Removes the OPFS file backing a LocalStore. Idempotent — silently succeeds
 * if the file is missing or OPFS is unavailable. Caller is responsible for
 * closing any open LocalStore before calling, otherwise the remove will
 * fail with a SyncAccessHandle conflict.
 */

export async function wipeOpfsDb(name: string): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    return
  }
  try {
    const dir = await navigator.storage.getDirectory()
    await dir.removeEntry(`${name}.sqlite3`).catch(() => {})
    // SQLite-WASM's OPFS-VFS may also leave a journal sibling.
    await dir.removeEntry(`${name}.sqlite3-journal`).catch(() => {})
  } catch {
    // OPFS not available or directory not yet created — nothing to wipe.
  }
}
