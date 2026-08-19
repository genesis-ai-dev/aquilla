// Which rendition of a streamed film we are willing to decode. (AQU-646)
//
// The linked videos are not files. Every project's `coreMediaUrl` is an HLS
// master playlist — `https://cdn.thechosen.media/videos/<id>/master.m3u8` — and
// episode 101's master offers TEN video renditions, H.264 and HEVC, from 854×480
// up to 3840×2160 (the 4K HEVC one averages 13 Mbps and peaks at 28), alongside
// 229 audio and subtitle tracks.
//
// Left to itself the player climbs as high as the connection allows, so a fast
// link means a Mac decoding 4K into a pane a few hundred pixels wide. That is
// the load Safari's own pipeline was wedging under: play, half a second, frozen
// picture, no event fired. A reference film beside a text table does not need
// more than 720p, and pinning the ceiling removes both the decode cost and the
// mid-playback quality switches, which are their own stall risk.
//
// Pure and separate from the hook so the ceiling is a tested rule rather than a
// property of a library's ABR heuristics.

/** The tallest rendition worth decoding for a reference picture. */
export const MAX_LEVEL_HEIGHT = 720

/** Does this address need a streaming player rather than a plain `<video src>`?
 *
 *  Only Safari can play an HLS playlist natively; a Chromium or Firefox
 *  `<video>` pointed at one fails outright, which is why the picture has been
 *  Safari-only. */
export function isHlsSource(url: string | null | undefined): boolean {
  if (!url) return false
  // Strip the query and fragment before looking at the extension: a signed CDN
  // URL carries both, and `?token=…` is not part of the filename.
  const path = url.split("#")[0]!.split("?")[0]!
  return /\.m3u8?$/i.test(path)
}

/** The shape we need from a player's level list. Deliberately structural rather
 *  than an import of the library's own type — this rule is testable without it,
 *  and the library's list is exactly this plus a great deal we ignore. */
export interface LevelLike {
  height?: number | null
  width?: number | null
  videoCodec?: string | null
  bitrate?: number | null
}

/**
 * The highest level index the player may climb to, given a list sorted
 * ascending by bitrate (which is how every HLS player presents one).
 *
 * Walk UP from the bottom and stop at the first rendition taller than the cap,
 * rather than picking the tallest allowed one wherever it sits. The two are not
 * the same: 101's list interleaves the codecs by bitrate, so H.264 720p sits
 * ABOVE HEVC 1080p. A ceiling is only a ceiling if everything under it is also
 * under it.
 *
 * Returns -1 for an empty list, which is what a player means by "no cap".
 */
export function capIndexForHeight(
  levels: readonly LevelLike[],
  maxHeight: number = MAX_LEVEL_HEIGHT,
): number {
  if (levels.length === 0) return -1
  let cap = -1
  for (let i = 0; i < levels.length; i += 1) {
    const height = levels[i]?.height
    // A rendition that does not say how tall it is cannot be shown to be within
    // the cap, so it ends the walk like any other.
    if (height == null || !Number.isFinite(height) || height > maxHeight) break
    cap = i
  }
  // Every rendition is taller than we wanted: take the smallest on offer rather
  // than refusing to play. A too-large picture beats no picture.
  return cap === -1 ? 0 : cap
}
