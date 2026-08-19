// Playing a streamed film, in every browser, at a size worth decoding.
// (AQU-646, 2026-08-18)
//
// The linked videos are HLS master playlists, and TWO things follow from that.
//
// Only Safari can play one natively, so a bare `<video src="…m3u8">` fails
// outright in Chrome, Edge and Firefox — the picture, the recorder's film, and
// the duration the source band is drawn from have all been Safari-only without
// anyone saying so out loud. And Safari's own pipeline is the one that has been
// wedging: it climbs to whatever rendition the connection allows, which on a
// fast link means decoding 4K HEVC into a pane a few hundred pixels wide, and
// after a burst of seeks it stops producing frames without firing an event.
//
// So the streaming player goes in front of BOTH problems. It plays these
// addresses everywhere, and — the part that matters for the freeze — it lets us
// say how large a picture we are willing to decode (`hls-levels.ts`).
//
// The library is loaded ONLY when a stream is actually linked: a dynamic import
// keeps it out of the main bundle for every project that has no film.
//
// The native path is kept as a fallback, not as an afterthought. If the library
// cannot run, or fails fatally past its own recovery, Safari's native HLS is
// still a working player and the pane drops back to it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import type Hls from "hls.js"
import { capIndexForHeight, isHlsSource, MAX_LEVEL_HEIGHT } from "@/lib/video/hls-levels"
import {
  DEFAULT_FILM_AUDIO_LANG,
  pickAudioTrack,
  selectableAudioTracks,
  type FilmAudioTrack,
} from "@/lib/video/film-audio-tracks"

/** THE ROLLBACK VALVE. Flip to false and every film goes back to whatever the
 *  browser does with the address on its own — which is the behaviour that
 *  shipped before this, freeze and all. Here so that a bad surprise in Safari
 *  costs one line rather than a revert. */
const PREFER_STREAMING_PLAYER = true

/** How many fatal errors the library may recover from before we stop believing
 *  in it and hand the address back to the browser. */
const MAX_FATAL_RECOVERIES = 2

export type VideoPipeline = "native" | "hls"

/** What `await import("hls.js")` gives us, narrowed to what we use. */
export interface HlsModule {
  default: typeof Hls
}

export type HlsLoader = () => Promise<HlsModule>

const importHls: HlsLoader = () => import("hls.js") as unknown as Promise<HlsModule>

/**
 * Can this browser run the streaming player at all?
 *
 * Media Source Extensions with fragmented-MP4 H.264, which is what the library
 * needs and what these playlists are. Safari desktop has it; iOS has the
 * managed variant; anything without it falls back to native playback, which for
 * an HLS address means Safari or nothing.
 *
 * Deliberately NOT `Hls.isSupported()`: that would mean importing the library
 * before knowing whether we can use it, on every project with a film.
 */
export function streamingPlayerAvailable(): boolean {
  if (typeof window === "undefined") return false
  const Managed = (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource
  const Source = Managed ?? window.MediaSource
  if (typeof Source?.isTypeSupported !== "function") return false
  try {
    return Source.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
  } catch {
    return false
  }
}

/**
 * Safari's own audio track list, which is NOT in the standard DOM types.
 *
 * It is the reason the language picker needs no disabled state: where the
 * streaming player is not driving — the fallback the stall ladder reaches for,
 * and any browser without Media Source Extensions — the one engine that plays
 * these playlists natively is also the one that exposes this. Chromium has no
 * `audioTracks` and no native HLS either, so it never needs it.
 */
interface NativeAudioTrack {
  id: string
  label: string
  language: string
  enabled: boolean
}
interface NativeAudioTrackList {
  readonly length: number
  [index: number]: NativeAudioTrack
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

function nativeAudioTracks(video: HTMLVideoElement | null): NativeAudioTrackList | null {
  const list = (video as unknown as { audioTracks?: NativeAudioTrackList } | null)?.audioTracks
  return list && typeof list.length === "number" ? list : null
}

function readNativeTracks(list: NativeAudioTrackList): FilmAudioTrack[] {
  const out: FilmAudioTrack[] = []
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i]
    if (!t) continue
    out.push({ id: t.id || String(i), name: t.label || t.language || `Track ${i + 1}`, lang: t.language || null })
  }
  return out
}

/** Same renditions, same order? Track lists are re-read whenever the player
 *  says anything about audio, and a fresh array each time would re-run the
 *  effect that applies the choice — which is itself what provoked the event. */
function sameTracks(a: readonly FilmAudioTrack[], b: readonly FilmAudioTrack[]): boolean {
  if (a.length !== b.length) return false
  return a.every((t, i) => t.id === b[i]?.id && t.lang === b[i]?.lang && t.name === b[i]?.name)
}

export interface HlsSnapshot {
  pipeline: VideoPipeline
  /** Null until the manifest has been parsed. */
  currentLevel: number | null
  autoLevelCapping: number | null
  levels: { height: number | null; codec: string | null; bitrate: number | null }[]
  fatalRecoveries: number
  /** What the film is speaking, and what was on offer. */
  audioLang: string | null
  audioTrackCount: number
}

export interface UseHlsVideoOptions {
  /** The tallest rendition we are willing to decode. */
  maxHeight?: number
  /** Bumped by the caller when it has deliberately remounted the element, so
   *  the player is rebuilt around the new one. */
  attachKey?: number
  /** False keeps the browser's own handling — used where there is no element
   *  to attach to yet. */
  enabled?: boolean
  /** Test seam. Production omits it and the library is imported for real. */
  loader?: HlsLoader
  /**
   * What the film should speak. null means nobody has said, which resolves to
   * English — NOT to whatever the player would have picked. These masters carry
   * 65 dubs and flag none of them as the default, so a player left to choose
   * takes the top of an alphabetical list and the film comes up in Amharic.
   */
  audioLanguage?: string | null
}

export interface HlsVideoHandle {
  /** Which player is driving. The caller must give the element its `src`
   *  attribute ONLY on the native path — the streaming player attaches its own
   *  buffered source and a competing `src` would fight it. */
  pipeline: VideoPipeline
  /** Start fetching again from where we are. The first thing to try on a stall
   *  that looks like the stream stopped arriving. */
  restartLoad: () => void
  /** Rebuild the decoder around the current position, keeping the connection.
   *  The library's own remedy for a picture that has stopped decoding. */
  recoverMedia: () => void
  /** Give up on the streaming player for this source and let the browser try.
   *  A genuinely different decoder, which is the point. */
  fallbackToNative: () => void
  /** The languages this film is dubbed into, narration tracks excluded, in the
   *  manifest's own order. Empty until the film has opened — and empty forever
   *  on a plain file, which has one soundtrack and nothing to choose. */
  audioTracks: FilmAudioTrack[]
  /** The one currently sounding, resolved through the fallbacks. */
  activeAudioLang: string | null
  snapshot: () => HlsSnapshot
}

/**
 * Attach a streaming player to an element, for as long as the source needs one.
 */
export function useHlsVideo(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  src: string | null | undefined,
  {
    maxHeight = MAX_LEVEL_HEIGHT,
    attachKey = 0,
    enabled = true,
    loader = importHls,
    audioLanguage = null,
  }: UseHlsVideoOptions = {},
): HlsVideoHandle {
  // Set when the library will not run, or has failed past its own recovery.
  // Keyed to the source, so a different film gets a fresh chance rather than
  // inheriting the last one's bad luck.
  const [abandonedFor, setAbandonedFor] = useState<string | null>(null)
  const abandoned = abandonedFor != null && abandonedFor === src

  const usable =
    PREFER_STREAMING_PLAYER
    && enabled
    && isHlsSource(src)
    && !abandoned
    && streamingPlayerAvailable()
  const pipeline: VideoPipeline = usable ? "hls" : "native"

  const hlsRef = useRef<Hls | null>(null)
  const fatalRef = useRef(0)
  const capRef = useRef<number | null>(null)
  /** What the film is dubbed into, as the driving player reports it. */
  const [audioTracks, setAudioTracks] = useState<FilmAudioTrack[]>([])
  /** Read once at construction so the FIRST segments fetched are already the
   *  right language — correcting it afterwards works, but you hear the wrong
   *  one first. Deliberately a ref: changing the language must not tear the
   *  player down and rebuild it. */
  const audioLanguageRef = useRef(audioLanguage)
  useEffect(() => {
    audioLanguageRef.current = audioLanguage
  }, [audioLanguage])

  useEffect(() => {
    if (pipeline !== "hls" || !src) return
    const video = videoRef.current
    if (!video) return

    let cancelled = false
    let instance: Hls | null = null
    const abandon = () => {
      if (cancelled) return
      setAbandonedFor(src)
    }

    void (async () => {
      let Ctor: typeof Hls
      try {
        Ctor = (await loader()).default
      } catch {
        // The chunk did not load. Nothing to do but let the browser try.
        abandon()
        return
      }
      if (cancelled) return
      if (!Ctor.isSupported()) {
        abandon()
        return
      }

      instance = new Ctor({
        // Never decode a picture much larger than the box it is drawn in. The
        // library re-evaluates this as the pane is resized.
        capLevelToPlayerSize: true,
        // H.264, standard range. HEVC is the rendition family Safari was most
        // likely wedging on, and nothing here needs HDR.
        videoPreference: { videoCodec: "avc1", allowedVideoRanges: ["SDR" as const] },
        // English unless this film has been set otherwise. Without it the
        // library picks for itself, and with no DEFAULT in the manifest that
        // means the first rendition alphabetically.
        audioPreference: { lang: audioLanguageRef.current ?? DEFAULT_FILM_AUDIO_LANG },
        // An hour-long episode scrubbed through all afternoon will hold every
        // segment it has ever played unless told not to.
        backBufferLength: 30,
      })
      // The playlists carry their own subtitle renditions — 101's has dozens.
      // We draw captions ourselves, from the file being translated, and two
      // sets of words over one picture is worse than either. A property rather
      // than a config key, which is where the library keeps this one.
      instance.subtitleDisplay = false
      if (cancelled) {
        instance.destroy()
        return
      }
      hlsRef.current = instance
      fatalRef.current = 0

      instance.on(Ctor.Events.MANIFEST_PARSED, () => {
        const hls = hlsRef.current
        if (!hls) return
        // The library has already dropped renditions this browser cannot decode
        // (all the HEVC ones, in Chrome), so the cap is computed against what is
        // actually on offer here.
        const cap = capIndexForHeight(hls.levels ?? [], maxHeight)
        capRef.current = cap
        hls.autoLevelCapping = cap
      })

      const publishTracks = () => {
        const hls = hlsRef.current
        if (!hls) return
        const next = selectableAudioTracks(
          (hls.audioTracks ?? []).map((a) => ({
            id: a.id,
            name: a.name,
            lang: a.lang ?? null,
            characteristics: a.characteristics ?? null,
            default: a.default,
            autoselect: a.autoselect,
          })),
        )
        setAudioTracks((prev) => (sameTracks(prev, next) ? prev : next))
      }
      instance.on(Ctor.Events.AUDIO_TRACKS_UPDATED, publishTracks)
      instance.on(Ctor.Events.AUDIO_TRACK_SWITCHED, publishTracks)
      instance.on(Ctor.Events.MANIFEST_PARSED, publishTracks)

      instance.on(Ctor.Events.ERROR, (_event, data) => {
        if (!data.fatal) return
        const hls = hlsRef.current
        if (!hls) return
        fatalRef.current += 1
        if (fatalRef.current > MAX_FATAL_RECOVERIES) {
          abandon()
          return
        }
        // The library's own two remedies, and they are not interchangeable:
        // one re-opens the connection, the other rebuilds the decoder.
        if (data.type === Ctor.ErrorTypes.NETWORK_ERROR) hls.startLoad()
        else if (data.type === Ctor.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
        else abandon()
      })

      instance.attachMedia(video)
      instance.loadSource(src)
    })()

    return () => {
      cancelled = true
      setAudioTracks([])
      const open = instance ?? hlsRef.current
      if (open) {
        // Detaches the element too, so the next player starts against a clean
        // one rather than inheriting a half-filled buffer.
        open.destroy()
      }
      if (hlsRef.current === instance) hlsRef.current = null
      capRef.current = null
    }
    // `attachKey` is the caller saying it replaced the element; without it a
    // rebuilt element would keep the old, detached player.
  }, [pipeline, src, attachKey, maxHeight, loader, videoRef])

  /**
   * The same list, where the browser is the player. Safari populates its own
   * `audioTracks` for native HLS, which is what lets the picker keep working
   * after the stall ladder has handed the film back to it.
   */
  useEffect(() => {
    if (pipeline !== "native") return
    const video = videoRef.current
    if (!video) return
    const read = () => {
      const list = nativeAudioTracks(video)
      const next = list ? selectableAudioTracks(readNativeTracks(list)) : []
      setAudioTracks((prev) => (sameTracks(prev, next) ? prev : next))
    }
    read()
    const list = nativeAudioTracks(video)
    video.addEventListener("loadedmetadata", read)
    list?.addEventListener("addtrack", read)
    list?.addEventListener("change", read)
    return () => {
      video.removeEventListener("loadedmetadata", read)
      list?.removeEventListener("addtrack", read)
      list?.removeEventListener("change", read)
      setAudioTracks([])
    }
  }, [pipeline, src, attachKey, videoRef])

  /**
   * Make the film speak the chosen language, on whichever player is driving.
   *
   * Declarative rather than a command: the caller says what it wants and this
   * keeps it true, so a language chosen before the film opened is applied the
   * moment the list arrives, and a fallback to the browser's own player
   * re-applies it rather than silently reverting — which is the bug the picker
   * exists to end, and would be a poor way to reintroduce it.
   */
  const activeTrack = useMemo(
    // Derived, not stored: what is sounding is a function of what the film
    // offers and what was asked for, and holding a copy in state would let the
    // two drift the moment either changed.
    () => pickAudioTrack(audioTracks, audioLanguage),
    [audioTracks, audioLanguage],
  )
  const activeAudioLang = activeTrack?.lang ?? null

  useEffect(() => {
    const wanted = activeTrack
    if (!wanted) return
    if (pipeline === "hls") {
      const hls = hlsRef.current
      if (!hls) return
      const id = Number(wanted.id)
      if (Number.isFinite(id) && hls.audioTrack !== id) hls.audioTrack = id
      return
    }
    const list = nativeAudioTracks(videoRef.current)
    if (!list) return
    for (let i = 0; i < list.length; i += 1) {
      const track = list[i]
      if (!track) continue
      const on = (track.id || String(i)) === String(wanted.id)
      if (track.enabled !== on) track.enabled = on
    }
  }, [activeTrack, pipeline, videoRef])

  const restartLoad = useCallback(() => {
    try {
      hlsRef.current?.startLoad()
    } catch {
      /* a player mid-teardown has nothing to restart */
    }
  }, [])

  const recoverMedia = useCallback(() => {
    try {
      hlsRef.current?.recoverMediaError()
    } catch {
      /* likewise */
    }
  }, [])

  const fallbackToNative = useCallback(() => {
    if (src) setAbandonedFor(src)
  }, [src])

  const snapshot = useCallback((): HlsSnapshot => {
    const hls = hlsRef.current
    return {
      pipeline,
      currentLevel: hls ? hls.currentLevel : null,
      autoLevelCapping: capRef.current,
      levels: (hls?.levels ?? []).map((l) => ({
        height: l.height ?? null,
        codec: l.videoCodec ?? null,
        bitrate: l.bitrate ?? null,
      })),
      fatalRecoveries: fatalRef.current,
      audioLang: activeAudioLang,
      audioTrackCount: audioTracks.length,
    }
  }, [pipeline, activeAudioLang, audioTracks.length])

  return {
    pipeline,
    restartLoad,
    recoverMedia,
    fallbackToNative,
    audioTracks,
    activeAudioLang,
    snapshot,
  }
}
