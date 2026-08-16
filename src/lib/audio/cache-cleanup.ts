// Best-effort purge of OPFS-backed audio caches. Called on sign-out so
// per-user audio peaks don't leak across accounts on shared devices.
//
// Errors are swallowed: cleanup is opportunistic — if OPFS isn't available
// (Node, private mode), we proceed without the user noticing.

import { __resetAudioCacheMemo } from "./bytes-cache"

export async function purgeAudioCachesOnSignOut(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return
  try {
    const root = await navigator.storage.getDirectory()
    await removeIfExists(root, "audio-peaks")
    await removeIfExists(root, "lfs-cache")
    // FORTIFY: the byte cache was MISSED here — it holds the most sensitive
    // artifact of all (the full audio of every clip recorded or played, up to
    // the adaptive budget), and it survived sign-out on shared devices. The
    // in-memory index memo must go with it or the next put would resurrect
    // entries pointing at deleted files.
    await removeIfExists(root, "audio-bytes")
    __resetAudioCacheMemo()
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
