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

import { useCallback, useEffect, useRef, useState } from "react"

import type Hls from "hls.js"
import { capIndexForHeight, isHlsSource, MAX_LEVEL_HEIGHT } from "@/lib/video/hls-levels"

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

export interface HlsSnapshot {
  pipeline: VideoPipeline
  /** Null until the manifest has been parsed. */
  currentLevel: number | null
  autoLevelCapping: number | null
  levels: { height: number | null; codec: string | null; bitrate: number | null }[]
  fatalRecoveries: number
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
  snapshot: () => HlsSnapshot
}

/**
 * Attach a streaming player to an element, for as long as the source needs one.
 */
export function useHlsVideo(
  videoRef: React.RefObject<HTMLVideoElement | null>,
  src: string | null | undefined,
  { maxHeight = MAX_LEVEL_HEIGHT, attachKey = 0, enabled = true, loader = importHls }: UseHlsVideoOptions = {},
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
    }
  }, [pipeline])

  return { pipeline, restartLoad, recoverMedia, fallbackToNative, snapshot }
}
