// Purge of OPFS-backed audio caches. Sign-out remains best-effort, while an
// account transition can request strict cleanup so the new identity is not
// published when sensitive bytes could not be removed.

import { __resetAudioCacheMemo } from "./bytes-cache"
import { purgeEgressExportCache } from "@/lib/egress/export-cache"

export async function purgeAudioCachesOnSignOut(options: { strict?: boolean } = {}): Promise<void> {
  // The egress export cache is IndexedDB-backed (zips of everything the user
  // could read) — purge it BEFORE the OPFS guard so it clears even where OPFS
  // is unavailable. Strict callers must know when these bytes survive.
  await purgeEgressExportCache({ strict: options.strict === true })
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) return
  try {
    const root = await navigator.storage.getDirectory()
    await removeIfExists(root, "audio-peaks", options.strict === true)
    await removeIfExists(root, "lfs-cache", options.strict === true)
    // FORTIFY: the byte cache was MISSED here — it holds the most sensitive
    // artifact of all (the full audio of every clip recorded or played, up to
    // the adaptive budget), and it survived sign-out on shared devices. The
    // in-memory index memo must go with it or the next put would resurrect
    // entries pointing at deleted files.
    await removeIfExists(root, "audio-bytes", options.strict === true)
    __resetAudioCacheMemo()
  } catch (error) {
    if (options.strict) throw error
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
