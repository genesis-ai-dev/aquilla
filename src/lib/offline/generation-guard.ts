// Older builds must not open newer offline data: LiveStore would skip unknown events, queued edits included.
// Accepted gap: edits queued before a manual downgrade wait (and may conflict) until the next update; see PR #1279.
import { OFFLINE_DATA_GENERATION } from "./schema"

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

// Sits beside LiveStore's store dir, not in it: deleting only that dir must delete this too.
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

export async function claimOfflineGeneration(
  marker: GenerationMarker = opfsGenerationMarker,
  buildGeneration: number = OFFLINE_DATA_GENERATION,
): Promise<void> {
  let stored: number | null
  try {
    stored = await marker.read()
  } catch (error) {
    // Fail open, but don't overwrite: it may hold a newer build's claim.
    console.warn("[offline] couldn't read the offline data generation marker — opening the store anyway", error)
    return
  }
  if (stored !== null && stored > buildGeneration) throw new NewerOfflineDataError(stored, buildGeneration)
  if (stored === buildGeneration) return
  await marker.write(buildGeneration).catch((error: unknown) => {
    console.warn("[offline] couldn't record the offline data generation", error)
  })
}
