// Keeps an older build's hands off offline data a newer build wrote.
//
// LiveStore rebuilds its state db from the eventlog whenever the schema hash
// changes, and skips events it doesn't recognise. So after a rollback (or an
// older build installed over a newer one) the old build would quietly drop
// whatever the newer events carried — queued edits included — while still
// trusting the newer build's sync cursors, then append its own events to the
// same eventlog. Updating again wouldn't bring the dropped edits back cleanly.
//
// Instead, every build records the highest OFFLINE_DATA_GENERATION that has
// opened this device's store, and a build older than that refuses to open it.
// The app then behaves like the browser SPA (server reads, IndexedDB outbox)
// until the user updates; the newer data stays untouched for that build.
//
// The marker is a file at the OPFS root, beside (not inside) LiveStore's
// `livestore-<STORE_ID>@<format>` directory: clearing the site's data removes
// both, but deleting only the store directory (LiveStore's resetPersistence,
// or any recovery that drops it) leaves the marker behind — such a path must
// also remove GENERATION_MARKER_FILE, or older builds keep refusing an empty
// store.
//
// The marker is claimed before the store boots, so a newer build that crashes
// on its first boot still locks older builds out. That's deliberate: the
// newer build may have written before it crashed.
//
// Only a positive "newer" reading refuses: a marker that can't be read fails
// open, rather than shutting offline mode off for good. It is left as it is,
// though — overwriting it could lower a newer build's claim.
import { OFFLINE_DATA_GENERATION } from "./schema"

/** Thrown by getOfflineStore() when this device's offline data comes from a newer build. */
export class NewerOfflineDataError extends Error {
  readonly storedGeneration: number
  readonly buildGeneration: number

  constructor(storedGeneration: number, buildGeneration: number) {
    super(
      `Offline data on this device is generation ${storedGeneration}, newer than this build's ${buildGeneration} — not opening it`,
    )
    this.name = "NewerOfflineDataError"
    this.storedGeneration = storedGeneration
    this.buildGeneration = buildGeneration
  }
}

export interface GenerationMarker {
  read: () => Promise<number | null>
  write: (generation: number) => Promise<void>
}

export const GENERATION_MARKER_FILE = "aquilla-offline.generation"

export const opfsGenerationMarker: GenerationMarker = {
  async read() {
    const root = await navigator.storage.getDirectory()
    let handle: FileSystemFileHandle
    try {
      handle = await root.getFileHandle(GENERATION_MARKER_FILE)
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError") return null
      throw error
    }
    const text = (await (await handle.getFile()).text()).trim()
    const generation = Number(text)
    if (!Number.isInteger(generation) || generation < 1) throw new Error(`Unreadable offline generation marker: "${text}"`)
    return generation
  },
  async write(generation) {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(GENERATION_MARKER_FILE, { create: true })
    const writable = await handle.createWritable()
    await writable.write(String(generation))
    await writable.close()
  },
}

/**
 * Claims this device's offline data for this build before the store boots:
 * throws {@link NewerOfflineDataError} if a newer build has opened it, else
 * raises the marker to this build's generation (never lowers it).
 */
export async function claimOfflineGeneration(
  marker: GenerationMarker = opfsGenerationMarker,
  buildGeneration: number = OFFLINE_DATA_GENERATION,
): Promise<void> {
  let stored: number | null
  try {
    stored = await marker.read()
  } catch (error) {
    // Don't rewrite it: an unreadable marker may hold a newer build's claim.
    console.warn("[offline] couldn't read the offline data generation marker — opening the store anyway", error)
    return
  }
  if (stored !== null && stored > buildGeneration) throw new NewerOfflineDataError(stored, buildGeneration)
  if (stored === buildGeneration) return
  await marker.write(buildGeneration).catch((error: unknown) => {
    console.warn("[offline] couldn't record the offline data generation", error)
  })
}
