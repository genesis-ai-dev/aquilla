// Purge of OPFS-backed audio caches. Sign-out remains best-effort, while an
// account transition can request strict cleanup so the new identity is not
// published when sensitive bytes could not be removed.

import { __resetAudioCacheMemo } from "./bytes-cache"
import { markOpfsUnavailable } from "@/lib/storage/opfs-availability"

export async function purgeAudioCachesOnSignOut(options: { strict?: boolean } = {}): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
    __resetAudioCacheMemo()
    return
  }

  let root: FileSystemDirectoryHandle
  try {
    root = await navigator.storage.getDirectory()
  } catch {
    // Safari Private Browsing exposes getDirectory() but rejects every call
    // with UnknownError. The cache producers treat that as "OPFS unavailable"
    // and therefore cannot have persisted audio in this browsing context.
    // Match that contract here instead of permanently blocking logout on a
    // cleanup target the browser never made available.
    markOpfsUnavailable()
    __resetAudioCacheMemo()
    return
  }

  try {
    await removeIfExists(root, "audio-peaks", options.strict === true)
    await removeIfExists(root, "lfs-cache", options.strict === true)
    // FORTIFY: the byte cache was MISSED here — it holds the most sensitive
    // artifact of all (the full audio of every clip recorded or played, up to
    // the adaptive budget), and it survived sign-out on shared devices. The
    // in-memory index memo must go with it or the next put would resurrect
    // entries pointing at deleted files.
    await removeIfExists(root, "audio-bytes", options.strict === true)
  } catch (error) {
    if (options.strict) throw error
  } finally {
    // A partial purge must not leave an index memo that can resurrect entries
    // already removed before a later strict deletion failed.
    __resetAudioCacheMemo()
  }
}

async function removeIfExists(root: FileSystemDirectoryHandle, name: string, strict: boolean): Promise<void> {
  try {
    await root.removeEntry(name, { recursive: true })
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return
    if (strict) throw error
  }
}
