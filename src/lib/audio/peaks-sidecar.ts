// A clip's waveform, stored next to the clip. (AQU-2095)
//
// WHY: a waveform used to cost the whole recording. Opening the Audio view
// downloaded every on-screen take just to draw its shape — Genesis 1 is 22
// recordings and 404KB, which is 3.6s on Slow 4G and 8.6s on 3G before a
// single bar appears, for a picture 20px tall. Peaks are the only thing the
// list actually needs, and 320 of them quantized to a byte each is 328 bytes:
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

import { audioObjectEndpoint, type SyncTokenForFile } from "./upload"

/** Appended to the clip's object name. Mirrored in sync-worker/src/r2-gc.ts. */
export const PEAKS_SIDECAR_SUFFIX = ".peaks"

const MAGIC = [0x41, 0x51, 0x50, 0x4b] as const // "AQPK"
const FORMAT_VERSION = 1
const HEADER_BYTES = 8
/** Refuse an implausibly large body before allocating from it. 4096 bins is an
 *  order of magnitude past WAVEFORM_BINS and still only 4KB. */
const MAX_BINS = 4096

export function peaksSidecarObjectName(audioId: string, ext: string): string {
  return `${audioId}.${ext}${PEAKS_SIDECAR_SUFFIX}`
}

/**
 * Peaks as the stored body: a 8-byte header then one byte per bin.
 *
 *   0..3  magic "AQPK"
 *   4     format version
 *   5     reserved, zero
 *   6..7  bin count, little-endian uint16
 *   8..   bins, each amplitude quantized to 0..255
 *
 * A byte a bin is 1/255 of full scale — below a pixel on any waveform the app
 * draws, and it keeps a chapter's worth of shapes inside one TCP window.
 */
export function encodePeaksSidecar(peaks: Float32Array): Uint8Array {
  const bins = peaks.length
  const out = new Uint8Array(HEADER_BYTES + bins)
  out.set(MAGIC, 0)
  out[4] = FORMAT_VERSION
  out[5] = 0
  out[6] = bins & 0xff
  out[7] = (bins >> 8) & 0xff
  for (let i = 0; i < bins; i++) {
    const v = peaks[i]
    const clamped = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0
    out[HEADER_BYTES + i] = Math.round(clamped * 255)
  }
  return out
}

/**
 * The stored body back as peaks, or null for anything this version cannot
 * read — a truncated object, a future format, somebody else's bytes. Null is
 * always answerable by decoding the clip, so a sidecar is never load-bearing.
 */
export function decodePeaksSidecar(bytes: Uint8Array): Float32Array | null {
  if (bytes.byteLength < HEADER_BYTES) return null
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return null
  if (bytes[4] !== FORMAT_VERSION) return null
  const bins = bytes[6] | (bytes[7] << 8)
  if (bins <= 0 || bins > MAX_BINS) return null
  if (bytes.byteLength < HEADER_BYTES + bins) return null
  const peaks = new Float32Array(bins)
  for (let i = 0; i < bins; i++) peaks[i] = bytes[HEADER_BYTES + i] / 255
  return peaks
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
export async function fetchPeaksSidecar(args: PeaksSidecarArgs): Promise<Float32Array | null> {
  const { projectId, fileId, audioId, ext, getSyncToken } = args
  const fetchFn = args.fetchFn ?? fetch
  try {
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
 * Store one clip's peaks beside it. Returns whether the object landed — false
 * covers a viewer (the route's PUT floor is contributor), an offline tab, and
 * every other refusal. Best-effort by construction: the caller already has the
 * peaks it was asked for.
 */
export async function putPeaksSidecar(
  args: PeaksSidecarArgs & { peaks: Float32Array },
): Promise<boolean> {
  const { projectId, fileId, audioId, ext, peaks, getSyncToken } = args
  if (peaks.length === 0 || peaks.length > MAX_BINS) return false
  const fetchFn = args.fetchFn ?? fetch
  try {
    const token = await getSyncToken(projectId, fileId)
    if (!token) return false
    const body = encodePeaksSidecar(peaks)
    const res = await fetchFn(
      audioObjectEndpoint(projectId, fileId, peaksSidecarObjectName(audioId, ext)),
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        body: body as BodyInit,
      },
    )
    return res.ok
  } catch {
    return false
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
 * Publish one clip's peaks beside it, at most once per clip per session, and
 * do not wait for it: the caller already holds the peaks it needed. Called by
 * whoever decoded the clip, which is how takes recorded before this existed
 * get a sidecar — the first person to look at one writes it for everybody.
 */
export function publishPeaksSidecarOnce(args: PeaksSidecarArgs & { peaks: Float32Array }): void {
  const key = `${args.projectId}/${args.fileId}/${peaksSidecarObjectName(args.audioId, args.ext)}`
  if (publishAttempted.has(key)) return
  publishAttempted.add(key)
  void putPeaksSidecar(args)
}
