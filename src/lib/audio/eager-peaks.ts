// Background prefetcher used when a project sets audioMediaStrategy="eager".
// Walks every cell with a recording in display order and decodes its
// waveform peaks into the OPFS cache so they're instant when the row scrolls
// into view. Cancellation is cooperative — caller flips a flag.

import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import { audioSyncTokenFetcherForSession } from "./sync-token-fetcher"
import { decodePeaks } from "./peaks"
import { peaksCacheGet, peaksCachePut } from "./peaks-cache"
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
 * Walk cells sequentially and fill the peaks cache for any not-yet-cached
 * recording. Stops cleanly when isCancelled() returns true (e.g. the user
 * navigated to another file). Concurrency is intentionally serial — peak
 * decoding is CPU-heavy and we don't want it to fight with whatever the
 * user is actively interacting with.
 */
export async function eagerlyPrefetchPeaks(args: EagerPrefetchArgs): Promise<void> {
  const getSyncToken = audioSyncTokenFetcherForSession(args.session)
  for (const cell of args.cells) {
    if (args.isCancelled()) return
    const audioId = cell.selectedAudioId
    if (!audioId) continue
    const att = cell.attachments?.[audioId]
    if (!att || att.isDeleted) continue

    try {
      const cached = await peaksCacheGet(audioId, args.bins)
      if (cached) continue
    } catch { /* fall through to fetch */ }

    const frontier = parseFrontierAudioUrl(att.url)
    if (!frontier) continue // legacy LFS attachments — no longer fetchable

    try {
      const bytes = await fetchCellAudio({
        projectId: args.project.id,
        fileId: cell.fileId,
        audioId: frontier.audioId,
        ext: frontier.ext,
        getSyncToken,
      })
      if (args.isCancelled()) return
      const decoded = await decodePeaks(bytes, args.bins)
      if (args.isCancelled()) return
      await peaksCachePut(audioId, decoded.peaks)
      args.onCellDone?.(audioId)
    } catch {
      // best-effort: skip this cell, try the next
    }
  }
}
