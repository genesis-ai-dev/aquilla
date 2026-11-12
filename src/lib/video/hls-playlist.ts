// Reading a streamed film's playlists ourselves. (AQU-1681)
//
// The picture plays through hls.js, which reads these playlists for us. Making
// rows from the film's own sound needs the SOUND on its own, as bytes: one
// audio rendition's segments, fetched and decoded a minute at a time. hls.js
// does not hand those out, so this reads the two playlist kinds directly.
//
// The client's masters (episode 101, read 2026-10-15) carry 65 audio renditions
// as `EXT-X-MEDIA:TYPE=AUDIO` lines, each its own fMP4 playlist: an
// `EXT-X-MAP` init segment and ~820 four-second `.m4s` fragments of 128 kbps
// AAC. Only that shape is supported. MPEG-TS segments (no `EXT-X-MAP`) need a
// demuxer the browser does not have, and an encrypted playlist needs keys we
// should not be fetching; both are reported, not guessed at.
//
// Pure: text in, structure out, every address made absolute against the
// playlist it came from.

import type { FilmAudioTrack } from "./film-audio-tracks"

/** One `EXT-X-MEDIA:TYPE=AUDIO` rendition that has its own playlist. */
export interface HlsAudioRendition extends FilmAudioTrack {
  /** The rendition's playlist address, absolute — also its `id`. */
  id: string
  uri: string
  /** `GROUP-ID`: the variants that play with this rendition name it. */
  groupId: string
}

/** One `EXT-X-STREAM-INF` variant (a picture rendition). */
export interface HlsVariant {
  uri: string
  bandwidth: number | null
  /** The `AUDIO` group it plays with, when the master names one. */
  audioGroup: string | null
}

export interface HlsMaster {
  audio: HlsAudioRendition[]
  variants: HlsVariant[]
}

export interface HlsByteRange {
  offset: number
  length: number
}

export interface HlsSegment {
  url: string
  /** `EXTINF`, in seconds. */
  durationSec: number
  byteRange?: HlsByteRange
}

export interface HlsMediaPlaylist {
  /** `EXT-X-MAP`: the fMP4 init segment. Null for MPEG-TS playlists. */
  init: { url: string; byteRange?: HlsByteRange } | null
  segments: HlsSegment[]
  /** An `EXT-X-KEY` with a method other than NONE. */
  encrypted: boolean
}

/** A master playlist lists variants; a media playlist lists segments. */
export function isMasterPlaylist(text: string): boolean {
  return /^#EXT-X-STREAM-INF:/m.test(text)
}

/**
 * Split an HLS attribute list. Values may be quoted, and a quoted value may
 * contain commas (`CODECS="avc1.4D401F,mp4a.40.2"`), so this cannot be a
 * plain split on ",".
 */
export function parseAttributes(list: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(list)) !== null) {
    const raw = m[2] ?? ""
    out[m[1]!] = raw.startsWith("\"") ? raw.slice(1, -1) : raw
  }
  return out
}

function resolve(uri: string, base: string): string {
  return new URL(uri, base).toString()
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

/** The audio renditions and picture variants a master playlist offers. */
export function parseHlsMaster(text: string, masterUrl: string): HlsMaster {
  const audio: HlsAudioRendition[] = []
  const variants: HlsVariant[] = []
  const all = lines(text)
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i]!
    if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line.slice("#EXT-X-MEDIA:".length))
      // A rendition without a URI is muxed into the variants: there is no
      // separate sound to fetch.
      if (a.TYPE !== "AUDIO" || !a.URI) continue
      const uri = resolve(a.URI, masterUrl)
      audio.push({
        id: uri,
        uri,
        groupId: a["GROUP-ID"] ?? "",
        name: a.NAME || a.LANGUAGE || uri,
        lang: a.LANGUAGE || null,
        characteristics: a.CHARACTERISTICS ?? null,
        default: a.DEFAULT === "YES",
        autoselect: a.AUTOSELECT === "YES",
      })
    } else if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length))
      const next = all[i + 1]
      if (!next || next.startsWith("#")) continue
      const bandwidth = Number(a.BANDWIDTH)
      variants.push({
        uri: resolve(next, masterUrl),
        bandwidth: Number.isFinite(bandwidth) ? bandwidth : null,
        audioGroup: a.AUDIO ?? null,
      })
    }
  }
  return { audio, variants }
}

function parseByteRange(value: string, previousEnd: number): HlsByteRange | undefined {
  const m = /^(\d+)(?:@(\d+))?$/.exec(value.trim())
  if (!m) return undefined
  const length = Number(m[1])
  const offset = m[2] !== undefined ? Number(m[2]) : previousEnd
  return { offset, length }
}

/** The init segment and media segments of one rendition's playlist. */
export function parseHlsMediaPlaylist(text: string, playlistUrl: string): HlsMediaPlaylist {
  let init: HlsMediaPlaylist["init"] = null
  let encrypted = false
  const segments: HlsSegment[] = []
  let pendingDuration: number | null = null
  let pendingRange: HlsByteRange | undefined
  // EXT-X-BYTERANGE without an offset continues from the previous segment's end.
  let rangeEnd = 0
  for (const line of lines(text)) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(line.slice("#EXT-X-MAP:".length))
      if (a.URI) {
        const range = a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : undefined
        init = { url: resolve(a.URI, playlistUrl), ...(range ? { byteRange: range } : {}) }
      }
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(line.slice("#EXT-X-KEY:".length))
      if (a.METHOD && a.METHOD !== "NONE") encrypted = true
    } else if (line.startsWith("#EXTINF:")) {
      const sec = Number.parseFloat(line.slice("#EXTINF:".length))
      pendingDuration = Number.isFinite(sec) && sec >= 0 ? sec : 0
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice("#EXT-X-BYTERANGE:".length), rangeEnd)
    } else if (!line.startsWith("#") && pendingDuration !== null) {
      segments.push({
        url: resolve(line, playlistUrl),
        durationSec: pendingDuration,
        ...(pendingRange ? { byteRange: pendingRange } : {}),
      })
      if (pendingRange) rangeEnd = pendingRange.offset + pendingRange.length
      pendingDuration = null
      pendingRange = undefined
    }
  }
  return { init, segments, encrypted }
}

/**
 * The cheapest picture variant that plays with `rendition`, for reading where
 * the picture's clock starts. Null when the master names none.
 */
export function cheapestVariantFor(master: HlsMaster, rendition: HlsAudioRendition): HlsVariant | null {
  const candidates = master.variants.filter(
    (v) => v.audioGroup === null || v.audioGroup === rendition.groupId,
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, v) =>
    (v.bandwidth ?? Number.POSITIVE_INFINITY) < (best.bandwidth ?? Number.POSITIVE_INFINITY) ? v : best,
  )
}
