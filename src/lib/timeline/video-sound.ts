// AQU-1681: make a linked video's rows from its OWN sound.
//
// A file whose only media is a linked video (not YouTube) used to need a
// separate recording uploaded before it could have rows. But the film's sound
// is already reachable — the Media view plays it — so this fetches it, keeps
// one copy, and lets the uploaded-recording path take over from there.
//
// Sam's rulings (2026-10-15):
//  • STORE a copy. The sound is fetched once and saved exactly where an
//    uploaded recording goes, so the rows keep playing if the video server
//    moves or changes the film.
//  • Which sound: a streamed film carries one audio rendition per dub. The
//    project's source language is the default; the maintainer may pick
//    another. A direct link to a video file is used as it is.
//  • Size: an episode is ~55 minutes of sound (episode 101: 823 fragments,
//    52 MB of AAC). It is fetched a minute at a time and each minute is
//    decoded at the 16 kHz analysis rate, folded into the silence detector's
//    RMS envelope and released before the next — peak PCM is one minute,
//    never the 420 MB a whole-episode decode allocates. `decodeAudioData`
//    does its work off the main thread; the main thread only folds samples
//    and yields between minutes, so the page stays responsive.
//  • Timing: the rows are timed to the PICTURE. Before anything is fetched in
//    bulk, the sound's first fragment and the picture's are compared on their
//    own clocks; a sound that starts somewhere else is refused rather than
//    turned into rows that are out of step with the film.
//
// For a direct file link the file is downloaded whole and handed to the
// importer's own analysis (`computeMediaSegmentSpecs`), exactly as if the
// person had uploaded it.

import { t } from "@/lib/i18n/standalone"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { MAX_AUDIO_OBJECT_BYTES } from "@/lib/audio/upload"
import {
  ANALYSIS_CHUNK_MS,
  ANALYSIS_SAMPLE_RATE,
  decodeWithWebAudio,
  type AudioDecodeFn,
} from "@/lib/audio/speech-analysis"
import {
  createRmsEnvelope,
  detectSpeechSegmentsFromEnvelope,
  DEFAULT_WINDOW_MS,
  type SpeechSegment,
} from "@/lib/timeline/silence-split"
import { isHlsSource } from "@/lib/video/hls-levels"
import { isDescriptionTrack, pickAudioTrack } from "@/lib/video/film-audio-tracks"
import {
  cheapestVariantFor,
  isMasterPlaylist,
  parseHlsMaster,
  parseHlsMediaPlaylist,
  type HlsAudioRendition,
  type HlsByteRange,
  type HlsMaster,
  type HlsSegment,
} from "@/lib/video/hls-playlist"
import { fragmentStartSec, readFragmentTiming, readInitTracks, type Mp4TrackInfo } from "@/lib/video/mp4-fragments"

/** The sound may start this far from the picture and still make rows: about
 *  two frames at 25 fps, and well inside the 50 ms the splitter pads each
 *  row with. An intro left on one stream and not the other is seconds. */
export const MAX_SOUND_OFFSET_SEC = 0.1

/** Fragments fetched at once. Enough to keep a connection busy, few enough
 *  that a cancel stops quickly. */
const FETCH_CONCURRENCY = 6
const FETCH_ATTEMPTS = 3
const RETRY_DELAYS_MS = [400, 1500] as const
/** A ranged read of a picture fragment's first bytes reaches its `moof`. */
const HEADER_PROBE_BYTES = 64 * 1024

/** One sound track a maintainer can choose. */
export interface VideoSoundTrack {
  id: string
  name: string
  lang: string | null
}

/** Where a linked video's sound comes from, read before anything is fetched. */
export type VideoSoundSource =
  | {
      kind: "stream"
      url: string
      /** Null when the link is a media playlist rather than a master. */
      master: HlsMaster | null
      /** The renditions on offer; empty for a bare media playlist. */
      tracks: HlsAudioRendition[]
      /** The rendition used unless the maintainer picks another. */
      defaultTrackId: string | null
    }
  | { kind: "file"; url: string }

export interface VideoSoundDeps {
  fetchFn?: typeof fetch
  /** Decoder, injected by tests. Defaults to the importer's Web Audio one. */
  decode?: AudioDecodeFn
  /** Hand the main thread back between minutes. Injected by tests. */
  yieldToEventLoop?: () => Promise<void>
  /** Sound decoded per step; tests shrink it. */
  chunkMs?: number
  /** Retry back-off; tests zero it. */
  retryDelaysMs?: readonly number[]
}

export type VideoSoundProgress =
  /** Fetching (and, for a stream, analysing) the sound. `fraction` is null
   *  when the size is not known up front. */
  | { phase: "download"; fraction: number | null }

/** Every step of making the rows, for the empty state's progress line:
 *  fetching the sound, storing the copy, then making the rows. */
export type VideoSoundRunProgress = VideoSoundProgress | { phase: "save" } | { phase: "rows" }

/**
 * What the linked-video empty state asks of the workspace. The workspace owns
 * the file, the project's source language and the stored copy; the card owns
 * only the choice of track, the progress and the cancel.
 */
export interface LinkedVideoSoundActions {
  /** The sound tracks on offer. Empty for a direct file: nothing to choose. */
  describe(signal: AbortSignal): Promise<{ tracks: VideoSoundTrack[]; defaultTrackId: string | null }>
  /** Fetch the chosen track, store it, and make the rows. */
  run(
    trackId: string | null,
    opts: { signal: AbortSignal; onProgress: (progress: VideoSoundRunProgress) => void },
  ): Promise<void>
}

export interface ExtractedVideoSound {
  /** The bytes to store, named and typed like an upload. */
  file: File
  /** A stream's speech, found while it was fetched — so it is not decoded a
   *  second time. Absent for a direct file, which the importer analyses. */
  analysis?: { segments: SpeechSegment[]; durationMs: number }
}

function videoSoundError(key: MessageKey, values?: Record<string, string | number>, cause?: unknown): Error {
  return new Error(t(key, values), cause === undefined ? undefined : { cause })
}

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (err instanceof DOMException && err.name === "AbortError")
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  deps: VideoSoundDeps,
): Promise<Response> {
  const fetchFn = deps.fetchFn ?? fetch
  const delays = deps.retryDelaysMs ?? RETRY_DELAYS_MS
  let last: unknown = null
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    init.signal?.throwIfAborted()
    try {
      const res = await fetchFn(url, init)
      if (res.ok) return res
      last = new Error(`${res.status} ${res.statusText}`)
      // Only a server hiccup is worth asking again.
      if (res.status < 500 && res.status !== 408 && res.status !== 429) break
    } catch (err) {
      if (isAbort(err, init.signal ?? undefined)) throw err
      last = err
    }
    if (attempt < FETCH_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, delays[attempt] ?? 0))
  }
  throw videoSoundError("editor.media.videoSound.fetchFailed", undefined, last)
}

async function fetchText(url: string, signal: AbortSignal | undefined, deps: VideoSoundDeps): Promise<string> {
  return (await fetchWithRetry(url, { signal }, deps)).text()
}

async function fetchBytes(
  url: string,
  range: HlsByteRange | undefined,
  signal: AbortSignal | undefined,
  deps: VideoSoundDeps,
): Promise<Uint8Array> {
  const headers: Record<string, string> = range
    ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` }
    : {}
  const res = await fetchWithRetry(url, { signal, headers }, deps)
  return new Uint8Array(await res.arrayBuffer())
}

/**
 * Read what sound a linked video offers. For a streamed film that is its
 * audio renditions (narration-for-the-blind tracks left out) and the one to
 * default to: the project's source language, else English, else the
 * manifest's own pick (`pickAudioTrack`).
 */
export async function describeVideoSound(
  url: string,
  sourceLanguage: string | null | undefined,
  deps: VideoSoundDeps & { signal?: AbortSignal } = {},
): Promise<VideoSoundSource> {
  const trimmed = url.trim()
  if (!isHlsSource(trimmed)) return { kind: "file", url: trimmed }
  const text = await fetchText(trimmed, deps.signal, deps)
  if (!isMasterPlaylist(text)) {
    return { kind: "stream", url: trimmed, master: null, tracks: [], defaultTrackId: null }
  }
  const master = parseHlsMaster(text, trimmed)
  const tracks = master.audio.filter((track) => !isDescriptionTrack(track))
  if (tracks.length === 0) throw videoSoundError("editor.media.videoSound.noSeparateSound")
  const picked = pickAudioTrack(tracks, sourceLanguage)
  return {
    kind: "stream",
    url: trimmed,
    master,
    tracks,
    defaultTrackId: picked ? String(picked.id) : tracks[0]!.id,
  }
}

export interface ExtractVideoSoundArgs extends VideoSoundDeps {
  source: VideoSoundSource
  /** A rendition id from `source.tracks`; null/absent = the default. */
  trackId?: string | null
  /** Name for the stored copy, without extension. */
  baseName: string
  signal?: AbortSignal
  onProgress?: (progress: VideoSoundProgress) => void
}

/** Fetch the sound (and, for a stream, find its speech). */
export async function extractVideoSound(args: ExtractVideoSoundArgs): Promise<ExtractedVideoSound> {
  return args.source.kind === "file"
    ? downloadVideoFile(args.source.url, args)
    : extractStreamSound(args.source, args)
}

// ── A direct link to a video file ─────────────────────────────────────────

const EXT_FOR_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
}

function extensionOf(name: string): string | null {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name)
  return m ? m[1]!.toLowerCase() : null
}

async function downloadVideoFile(url: string, args: ExtractVideoSoundArgs): Promise<ExtractedVideoSound> {
  const { signal, onProgress } = args
  let res: Response
  try {
    res = await fetchWithRetry(url, { signal }, args)
  } catch (err) {
    if (isAbort(err, signal)) throw err
    // A cross-origin server that does not allow reading lands here as well:
    // the browser reports it as a network failure and says nothing more.
    throw videoSoundError("editor.media.videoSound.fileUnreadable", undefined, err)
  }
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase()
  const declared = Number(res.headers.get("content-length"))
  const total = Number.isFinite(declared) && declared > 0 ? declared : null
  if (total !== null && total > MAX_AUDIO_OBJECT_BYTES) throw videoSoundError("editor.media.videoSound.tooLarge")

  const parts: Uint8Array[] = []
  let received = 0
  onProgress?.({ phase: "download", fraction: total ? 0 : null })
  const reader = res.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      parts.push(value)
      received += value.byteLength
      if (received > MAX_AUDIO_OBJECT_BYTES) {
        void reader.cancel()
        throw videoSoundError("editor.media.videoSound.tooLarge")
      }
      onProgress?.({ phase: "download", fraction: total ? Math.min(1, received / total) : null })
    }
  } else {
    const bytes = new Uint8Array(await res.arrayBuffer())
    parts.push(bytes)
    received = bytes.byteLength
  }
  if (received === 0) throw videoSoundError("editor.media.videoSound.empty")

  const fromUrl = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "")
  const ext = extensionOf(fromUrl) ?? EXT_FOR_TYPE[type] ?? "mp4"
  const name = extensionOf(fromUrl) ? fromUrl : `${args.baseName}.${ext}`
  return { file: new File(parts as BlobPart[], name, { type: type || `video/${ext}` }) }
}

// ── A streamed film ───────────────────────────────────────────────────────

async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/** Group fragments into steps of at least `chunkMs` of sound. */
function planChunks(segments: readonly HlsSegment[], chunkMs: number): HlsSegment[][] {
  const chunks: HlsSegment[][] = []
  let current: HlsSegment[] = []
  let ms = 0
  for (const seg of segments) {
    current.push(seg)
    ms += seg.durationSec * 1000
    if (ms >= chunkMs) {
      chunks.push(current)
      current = []
      ms = 0
    }
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

function concat(parts: readonly Uint8Array[]): ArrayBuffer {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.byteLength
  }
  return out.buffer
}

/** Seconds of sound a fragment holds, from its own boxes; the playlist's
 *  `EXTINF` only when the boxes do not say. */
function fragmentSeconds(bytes: Uint8Array, seg: HlsSegment, track: Mp4TrackInfo | undefined, tracks: Mp4TrackInfo[]): number {
  if (track) {
    const timing = readFragmentTiming(bytes, tracks).find((f) => f.trackId === track.trackId)
    if (timing?.durationTicks != null) return timing.durationTicks / track.timescale
  }
  return seg.durationSec
}

/**
 * Compare where the sound's first fragment and the picture's sit on their own
 * clocks. Players line renditions up by those times, so a difference is how
 * far the sound runs ahead of or behind the picture. Returns null when either
 * cannot be read — the check is then skipped, not failed.
 */
async function soundOffsetFromPicture(
  master: HlsMaster,
  rendition: HlsAudioRendition,
  soundStartSec: number | null,
  signal: AbortSignal | undefined,
  deps: VideoSoundDeps,
): Promise<number | null> {
  if (soundStartSec === null) return null
  const variant = cheapestVariantFor(master, rendition)
  if (!variant) return null
  try {
    const picture = parseHlsMediaPlaylist(await fetchText(variant.uri, signal, deps), variant.uri)
    const first = picture.segments[0]
    if (!picture.init || !first) return null
    const init = await fetchBytes(picture.init.url, picture.init.byteRange, signal, deps)
    const head = await fetchBytes(
      first.url,
      first.byteRange ?? { offset: 0, length: HEADER_PROBE_BYTES },
      signal,
      deps,
    )
    const pictureStartSec = fragmentStartSec(init, head, "vide")
    return pictureStartSec === null ? null : soundStartSec - pictureStartSec
  } catch (err) {
    if (isAbort(err, signal)) throw err
    console.warn("[video-sound] AQU-1681: could not read the picture's start; skipping the timing check", err)
    return null
  }
}

async function extractStreamSound(
  source: Extract<VideoSoundSource, { kind: "stream" }>,
  args: ExtractVideoSoundArgs,
): Promise<ExtractedVideoSound> {
  const { signal, onProgress } = args
  const decode = args.decode ?? decodeWithWebAudio
  const yieldToEventLoop = args.yieldToEventLoop ?? (() => new Promise<void>((r) => setTimeout(r, 0)))
  const rendition = source.tracks.find((tr) => tr.id === (args.trackId ?? source.defaultTrackId)) ?? null
  const playlistUrl = rendition?.uri ?? source.url

  const playlist = parseHlsMediaPlaylist(await fetchText(playlistUrl, signal, args), playlistUrl)
  if (playlist.encrypted) throw videoSoundError("editor.media.videoSound.encrypted")
  if (!playlist.init) throw videoSoundError("editor.media.videoSound.unsupportedFormat")
  if (playlist.segments.length === 0) throw videoSoundError("editor.media.videoSound.empty")

  const init = await fetchBytes(playlist.init.url, playlist.init.byteRange, signal, args)
  const tracks = readInitTracks(init)
  const soundTrack = tracks.find((tr) => tr.handler === "soun") ?? tracks[0]

  const chunks = planChunks(playlist.segments, args.chunkMs ?? ANALYSIS_CHUNK_MS)
  const fetchChunk = (chunk: HlsSegment[]) =>
    mapPool(chunk, FETCH_CONCURRENCY, (seg) => fetchBytes(seg.url, seg.byteRange, signal, args))

  let pending = fetchChunk(chunks[0]!)
  const first = await pending
  if (source.master && rendition) {
    const offset = await soundOffsetFromPicture(
      source.master,
      rendition,
      fragmentStartSec(init, first[0]!, "soun"),
      signal,
      args,
    )
    if (offset !== null && Math.abs(offset) > MAX_SOUND_OFFSET_SEC) {
      throw videoSoundError("editor.media.videoSound.offset", {
        seconds: Math.abs(offset).toFixed(1),
      })
    }
  }

  const envelope = createRmsEnvelope(ANALYSIS_SAMPLE_RATE, DEFAULT_WINDOW_MS)
  const stored: Uint8Array[] = [init]
  const total = playlist.segments.length
  let fetched = 0
  let soundSec = 0
  let samplesSoFar = 0
  onProgress?.({ phase: "download", fraction: 0 })

  for (let k = 0; k < chunks.length; k += 1) {
    const parts = await pending
    // Fetch the next minute while this one decodes. A cancel or a failure
    // abandons it; never leave its rejection unhandled.
    if (k + 1 < chunks.length) {
      pending = fetchChunk(chunks[k + 1]!)
      pending.catch(() => {})
    }
    signal?.throwIfAborted()

    for (const [i, bytes] of parts.entries()) soundSec += fragmentSeconds(bytes, chunks[k]![i]!, soundTrack, tracks)
    // Cut each minute to the length its fragments declare, measured from the
    // start of the film rather than chunk by chunk, so rounding cannot
    // accumulate either.
    const endSample = Math.round(soundSec * ANALYSIS_SAMPLE_RATE)
    const expected = endSample - samplesSoFar
    samplesSoFar = endSample

    let pcm: Float32Array
    try {
      pcm = (await decode(concat([init, ...parts]), ANALYSIS_SAMPLE_RATE)).channel
    } catch (err) {
      throw videoSoundError("editor.media.videoSound.decodeFailed", undefined, err)
    }
    if (pcm.length >= expected) envelope.push(pcm.subarray(0, expected))
    else {
      const padded = new Float32Array(expected)
      padded.set(pcm)
      envelope.push(padded)
    }

    stored.push(...parts)
    fetched += parts.length
    onProgress?.({ phase: "download", fraction: fetched / total })
    await yieldToEventLoop()
  }

  const name = `${args.baseName}${rendition ? ` (${rendition.name})` : ""}.m4a`
  return {
    // The fragments end to end behind their init segment are one playable
    // fragmented MP4: Chrome reads its length and seeks anywhere in it.
    file: new File(stored as BlobPart[], name, { type: "audio/mp4" }),
    analysis: {
      segments: detectSpeechSegmentsFromEnvelope(envelope.finish()),
      durationMs: soundSec * 1000,
    },
  }
}
