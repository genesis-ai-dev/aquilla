// A clip's waveform, stored next to the clip. (AQU-2095)
//
// WHY: a waveform used to cost the whole recording. Opening the Audio view
// downloaded every on-screen take just to draw its shape — Genesis 1 is 22
// recordings and 404KB, which is 3.6s on Slow 4G and 8.6s on 3G before a
// single bar appears, for a picture 20px tall. Peaks are the only thing the
// list actually needs, and 320 of them quantized to a byte each is 332 bytes:
// a chapter's shapes drop to ~7KB, and the recording itself is fetched when
// somebody presses play.
//
// WHERE IT LIVES: alongside the clip in R2, under the clip's own object name
// plus `.peaks` — `/audio/{project}/{file}/{audioId}.{ext}.peaks`. The worker's
// audio route accepts any plain filename and is already scoped to
// (projectId, fileId) by the sync token, so the sidecar needs no table, no
// event and no endpoint of its own. The one place that had to be taught about
// it is the nightly R2 orphan sweep, which maps a `.peaks` key back onto the
// clip it describes so the sidecar lives and dies with it (r2-gc.ts).
//
// WHO WRITES IT: whoever first decodes the clip (peaks-loader.ts), so a take
// recorded today gets its sidecar from the recorder drawing it, and every take
// that predates this heals the first time anyone looks at it. A viewer's
// write is refused by the route (PUT is contributor+) and that is fine — it is
// best-effort, never a reason to fail a waveform.

import { isOnline } from "@/lib/offline/connectivity"
import { audioObjectEndpoint, type SyncTokenForFile } from "./upload"

/** Appended to the clip's object name. Mirrored in sync-worker/src/r2-gc.ts. */
export const PEAKS_SIDECAR_SUFFIX = ".peaks"

const MAGIC = [0x41, 0x51, 0x50, 0x4b] as const // "AQPK"
/** Version 2 adds the clip's length to the header. Version 1 (no length) is
 *  still read: the length is then unknown, as it was before. */
const FORMAT_VERSION = 2
const HEADER_BYTES = { 1: 8, 2: 12 } as const
/** Refuse an implausibly large body before allocating from it. 4096 bins is an
 *  order of magnitude past WAVEFORM_BINS and still only 4KB. */
const MAX_BINS = 4096

/**
 * True only when we KNOW the backend cannot be reached — no network interface,
 * or the desktop probe says it is down. Unknown is not unreachable, so a web
 * tab still gets its chance.
 *
 * A waveform with no network says "not available offline" (useCellAudio's own
 * guard, from Ryder's Wi-Fi-off report); the sidecar must not spend a request
 * that cannot succeed just to get there.
 */
async function backendUnreachable(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true
  return (await isOnline()) === false
}

/**
 * The one bin count a sidecar is written at: WAVEFORM_BINS (peaks-loader.ts,
 * which imports this module, so the number lives here; a test keeps the two
 * equal). One shared object per clip can only hold one shape, and a reader
 * asking for a different count must not overwrite everyone else's with its
 * own: it reads this one and narrows it (`peaksAtBins`) instead.
 */
export const SIDECAR_BINS = 320

/** Stored peaks, and the clip's length when the writer knew it. */
export interface StoredPeaks {
  peaks: Float32Array
  /** Milliseconds; null when unknown (a version 1 sidecar, or a decode that
   *  could not tell). */
  durationMs: number | null
}

/**
 * `peaks` at `bins`: as they are when the counts match, narrowed by taking the
 * loudest of each group when fewer are wanted (peaks are per-bin maximums, so
 * this is what decoding at the smaller count draws), and null when more are
 * wanted than the stored shape has.
 */
export function peaksAtBins(peaks: Float32Array, bins: number): Float32Array | null {
  if (!Number.isInteger(bins) || bins <= 0 || bins > peaks.length) return null
  if (bins === peaks.length) return peaks
  const out = new Float32Array(bins)
  for (let i = 0; i < bins; i++) {
    const from = Math.floor((i * peaks.length) / bins)
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / bins))
    let max = 0
    for (let j = from; j < to; j++) if (peaks[j] > max) max = peaks[j]
    out[i] = max
  }
  return out
}

export function peaksSidecarObjectName(audioId: string, ext: string): string {
  return `${audioId}.${ext}${PEAKS_SIDECAR_SUFFIX}`
}

/**
 * Peaks as the stored body: a 12-byte header then one byte per bin.
 *
 *   0..3   magic "AQPK"
 *   4      format version (2)
 *   5      reserved, zero
 *   6..7   bin count, little-endian uint16
 *   8..11  the clip's length in ms, little-endian uint32; 0 = unknown
 *   12..   bins, each amplitude quantized to 0..255
 *
 * A byte a bin is 1/255 of full scale — below a pixel on any waveform the app
 * draws, and it keeps a chapter's worth of shapes inside one TCP window.
 *
 * The length rides along because a waveform drawn from a sidecar never decodes
 * the clip, and decoding was how a card learned the length of a clip whose
 * attachment carries none (a voice-together clip, older takes): without it the
 * card cannot place the faded trim ends or offer the trim handles.
 */
export function encodePeaksSidecar(peaks: Float32Array, durationMs?: number | null): Uint8Array<ArrayBuffer> {
  const bins = peaks.length
  const header = HEADER_BYTES[FORMAT_VERSION]
  const out = new Uint8Array(new ArrayBuffer(header + bins))
  out.set(MAGIC, 0)
  out[4] = FORMAT_VERSION
  out[5] = 0
  out[6] = bins & 0xff
  out[7] = (bins >> 8) & 0xff
  const ms = durationMs != null && Number.isFinite(durationMs) && durationMs > 0 ? Math.min(0xffffffff, Math.round(durationMs)) : 0
  new DataView(out.buffer).setUint32(8, ms, true)
  for (let i = 0; i < bins; i++) {
    const v = peaks[i]
    const clamped = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
    out[header + i] = Math.round(clamped * 255)
  }
  return out
}

/**
 * The stored body back as peaks, or null for anything this version cannot
 * read — a truncated object, a future format, somebody else's bytes. Null is
 * always answerable by decoding the clip, so a sidecar is never load-bearing.
 */
export function decodePeaksSidecar(bytes: Uint8Array): StoredPeaks | null {
  if (bytes.byteLength < HEADER_BYTES[1]) return null
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return null
  const version = bytes[4]
  if (version !== 1 && version !== 2) return null
  const header = HEADER_BYTES[version]
  const bins = bytes[6] | (bytes[7] << 8)
  if (bins <= 0 || bins > MAX_BINS) return null
  if (bytes.byteLength < header + bins) return null
  const ms = version === 2 ? new DataView(bytes.buffer, bytes.byteOffset, header).getUint32(8, true) : 0
  const peaks = new Float32Array(bins)
  for (let i = 0; i < bins; i++) peaks[i] = bytes[header + i] / 255
  return { peaks, durationMs: ms > 0 ? ms : null }
}

export interface PeaksSidecarArgs {
  projectId: string
  /** The file that OWNS the clip, as for the clip's own bytes. */
  fileId: string
  audioId: string
  ext: string
  getSyncToken: SyncTokenForFile
  fetchFn?: typeof fetch
}

/**
 * The stored peaks for one clip, or null when there are none to be had — no
 * sidecar yet, no token, an unreadable body, a network blip. Never throws:
 * every failure means "decode the clip instead".
 */
export async function fetchPeaksSidecar(args: PeaksSidecarArgs): Promise<StoredPeaks | null> {
  const { projectId, fileId, audioId, ext, getSyncToken } = args
  const fetchFn = args.fetchFn ?? fetch
  try {
    if (await backendUnreachable()) return null
    const token = await getSyncToken(projectId, fileId)
    if (!token) return null
    const res = await fetchFn(
      audioObjectEndpoint(projectId, fileId, peaksSidecarObjectName(audioId, ext)),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) return null
    const buf = await res.arrayBuffer()
    return decodePeaksSidecar(new Uint8Array(buf))
  } catch {
    return null
  }
}

/**
 * What became of a write.
 *
 *   "stored"  — the object landed.
 *   "refused" — the server said no, and will go on saying no: a viewer (the
 *               route's PUT floor is contributor) is the ordinary case.
 *   "skipped" — the request was never made, or died in flight: offline, no
 *               token, a blip. Worth trying again later in the session.
 */
export type PeaksSidecarPutResult = "stored" | "refused" | "skipped"

/**
 * Store one clip's peaks beside it. Best-effort by construction: the caller
 * already holds the peaks it was asked for, so nothing here is a failure it
 * has to handle — only something `publishPeaksSidecarOnce` reads to decide
 * whether asking again could ever help.
 */
export async function putPeaksSidecar(
  args: PeaksSidecarArgs & { peaks: Float32Array; durationMs?: number | null },
): Promise<PeaksSidecarPutResult> {
  const { projectId, fileId, audioId, ext, peaks, durationMs, getSyncToken } = args
  if (peaks.length === 0 || peaks.length > MAX_BINS) return "refused"
  const fetchFn = args.fetchFn ?? fetch
  try {
    if (await backendUnreachable()) return "skipped"
    const token = await getSyncToken(projectId, fileId)
    if (!token) return "skipped"
    const body = encodePeaksSidecar(peaks, durationMs)
    // As a plain ArrayBuffer: the exact bytes, and the one body type every
    // fetch implementation in this codebase's targets takes without a cast.
    const bodyBuffer = body.buffer
    const res = await fetchFn(
      audioObjectEndpoint(projectId, fileId, peaksSidecarObjectName(audioId, ext)),
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        body: bodyBuffer,
      },
    )
    return res.ok ? "stored" : "refused"
  } catch {
    return "skipped"
  }
}

/**
 * Clips whose sidecar this tab has already tried to publish. One attempt per
 * clip per session: a viewer cannot write one (the route's PUT floor is
 * contributor), and retrying on every scroll-back would spend a request each
 * time to be told so again.
 */
const publishAttempted = new Set<string>()

/** Tests only: forget which clips this tab has already tried to publish. */
export function __resetPeaksSidecarPublishesForTests(): void {
  publishAttempted.clear()
}

/**
 * Publish one clip's peaks beside it, at most once per clip per session.
 * Called by whoever decoded the clip, which is how takes recorded before this
 * existed get a sidecar — the first person to look at one writes it for
 * everybody.
 *
 * The returned promise is there to be ignored: the caller already holds the
 * peaks it needed, and nothing it does depends on this landing. It resolves
 * when the attempt is over, which is what a test can wait on.
 */
export async function publishPeaksSidecarOnce(
  args: PeaksSidecarArgs & { peaks: Float32Array; durationMs?: number | null },
): Promise<void> {
  // Only the shared count is ever written (see SIDECAR_BINS).
  if (args.peaks.length !== SIDECAR_BINS) return
  const key = `${args.projectId}/${args.fileId}/${peaksSidecarObjectName(args.audioId, args.ext)}`
  if (publishAttempted.has(key)) return
  publishAttempted.add(key)
  const result = await putPeaksSidecar(args)
  // A refusal stands for the session — a viewer asking again on every
  // scroll-back would spend a request each time to be told the same thing. A
  // write we never got to make must not count as having been made.
  if (result === "skipped") publishAttempted.delete(key)
}
