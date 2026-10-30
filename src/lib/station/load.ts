// A recording's samples for the Station (AQU-2327): the stored bytes (the
// bytes cache first, as the chip's own player does — clip-preview.ts), decoded
// to mono at 48 kHz like every other decode in the app. The last few decodes
// are kept, so going back to a recording, or inserting one, is instant.

import { audioCacheGet, audioCachePut } from "@/lib/audio/bytes-cache"
import { decodeToMono48k, TARGET_RATE } from "@/lib/audio/decode-mono"
import type { SyncTokenFetcher } from "@/lib/audio/peaks-loader"
import { fetchCellAudio, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { peakOf, type PcmSource } from "./render"

export interface StationPcm extends PcmSource {
  /** Its loudest sample: every view of it is drawn against this. */
  peak: number
  /** Seconds. */
  duration: number
}

export interface LoadPcmArgs {
  url: string
  projectId: string
  /** The file that OWNS the clip (a cue sibling for a linked take). */
  fileId: string
  getSyncToken: SyncTokenFetcher
}

const KEEP = 6
const decoded = new Map<string, Promise<StationPcm>>()

/** The decode's key: the stored object, not the take (one object can back
 *  many takes — pieces, a recording placed on two lines). */
export function pcmKey(url: string): string {
  const f = parseFrontierAudioUrl(url)
  return f ? `${f.audioId}.${f.ext}` : url
}

export function loadStationPcm(args: LoadPcmArgs): Promise<StationPcm> {
  const key = pcmKey(args.url)
  const hit = decoded.get(key)
  if (hit) {
    decoded.delete(key)
    decoded.set(key, hit)
    return hit
  }
  const p = (async () => {
    const f = parseFrontierAudioUrl(args.url)
    if (!f) throw new Error("This recording can't be opened here.")
    let bytes = await audioCacheGet(f.audioId, f.ext)
    if (!bytes) {
      bytes = await fetchCellAudio({ projectId: args.projectId, fileId: args.fileId, audioId: f.audioId, ext: f.ext, getSyncToken: args.getSyncToken })
      void audioCachePut(f.audioId, f.ext, bytes)
    }
    const data = await decodeToMono48k(bytes)
    return { data, rate: TARGET_RATE, peak: peakOf(data), duration: data.length / TARGET_RATE }
  })()
  decoded.set(key, p)
  p.catch(() => decoded.delete(key))
  while (decoded.size > KEEP) {
    const oldest = decoded.keys().next().value
    if (oldest === undefined) break
    decoded.delete(oldest)
  }
  return p
}

/** Samples someone handed in (a file, a recording), under a key of their own. */
export function putStationPcm(key: string, data: Float32Array, rate = TARGET_RATE): StationPcm {
  const pcm = { data, rate, peak: peakOf(data), duration: data.length / rate }
  decoded.set(key, Promise.resolve(pcm))
  return pcm
}

export function __resetStationPcmForTests(): void {
  decoded.clear()
}
