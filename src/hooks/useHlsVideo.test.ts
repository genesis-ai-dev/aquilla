// The streaming player, driven against a stand-in for the library. (AQU-646)
//
// happy-dom has no Media Source Extensions, so `streamingPlayerAvailable()` is
// false here unless a test says otherwise — which is exactly what we want: the
// pane's own suite goes on exercising the native path untouched, and the
// streaming path is opted into where it is the subject.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { createRef } from "react"

import { useHlsVideo, streamingPlayerAvailable, type HlsModule } from "./useHlsVideo"

const HLS_SRC = "https://cdn.thechosen.media/videos/cmkaom6vg0000bca7bhwyicjj/master.m3u8"

/** Episode 101's renditions, ascending by bitrate as a player presents them. */
const LEVELS = [
  { height: 480, bitrate: 1934005, videoCodec: "hvc1.1.6.L90.90" },
  { height: 480, bitrate: 4523175, videoCodec: "avc1.4D401E" },
  { height: 720, bitrate: 7700959, videoCodec: "hvc1.1.6.L93.90" },
  { height: 1080, bitrate: 13609375, videoCodec: "hvc1.1.6.L120.90" },
  { height: 720, bitrate: 15965367, videoCodec: "avc1.4D401F" },
  { height: 2160, bitrate: 92507195, videoCodec: "avc1.4D4033" },
]

/**
 * Episode 101's audio renditions, in the manifest's own order: sixty-five dubs,
 * alphabetical, Amharic first, and only English flagged — with AUTOSELECT, not
 * DEFAULT. Trimmed to the entries the rules turn on. The description track is
 * included deliberately; it is the one that must never be offered.
 */
const AUDIO_TRACKS = [
  { id: 0, name: "Amharic", lang: "am-ET" },
  { id: 16, name: "English", lang: "en", autoselect: true },
  { id: 17, name: "English Audio Descriptions", lang: "en_ad" },
  { id: 50, name: "Spanish (Latin America)", lang: "es-419" },
]

type Handler = (event: string, data: unknown) => void

/** A stand-in for the library: records what it was asked to do and lets a test
 *  fire the events the real one would. */
function makeFakeHls(o: { supported?: boolean } = {}) {
  const instances: FakeHls[] = []

  class FakeHls {
    static Events = {
      MANIFEST_PARSED: "hlsManifestParsed",
      ERROR: "hlsError",
      AUDIO_TRACKS_UPDATED: "hlsAudioTracksUpdated",
      AUDIO_TRACK_SWITCHED: "hlsAudioTrackSwitched",
      SUBTITLE_TRACKS_UPDATED: "hlsSubtitleTracksUpdated",
    } as const
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError", OTHER_ERROR: "otherError" } as const
    static isSupported = () => o.supported ?? true

    config: Record<string, unknown>
    levels = LEVELS
    audioTracks = AUDIO_TRACKS
    audioTrack = -1
    /** As the library leaves it after autoselecting a DEFAULT-flagged track. */
    subtitleTrack = 0
    currentLevel = 4
    autoLevelCapping = -1
    subtitleDisplay = true
    attached: HTMLVideoElement | null = null
    loaded: string | null = null
    destroyed = false
    startLoadCalls = 0
    recoverCalls = 0
    private handlers = new Map<string, Handler[]>()

    constructor(config: Record<string, unknown>) {
      this.config = config
      instances.push(this)
    }

    on(event: string, fn: Handler) {
      const list = this.handlers.get(event) ?? []
      list.push(fn)
      this.handlers.set(event, list)
    }

    emit(event: string, data?: unknown) {
      for (const fn of this.handlers.get(event) ?? []) fn(event, data)
    }

    attachMedia(video: HTMLVideoElement) { this.attached = video }
    loadSource(src: string) { this.loaded = src }
    startLoad() { this.startLoadCalls += 1 }
    recoverMediaError() { this.recoverCalls += 1 }
    destroy() { this.destroyed = true }
  }

  const loader = vi.fn(async () => ({ default: FakeHls }) as unknown as HlsModule)
  return { FakeHls, loader, instances }
}

/** A video element and a ref pointing at it, as the pane would hold. */
function elementRef() {
  const video = document.createElement("video")
  document.body.appendChild(video)
  const ref = createRef<HTMLVideoElement>()
  ;(ref as { current: HTMLVideoElement | null }).current = video
  return { video, ref }
}

const originalMediaSource = window.MediaSource

beforeEach(() => {
  // Pretend this browser has MSE with fragmented-MP4 H.264.
  ;(window as unknown as { MediaSource?: unknown }).MediaSource = {
    isTypeSupported: () => true,
  }
})

afterEach(() => {
  ;(window as unknown as { MediaSource?: unknown }).MediaSource = originalMediaSource
  document.body.innerHTML = ""
  vi.restoreAllMocks()
})

describe("choosing a player", () => {
  it("uses the streaming player for a playlist", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    expect(result.current.pipeline).toBe("hls")
    await waitFor(() => expect(instances).toHaveLength(1))
    expect(instances[0]?.loaded).toBe(HLS_SRC)
  })

  it("leaves an ordinary file to the browser, and never loads the library", async () => {
    const { ref } = elementRef()
    const { loader } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, "https://cdn/episode.mp4", { loader }))
    expect(result.current.pipeline).toBe("native")
    expect(loader).not.toHaveBeenCalled()
  })

  it("leaves the playlist to the browser where there are no Media Source Extensions", () => {
    // Safari's own native HLS is the player there; everywhere else this is the
    // error card, which is what shipped before.
    ;(window as unknown as { MediaSource?: unknown }).MediaSource = undefined
    expect(streamingPlayerAvailable()).toBe(false)
    const { ref } = elementRef()
    const { loader } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    expect(result.current.pipeline).toBe("native")
    expect(loader).not.toHaveBeenCalled()
  })
})

describe("how large a picture it is willing to decode", () => {
  it("caps the player below the first rendition taller than the ceiling", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    instances[0]!.emit("hlsManifestParsed")
    // Index 3 is 1080p, so the ceiling is index 2 — everything under it is
    // 720p or smaller.
    expect(instances[0]!.autoLevelCapping).toBe(2)
  })

  it("also asks the player to respect the size it is drawn at", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    expect(instances[0]!.config.capLevelToPlayerSize).toBe(true)
  })

  it("keeps the playlist's own subtitles off the picture", async () => {
    // We draw captions from the file being translated; the CDN's renditions
    // would be a second set of words over the same frame.
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    expect(instances[0]!.subtitleDisplay).toBe(false)
  })

  it("deselects a subtitle track the manifest turned on by itself", async () => {
    // Not rendering is not enough: a selected track still fetches its cue
    // playlists, and the selection is what a DEFAULT flag buys itself.
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    expect(instances[0]!.subtitleTrack).toBe(0)
    instances[0]!.emit("hlsSubtitleTracksUpdated")
    expect(instances[0]!.subtitleTrack).toBe(-1)
  })
})

// ── The film's own captions (Matt's QA, 2026-08-21) ─────────────────────────
//
// A freshly linked film came up with the CDN's captions over ours. The
// streaming player was already told not to render them — the native path
// (Safari's own HLS, and every film the stall ladder hands back) had no such
// switch, and Safari honours a manifest's DEFAULT flag.

describe("silencing the film's own captions", () => {
  /** A stand-in for `video.textTracks`, with the events the clamp listens on. */
  function fakeTextTracks(video: HTMLVideoElement, modes: string[]) {
    const handlers: Record<string, (() => void)[]> = {}
    const tracks = modes.map((mode) => ({ mode }))
    const list = Object.assign(tracks, {
      addEventListener: (type: string, fn: () => void) => {
        ;(handlers[type] ??= []).push(fn)
      },
      removeEventListener: (type: string, fn: () => void) => {
        handlers[type] = (handlers[type] ?? []).filter((f) => f !== fn)
      },
    })
    Object.defineProperty(video, "textTracks", { configurable: true, value: list })
    const emit = (type: string) => {
      for (const fn of handlers[type] ?? []) fn()
    }
    return { tracks, emit }
  }

  it("disables every embedded track on the native path", async () => {
    const { video, ref } = elementRef()
    const { tracks } = fakeTextTracks(video, ["showing", "hidden"])
    const { loader } = makeFakeHls({ supported: false })
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(result.current.pipeline).toBe("native"))
    expect(tracks.map((t) => t.mode)).toEqual(["disabled", "disabled"])
  })

  it("disables a track that arrives late, and one the player turns back on", async () => {
    // Subtitle renditions can land after metadata, and Safari can flip a mode
    // on its own — the clamp is a standing rule, not a one-time write.
    const { video, ref } = elementRef()
    const { tracks, emit } = fakeTextTracks(video, ["disabled"])
    const { loader } = makeFakeHls({ supported: false })
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(result.current.pipeline).toBe("native"))
    tracks.push({ mode: "showing" })
    emit("addtrack")
    expect(tracks[1]!.mode).toBe("disabled")
    tracks[0]!.mode = "showing"
    emit("change")
    expect(tracks[0]!.mode).toBe("disabled")
  })

  it("disables the tracks the streaming player creates too", async () => {
    // Belt and braces on the hls path: the library renders subtitles through
    // native TextTracks, so the same clamp holds there.
    const { video, ref } = elementRef()
    const { tracks } = fakeTextTracks(video, ["hidden"])
    const { loader, instances } = makeFakeHls()
    renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    expect(tracks[0]!.mode).toBe("disabled")
  })
})

describe("giving up on the streaming player", () => {
  it("falls back to the browser when the library will not run here", async () => {
    const { ref } = elementRef()
    const { loader } = makeFakeHls({ supported: false })
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(result.current.pipeline).toBe("native"))
  })

  it("falls back when the library's chunk cannot be fetched at all", async () => {
    const { ref } = elementRef()
    const loader = vi.fn(async () => { throw new Error("offline") })
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(result.current.pipeline).toBe("native"))
  })

  it("uses the library's own remedies before abandoning it", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    const hls = instances[0]!

    hls.emit("hlsError", { fatal: true, type: "networkError" })
    expect(hls.startLoadCalls).toBe(1)
    hls.emit("hlsError", { fatal: true, type: "mediaError" })
    expect(hls.recoverCalls).toBe(1)
    expect(result.current.pipeline).toBe("hls")

    // Past its own recovery, the browser gets a turn.
    hls.emit("hlsError", { fatal: true, type: "mediaError" })
    await waitFor(() => expect(result.current.pipeline).toBe("native"))
  })

  it("ignores the errors it recovers from itself", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    for (let i = 0; i < 10; i += 1) {
      instances[0]!.emit("hlsError", { fatal: false, type: "networkError" })
    }
    expect(result.current.pipeline).toBe("hls")
  })

  it("hands the source to the browser on request", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    result.current.fallbackToNative()
    await waitFor(() => expect(result.current.pipeline).toBe("native"))
    expect(instances[0]!.destroyed).toBe(true)
  })

  it("gives a DIFFERENT film a fresh chance", async () => {
    // Abandonment is keyed to the address, so one bad stream does not condemn
    // the next project the user opens.
    const { ref } = elementRef()
    const { loader } = makeFakeHls()
    const { result, rerender } = renderHook(
      ({ src }: { src: string }) => useHlsVideo(ref, src, { loader }),
      { initialProps: { src: HLS_SRC } },
    )
    result.current.fallbackToNative()
    await waitFor(() => expect(result.current.pipeline).toBe("native"))
    rerender({ src: "https://cdn.thechosen.media/videos/other/master.m3u8" })
    expect(result.current.pipeline).toBe("hls")
  })
})

describe("lifetime", () => {
  it("tears the player down when the film changes", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { rerender } = renderHook(
      ({ src }: { src: string }) => useHlsVideo(ref, src, { loader }),
      { initialProps: { src: HLS_SRC } },
    )
    await waitFor(() => expect(instances).toHaveLength(1))
    rerender({ src: "https://cdn.thechosen.media/videos/other/master.m3u8" })
    await waitFor(() => expect(instances).toHaveLength(2))
    expect(instances[0]!.destroyed).toBe(true)
    expect(instances[1]!.loaded).toBe("https://cdn.thechosen.media/videos/other/master.m3u8")
  })

  it("rebuilds around a replaced element", async () => {
    // The pane remounts the element as a recovery rung; a player still holding
    // the old, detached one would drive nothing.
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { rerender } = renderHook(
      ({ attachKey }: { attachKey: number }) => useHlsVideo(ref, HLS_SRC, { loader, attachKey }),
      { initialProps: { attachKey: 0 } },
    )
    await waitFor(() => expect(instances).toHaveLength(1))
    rerender({ attachKey: 1 })
    await waitFor(() => expect(instances).toHaveLength(2))
    expect(instances[0]!.destroyed).toBe(true)
  })

  it("destroys the player on unmount", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { unmount } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    unmount()
    expect(instances[0]!.destroyed).toBe(true)
  })
})

describe("the snapshot the console seam reads", () => {
  it("reports the pipeline, the ceiling and the renditions on offer", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    instances[0]!.emit("hlsManifestParsed")
    const snap = result.current.snapshot()
    expect(snap.pipeline).toBe("hls")
    expect(snap.autoLevelCapping).toBe(2)
    expect(snap.levels).toHaveLength(LEVELS.length)
    expect(snap.levels[5]).toEqual({ height: 2160, codec: "avc1.4D4033", bitrate: 92507195 })
  })
})

// ── What the film speaks (Sam, 2026-08-18) ────────────────────────────────
//
// "It seems though that the video's language randomly changed." It did, and
// this is why: the masters flag no default track, so a player left to choose
// takes the top of an alphabetical list.

describe("the language the film speaks", () => {
  it("asks for English before it fetches anything", () => {
    // Correcting it after the manifest lands works, but you hear the wrong
    // language first — so the preference goes in at construction.
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    return waitFor(() => {
      expect(instances).toHaveLength(1)
      expect(instances[0]!.config.audioPreference).toEqual({ lang: "en" })
    })
  })

  it("asks for the film's chosen language instead, when there is one", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    renderHook(() => useHlsVideo(ref, HLS_SRC, { loader, audioLanguage: "es-419" }))
    await waitFor(() => expect(instances).toHaveLength(1))
    expect(instances[0]!.config.audioPreference).toEqual({ lang: "es-419" })
  })

  it("offers every language except the narration track for blind viewers", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    instances[0]!.emit("hlsAudioTracksUpdated")
    await waitFor(() => expect(result.current.audioTracks.length).toBeGreaterThan(0))
    const names = result.current.audioTracks.map((t) => t.name)
    expect(names).toEqual(["Amharic", "English", "Spanish (Latin America)"])
  })

  it("switches the player to English rather than the top of the list", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(instances).toHaveLength(1))
    instances[0]!.emit("hlsAudioTracksUpdated")
    await waitFor(() => expect(instances[0]!.audioTrack).toBe(16))
  })

  it("follows a change of language without rebuilding the player", async () => {
    // Choosing a language mid-film must not tear the picture down and start it
    // again from the beginning.
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { rerender } = renderHook(
      ({ lang }: { lang: string | null }) => useHlsVideo(ref, HLS_SRC, { loader, audioLanguage: lang }),
      { initialProps: { lang: null as string | null } },
    )
    await waitFor(() => expect(instances).toHaveLength(1))
    instances[0]!.emit("hlsAudioTracksUpdated")
    await waitFor(() => expect(instances[0]!.audioTrack).toBe(16))
    rerender({ lang: "es-419" })
    await waitFor(() => expect(instances[0]!.audioTrack).toBe(50))
    expect(instances).toHaveLength(1)
    expect(instances[0]!.destroyed).toBe(false)
  })

  it("reports what is sounding", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader, audioLanguage: "es-419" }))
    await waitFor(() => expect(instances).toHaveLength(1))
    instances[0]!.emit("hlsAudioTracksUpdated")
    await waitFor(() => expect(result.current.activeAudioLang).toBe("es-419"))
    expect(result.current.snapshot().audioLang).toBe("es-419")
  })

  it("falls back to English for a film that lacks the chosen language", async () => {
    const { ref } = elementRef()
    const { loader, instances } = makeFakeHls()
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader, audioLanguage: "cy-GB" }))
    await waitFor(() => expect(instances).toHaveLength(1))
    instances[0]!.emit("hlsAudioTracksUpdated")
    await waitFor(() => expect(result.current.activeAudioLang).toBe("en"))
  })

  it("keeps the choice when the browser takes the film back", async () => {
    // The stall ladder's last rung hands the address to the browser's own
    // player. Reverting the language there would be the original bug again.
    const { video, ref } = elementRef()
    const tracks = [
      { id: "1", label: "Amharic", language: "am-ET", enabled: true },
      { id: "2", label: "English", language: "en", enabled: false },
    ]
    Object.defineProperty(video, "audioTracks", {
      configurable: true,
      value: Object.assign(tracks, {
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    })
    const { loader } = makeFakeHls({ supported: false })
    const { result } = renderHook(() => useHlsVideo(ref, HLS_SRC, { loader }))
    await waitFor(() => expect(result.current.pipeline).toBe("native"))
    await waitFor(() => expect(tracks[1]!.enabled).toBe(true))
    expect(tracks[0]!.enabled).toBe(false)
  })
})
