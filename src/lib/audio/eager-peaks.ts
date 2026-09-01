// Background prefetcher used when a project sets audioMediaStrategy="eager".
// Walks every cell with a recording in display order and decodes its waveform
// peaks into the OPFS cache so they're instant when the row scrolls into view.
// Cancellation is cooperative — caller flips a flag.
//
// AQU-646: the fetch/decode/cache ladder moved to peaks-loader.ts so the
// timeline's viewport loader and this sweep share one definition of where a
// clip's audio comes from. That also fixed a rung this walk was missing — it
// went straight to the network on every peaks-cache miss, ignoring the OPFS
// BYTE cache that warmFileDubs had usually just filled.

import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { loadPeaksBatch, type PeaksTarget } from "./peaks-loader"
import type { CellData } from "@/hooks/useCells"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"

export interface EagerPrefetchArgs {
  cells: CellData[]
  project: ProjectRecord
  session: FrontierSession
  bins: number
  isCancelled: () => boolean
  onCellDone?: (audioId: string) => void
}

/**
 * Walk cells in order and fill the peaks cache for any not-yet-cached
 * recording. Stops cleanly when isCancelled() returns true (e.g. the user
 * navigated to another file).
 *
 * Concurrency stays deliberately low (peaks-loader's default of 2) — peak
 * decoding is CPU-heavy and this is a background sweep that must not fight
 * whatever the user is actively interacting with.
 */
export async function eagerlyPrefetchPeaks(args: EagerPrefetchArgs): Promise<void> {
  const targets: PeaksTarget[] = []
  for (const cell of args.cells) {
    const audioId = cell.selectedAudioId
    if (!audioId) continue
    const att = cell.attachments?.[audioId]
    if (!att || att.isDeleted) continue
    // The take's own file, not the file being viewed: a take on an audio cue
    // lives in the hidden sibling, and its bytes are under that file's path.
    targets.push({ attachmentKey: audioId, url: att.url, fileId: cell.fileId })
  }

  await loadPeaksBatch({
    targets,
    projectId: args.project.id,
    bins: args.bins,
    getSyncToken: audioSyncTokenFetcherForSession(args.session),
    isCancelled: args.isCancelled,
    onLoaded: (attachmentKey) => args.onCellDone?.(attachmentKey),
  })
}
