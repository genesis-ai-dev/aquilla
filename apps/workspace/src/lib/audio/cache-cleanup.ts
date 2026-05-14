// Best-effort purge of OPFS-backed audio caches. Called on sign-out so
// per-user audio peaks don't leak across accounts on shared devices.
//
// Errors are swallowed: cleanup is opportunistic — if OPFS isn't available
// (Node, private mode), we proceed without the user noticing.

export async function purgeAudioCachesOnSignOut(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return
  try {
    const root = await navigator.storage.getDirectory()
    await removeIfExists(root, "audio-peaks")
    await removeIfExists(root, "lfs-cache")
  } catch {
    // OPFS not available, or access denied — nothing to do.
  }
}

async function removeIfExists(root: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await root.removeEntry(name, { recursive: true })
  } catch {
    // Entry didn't exist (NotFoundError) — fine.
  }
}
