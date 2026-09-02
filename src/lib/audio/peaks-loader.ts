// Getting one clip's waveform peaks, from wherever they are cheapest. (AQU-646)
//
// Extracted from eager-peaks.ts, which had this ladder inline and was missing a
// rung: it went straight to the network on a peaks-cache miss even though
// warmFileDubs had usually put the very same bytes in the OPFS byte cache
// seconds earlier. Both callers now share one path, so the timeline and the
// background prefetch cannot drift about where a clip's audio comes from.
//
// TWO CACHES, TWO DIFFERENT KEYS, AND THEY ARE EASY TO SWAP BY ACCIDENT:
//   - PEAKS are keyed on the ATTACHMENT KEY — "<audioId>.<ext>" — which is what
//     a cell's `attachments` map is keyed by, what `selectedAudioId` holds, and
//     what CellWaveform/useCellAudio already write under.
//   - BYTES are keyed on the parsed pair (frontier.audioId, frontier.ext).
// Getting these the wrong way round costs nothing visible and everything
// practical: every lookup misses, the cache the Recording tab has been filling
// for months is never read, and every chip re-decodes from the network.

import { fetchCellAudio, parseFrontierAudioUrl } from "./upload"
import { audioCacheGet, audioCachePut } from "./bytes-cache"
import { decodePeaks } from "./peaks"
import { peaksCacheGet, peaksCachePut } from "./peaks-cache"

/**
 * The bin count everything decodes at.
 *
 * FIXED, and shared, because the peaks cache is keyed by (clip, bins): the
 * Recording tab already requests 320, so a timeline chip on a clip somebody has
 * opened is instant, and a chip that decodes one warms the Recording tab in
 * turn. A zoom-dependent count would miss the cache at every zoom step and pay
 * for a fresh decode each time.
 *
 * 320 bins is per CLIP, not per second — a 3-second take is ~9ms a bin, a
 * 30-second import ~94ms and visibly coarser. That is already what the
 * Recording tab shows for the same clip.
 */
export const WAVEFORM_BINS = 320

/** Resolves a per-file sync token; `audioSyncTokenFetcherForSession` builds one. */
export type SyncTokenFetcher = (projectId: string, fileId: string) => Promise<string | null>

export interface LoadPeaksArgs {
  /** The attachment map's key, WITH the extension. Also the peaks-cache key. */
  attachmentKey: string
  /** The clip's `frontier-audio://` url. A legacy LFS url yields null. */
  url: string
  projectId: string
  /** The file that OWNS the clip — a take on an audio cue belongs to the hidden
   *  sibling, not to the subtitle file being viewed. */
  fileId: string
  bins: number
  getSyncToken: SyncTokenFetcher
}

/**
 * One clip's peaks, or null when they cannot be had.
 *
 * Null rather than a throw for every ordinary failure — a missing waveform is a
 * chip that draws no bars, never a broken timeline. The caller gets no reason
 * because there is nothing it could usefully do differently: a legacy url will
 * never resolve, a 404 clip is gone, and a decode failure retries by itself the
 * next time the chip is on screen.
 */
export async function loadPeaksFor(args: LoadPeaksArgs): Promise<Float32Array | null> {
  const { attachmentKey, url, projectId, fileId, bins, getSyncToken } = args
  if (!attachmentKey || !Number.isFinite(bins) || bins <= 0) return null

  // 1. The peaks themselves, already decoded by whoever looked at this clip
  //    first — the Recording tab, the eager sweep, or another chip.
  try {
    const cached = await peaksCacheGet(attachmentKey, bins)
    if (cached) return cached
  } catch {
    // An unreadable cache is not a reason to give up on the clip.
  }

  // Legacy GitLab-LFS attachments parse to null and can never be fetched again.
  const frontier = parseFrontierAudioUrl(url)
  if (!frontier) return null

  // 2. The bytes, if warmFileDubs or a playback already pulled them down.
  let bytes = await audioCacheGet(frontier.audioId, frontier.ext).catch(() => null)

  // 3. The network, writing through so the next reader skips it.
  if (!bytes) {
    let fetched: Uint8Array
    try {
      fetched = await fetchCellAudio({
        projectId,
        fileId,
        audioId: frontier.audioId,
        ext: frontier.ext,
        getSyncToken,
      })
    } catch {
      return null
    }
    try {
      await audioCachePut(frontier.audioId, frontier.ext, fetched)
    } catch {
      // Out of quota / private mode — we still have the bytes in hand.
    }
    bytes = fetched
  }

  try {
    const decoded = await decodePeaks(bytes, bins)
    try {
      await peaksCachePut(attachmentKey, decoded.peaks)
    } catch {
      // As above: failing to cache is not failing to draw.
    }
    return decoded.peaks
  } catch {
    return null
  }
}

export interface PeaksTarget {
  attachmentKey: string
  url: string
  fileId: string
}

export interface LoadPeaksBatchArgs {
  targets: readonly PeaksTarget[]
  projectId: string
  bins: number
  getSyncToken: SyncTokenFetcher
  /** Cooperative cancel, checked between items — same shape eager-peaks used. */
  isCancelled?: () => boolean
  /** Called as each one lands, so a caller can paint incrementally instead of
   *  waiting for the slowest clip in the batch. */
  onLoaded?: (attachmentKey: string, peaks: Float32Array) => void
  /**
   * How many clips to decode at once.
   *
   * TWO, and this is a ceiling rather than a tuning knob: `decodePeaks` builds a
   * real `AudioContext` per call, browsers cap how many can exist at once
   * (Chrome at about six), and exceeding it makes construction throw — which
   * would fail whole batches rather than slow them down. Decoding is also
   * CPU-heavy and must not fight whatever the user is actually doing.
   */
  concurrency?: number
}

/** Fill peaks for a set of clips, a couple at a time. Never rejects: a clip
 *  that cannot be loaded is simply skipped. */
export async function loadPeaksBatch(args: LoadPeaksBatchArgs): Promise<void> {
  const { targets, projectId, bins, getSyncToken, isCancelled, onLoaded } = args
  const limit = Math.max(1, Math.min(args.concurrency ?? 2, 4))

  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (isCancelled?.()) return
      const index = next++
      if (index >= targets.length) return
      const target = targets[index]
      const peaks = await loadPeaksFor({
        attachmentKey: target.attachmentKey,
        url: target.url,
        projectId,
        fileId: target.fileId,
        bins,
        getSyncToken,
      })
      // Re-checked AFTER the await: the file may have changed while this clip
      // was in flight, and painting it then would put one file's waveform on
      // another file's chip.
      if (isCancelled?.()) return
      if (peaks) onLoaded?.(target.attachmentKey, peaks)
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, worker))
}
