// The linked video, docked beside the text table in the media lens. (AQU-646)
//
// Until now the video was a black band above the timeline with native browser
// controls: it played picture without sound, nothing in the transport ever
// started or stopped it, its own soundtrack talked over the dub, and both it and
// the play queue wrote the timeline clock at ~4Hz with last-writer-wins. This is
// the other arrangement — the queue is the master clock and the video is a
// muted, controls-free picture surface slaved to it. Position logic lives in
// ./video-sync as a pure function; see the long note there for why it never
// reads the element.
//
// ONE exception, and it is not a special case so much as the original job: a
// subtitle file can have a linked video and no audio attachments at all, and
// then the queue can never start. There the video IS the player — it keeps its
// native controls, keeps its sound, and reports its own time back up to drive
// the playhead. The clock therefore has two possible drivers; which one is in
// charge is decided once, by whether this file has any playable audio.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import type { CellData } from "@/hooks/useCells"
import { queueClockIsFileTime, useQueueAudibility, useQueueForFile } from "@/lib/audio/play-queue"
import { effectiveSourceText } from "@/lib/cell-text"
import type { DirectionMode, TextDirection } from "@/lib/text-direction"
import { cellIdAtSec } from "@/lib/timeline/source-regions"
import { setVideoSoundingCellId, useVideoSoundingCellId } from "@/lib/timeline/video-clock"
import { videoSyncAction } from "./video-sync"
import { DEFAULT_VIDEO_ASPECT, fitPictureRect, intrinsicAspect } from "./video-frame"
import { VideoPaneHeader } from "./VideoPaneHeader"
import { VideoPaneErrorCard } from "./VideoPaneErrorCard"
import { VideoPaneCaption } from "./VideoPaneCaption"
import { VideoPaneControls } from "./VideoPaneControls"
import {
  readCaptionPlacement,
  readSubtitleMode,
  writeCaptionPlacement,
  writeSubtitleMode,
  type CaptionPlacement,
  type SubtitleMode,
} from "./video-pane-prefs"

// Re-exported so existing importers (and the pane's own tests) keep one path
// into the caption preferences.
export {
  readCaptionPlacement,
  readSubtitleMode,
  type CaptionPlacement,
  type SubtitleMode,
} from "./video-pane-prefs"

export interface MediaVideoPaneProps {
  src: string
  cells: CellData[]
  /** A nonce-keyed seek from the timeline. Applied unconditionally, because the
   *  queue drops seeks in several ordinary cases (no session, scrubbing into
   *  the trailing pad, a gap no section owns) and the picture must still move. */
  seekSec?: { sec: number; nonce: number } | null
  /** A nonce-keyed play/pause from the timeline (Space). Deliberately a TOGGLE
   *  rather than a desired state: the picture keeps its native controls in the
   *  standalone arrangement, so anything stateful would drift out of step with
   *  them. Toggling against the element's own `paused` cannot. */
  togglePlay?: { nonce: number } | null
  /** True while the recorder is open. The picture stops and stays stopped —
   *  `pauseAllPlayback()` only reaches the queue's own elements, so without
   *  this the mic records the film's soundtrack into the take (and the mic is
   *  opened with echo cancellation off). Deliberately not auto-resumed: after
   *  a take you want to hear the take, not the film starting up again. */
  suspended?: boolean
  /** Only called in the standalone arrangement, where the video owns the clock.
   *  null clears it — the store outlives this component, so a stale position
   *  would go on driving the playhead. */
  onVideoTime?: (sec: number | null) => void
  /** Standalone only: the element's own play/pause state. `timeupdate` fires
   *  ~4Hz, so the playhead needs this to know it may interpolate between
   *  ticks — otherwise it steps. Cleared with the position. */
  onVideoPlaying?: (playing: boolean) => void
  /** How long the linked video is. Reported in BOTH arrangements — the track's
   *  extent is a property of the footage, not of who is driving the transport.
   *  Carries its own src so the store can key by address; null means the
   *  element does not know (yet, or ever). */
  onVideoDuration?: (src: string, sec: number | null) => void
  /** Opens the link-video dialog — offered when the source will not load. */
  onChangeVideo?: () => void
  sourceDirectionMode?: DirectionMode
  targetDirectionMode?: DirectionMode
  sourceTextDirection?: TextDirection
  targetTextDirection?: TextDirection
}

export function MediaVideoPane({
  src,
  cells,
  seekSec,
  togglePlay,
  suspended,
  onVideoTime,
  onVideoPlaying,
  onVideoDuration,
  onChangeVideo,
  sourceDirectionMode = "auto",
  targetDirectionMode = "auto",
  sourceTextDirection = "ltr",
  targetTextDirection = "ltr",
}: MediaVideoPaneProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const cellIdSet = useMemo(() => new Set(cells.map((c) => c.id)), [cells])
  const queue = useQueueForFile(cellIdSet)
  const [mode, setModeState] = useState<SubtitleMode>(() => readSubtitleMode())
  const [placement, setPlacementState] = useState<CaptionPlacement>(() => readCaptionPlacement())
  const [failed, setFailed] = useState(false)
  const [needsGesture, setNeedsGesture] = useState(false)
  /** Bumped by loadedmetadata/durationchange: the media load algorithm resets
   *  playbackRate when the source changes, so rate has to be re-applied. */
  const [mediaEpoch, setMediaEpoch] = useState(0)
  /** Bumped by "Try again" so the element is rebuilt against the same URL. */
  const [loadAttempt, setLoadAttempt] = useState(0)
  /** The caption toggle rides faded on the picture; this shows it briefly when
   *  playback starts so the control is discoverable without hovering. */
  const [modeRevealed, setModeRevealed] = useState(false)
  useEffect(() => {
    if (!queue.playing) {
      setModeRevealed(false)
      return
    }
    setModeRevealed(true)
    const t = window.setTimeout(() => setModeRevealed(false), 2500)
    return () => window.clearTimeout(t)
  }, [queue.playing])

  /**
   * Slaving is only possible when this file's queue can produce FILE-timeline
   * seconds, which needs a media cell backed by the shared source clip. Asking
   * "does it have any playable audio?" instead looks equivalent and is not: a
   * subtitle file whose cells are text, carrying one recorded take, answers yes
   * — and then every tick fails the file-time test and pauses the picture, so
   * the user gets a frozen first frame, no controls, and no way to start it.
   */
  const slaved = useMemo(() => cells.some((c) => queueClockIsFileTime(c)), [cells])
  /** The timeline's Source-track speaker button. Only bites in the standalone
   *  arrangement — a slaved picture is already silent. */
  const sourceAudible = useQueueAudibility().source

  const setMode = useCallback((next: SubtitleMode) => {
    setModeState(next)
    writeSubtitleMode(next)
  }, [])

  const setPlacement = useCallback((next: CaptionPlacement) => {
    setPlacementState(next)
    writeCaptionPlacement(next)
  }, [])

  // ── The picture rect. The black field fills the pane; the picture is centred
  // inside it at the video's own proportions, and the caption anchors to the
  // PICTURE rather than the field so it cannot drift into a bar on resize.
  const fieldRef = useRef<HTMLDivElement>(null)
  const [fieldSize, setFieldSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  const [aspect, setAspect] = useState<number>(DEFAULT_VIDEO_ASPECT)
  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    const measure = () => setFieldSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === "undefined") return // happy-dom
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [failed])
  const picture = fitPictureRect(fieldSize.w, fieldSize.h, aspect)

  /**
   * Which line the picture is on, when the picture is the transport. The queue
   * answers this everywhere it runs and cannot run at all here, so there is
   * nothing to ask — the element's own clock is the only source. Held as the
   * cell ID rather than the second so this re-renders on a line CHANGE, not on
   * every one of `timeupdate`'s ~4 ticks a second.
   */
  // Round 5: this used to be local state, which is exactly why the dialogue
  // table never followed the film — the caption could see which line the
  // picture was on and nothing else could. It now lives in the video clock
  // store beside the position it is derived from, so every surface reads one
  // answer.
  const standaloneCellId = useVideoSoundingCellId()
  useEffect(() => {
    if (slaved) setVideoSoundingCellId(null)
  }, [slaved])
  const soundingCell = useMemo(() => {
    // The queue wins whenever it is running, unconditionally — today's exact
    // rule, so nothing about the dubbing arrangement changes.
    if (queue.cellId != null) return cells.find((c) => c.id === queue.cellId)
    if (slaved || standaloneCellId == null) return undefined
    return cells.find((c) => c.id === standaloneCellId)
  }, [cells, queue.cellId, slaved, standaloneCellId])
  const clockIsFileTime = queueClockIsFileTime(soundingCell)

  const prevTickRef = useRef<{ sec: number; at: number } | null>(null)
  const lastSeekAtRef = useRef<number | null>(null)
  const playFailuresRef = useRef(0)
  /** Whether the transport still wants the picture running, read by the retry
   *  below so a rejection that arrives after a pause cannot restart it. */
  const wantPlayRef = useRef(false)
  const retryTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current)
    },
    [],
  )

  const requestPlay = useCallback((video: HTMLVideoElement) => {
    const attempt = video.play()
    if (!attempt || typeof attempt.catch !== "function") return
    attempt.catch((err: unknown) => {
      // A pause taken while the element was still opening or seeking rejects
      // the in-flight play with AbortError. That is not a refusal to autoplay —
      // it is us, and retrying it would start the picture with the sound
      // stopped and eventually raise a bogus click-to-play prompt.
      if (err instanceof Error && err.name === "AbortError") return
      if (!wantPlayRef.current || videoRef.current !== video) return
      // Muted + playsInline is normally allowed to autoplay, but Safari's
      // "Never Auto-Play" and iOS Low Power Mode refuse it anyway. Retry once
      // on the next tick, then stop asking and offer a click instead.
      playFailuresRef.current += 1
      if (playFailuresRef.current >= 2) {
        setNeedsGesture(true)
        return
      }
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null
        if (!wantPlayRef.current || videoRef.current !== video) return
        const retry = video.play()
        if (retry && typeof retry.catch === "function") {
          retry.catch((e: unknown) => {
            if (e instanceof Error && e.name === "AbortError") return
            setNeedsGesture(true)
          })
        }
      }, 0)
    })
  }, [])

  // ── The transport. One effect owns play/pause AND position, so the two can
  // never disagree about what the queue is doing.
  const tickSec = queue.progress.currentTime
  const rate = queue.progress.rate
  useEffect(() => {
    const video = videoRef.current
    if (!video || !slaved || failed) return
    const now = Date.now()
    const prev = prevTickRef.current
    const action = videoSyncAction({
      kind: queue.kind,
      clockIsFileTime,
      tickSec,
      videoSec: video.currentTime,
      prevTickSec: prev?.sec ?? null,
      prevTickAt: prev?.at ?? null,
      now,
      rate,
      duration: video.duration,
      lastSeekAt: lastSeekAtRef.current,
    })

    if (action.kind === "pause") {
      // Terminal or unusable: forget the anchor so the next real playback
      // re-anchors instead of predicting from a stale one.
      prevTickRef.current = null
      wantPlayRef.current = false
      video.pause()
      return
    }

    if (prev?.sec !== tickSec) prevTickRef.current = { sec: tickSec, at: now }

    if (action.kind === "seek") {
      try {
        video.currentTime = action.sec
        lastSeekAtRef.current = now
      } catch {
        /* not seekable yet — the next tick re-issues it */
      }
    }

    wantPlayRef.current = queue.playing
    if (queue.playing) requestPlay(video)
    else video.pause()
  }, [slaved, failed, queue.kind, queue.playing, clockIsFileTime, tickSec, rate, mediaEpoch, requestPlay])

  // Playback speed. Set both, because `defaultPlaybackRate` is what survives a
  // load, and re-apply whenever the element reloads. This is the STARTING
  // point; the transport effect above then trims it towards what the sound is
  // measurably doing. Changing the nominal rate discards the old measurement.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !slaved) return
    video.defaultPlaybackRate = rate
    video.playbackRate = rate
  }, [rate, slaved, mediaEpoch])

  // An explicit seek from the timeline. Applied whatever the queue thinks.
  const seekNonce = seekSec?.nonce
  const seekTarget = seekSec?.sec
  useEffect(() => {
    if (seekNonce == null || seekTarget == null) return
    const video = videoRef.current
    // Deliberately NOT gated on `slaved`: in the standalone arrangement this is
    // the only thing that moves the picture, and a ruler or chip click that
    // moved the playhead but not the frame would leave the two contradicting
    // each other on screen.
    if (!video) return
    try {
      video.currentTime = Math.max(0, seekTarget)
      lastSeekAtRef.current = Date.now()
      prevTickRef.current = null
    } catch {
      /* not seekable yet */
    }
  }, [seekNonce, seekTarget])

  // Space from the timeline. Only in the STANDALONE arrangement: when the queue
  // is the transport it owns play/pause, and two writers would fight. Toggling
  // against the element's own `paused` means the app and the picture's native
  // controls can never disagree about what "pause" meant.
  const toggleNonce = togglePlay?.nonce
  useEffect(() => {
    if (toggleNonce == null || slaved) return
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      wantPlayRef.current = true
      requestPlay(video)
    } else {
      wantPlayRef.current = false
      video.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the NONCE is the
    // command; re-running on `slaved`/`requestPlay` would replay a stale press.
  }, [toggleNonce])

  // The recorder is open: stop the picture, and keep stopping it. Re-asserted
  // on every tick of `suspended` rather than fired once, because the native
  // controls are right there and a stray click on play mid-take would put the
  // soundtrack straight into the recording.
  useEffect(() => {
    if (!suspended) return
    const video = videoRef.current
    if (!video) return
    wantPlayRef.current = false
    video.pause()
    const t = window.setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) videoRef.current.pause()
    }, 250)
    return () => window.clearInterval(t)
  }, [suspended])

  // A new source is a fresh element as far as we're concerned.
  useEffect(() => {
    setAspect(DEFAULT_VIDEO_ASPECT)
    setFailed(false)
    setNeedsGesture(false)
    playFailuresRef.current = 0
    prevTickRef.current = null
    lastSeekAtRef.current = null
  }, [src])

  // The fallback clock is a module store, so a position left in it would keep
  // re-writing the playhead long after this pane is gone — on another file, or
  // on this one once a take arrives and the queue takes over. Clear it whenever
  // we are not the one driving.
  useEffect(() => {
    if (slaved) {
      onVideoTime?.(null)
      onVideoPlaying?.(false)
    }
    return () => {
      onVideoTime?.(null)
      onVideoPlaying?.(false)
    }
  }, [slaved, onVideoTime, onVideoPlaying])

  const targetText = soundingCell?.translated?.trim() ?? ""
  // `effectiveSourceText` is blank for an untranscribed media segment, which is
  // what we want burned over the picture: that cell's stored source value is the
  // import FILENAME, and a caption reading "episode.mp3" is worse than none.
  const sourceText = soundingCell ? effectiveSourceText(soundingCell).trim() : ""
  const showTarget = mode === "target" || mode === "both"
  const showSource = mode === "source" || mode === "both"
  const captionTarget = showTarget ? targetText : ""
  const captionSource = showSource ? sourceText : ""
  const hasCaption = Boolean(captionTarget || captionSource)
  // The caption renders in one of two DOM parents (on the picture, or in the
  // black field below it), so the props travel together rather than being
  // written out twice.
  const captionProps = {
    target: captionTarget,
    source: captionSource,
    sourceDirectionMode,
    targetDirectionMode,
    sourceTextDirection,
    targetTextDirection,
  }

  if (failed) {
    return (
      <VideoPaneErrorCard
        src={src}
        onRetry={() => { setFailed(false); setLoadAttempt((n) => n + 1) }}
        onChangeVideo={onChangeVideo}
      />
    )
  }

  return (
    <div
      data-testid="tl-video-pane"
      data-video-state={slaved ? "slaved" : "standalone"}
      className="flex h-full min-h-0 flex-col overflow-hidden border-r border-border"
    >
      <VideoPaneHeader src={src} />
      {/* The black field fills everything under the header, and the picture is
          centred in it at the video's own proportions — leftover space becomes
          cinema bars instead of blank page. */}
      <div
        ref={fieldRef}
        data-testid="video-pane-field"
        className="group relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black"
      >
      {/* The picture, sized in real pixels so the caption has an edge to anchor
          to. Falls back to a plain 16:9 box before the field has been measured
          (and in any environment without layout, e.g. the test DOM). */}
      <div
        data-testid="video-pane-picture"
        className={cn("relative", picture ? "" : "aspect-video w-full")}
        style={picture ? { width: `${picture.width}px`, height: `${picture.height}px` } : undefined}
      >
        <video
          ref={videoRef}
          key={`${src}#${loadAttempt}`}
          src={src}
          data-testid="video-pane-media"
          aria-label="Linked video"
          className="h-full w-full object-contain"
          playsInline
          preload="metadata"
          // Slaved: silent picture, no competing controls. Standalone: this IS
          // the player, so it keeps both — and it is also the SOURCE AUDIO, so
          // the timeline's Source-track speaker button mutes it. That button
          // publishes through setQueueAudibility, which reaches the queue's own
          // elements; there are none in this arrangement, so the pane honours
          // the same flag directly. (AQU-646, 2026-08-11)
          muted={slaved || !sourceAudible}
          controls={!slaved}
          onError={() => {
            setFailed(true)
            // Whatever length we had is no longer trustworthy — a track sized
            // to a video that will not load is worse than one sized to the cues.
            onVideoDuration?.(src, null)
          }}
          onLoadedMetadata={(e) => {
            setMediaEpoch((n) => n + 1)
            // The element now knows its real shape — letterbox against THAT
            // rather than the assumed 16:9.
            const real = intrinsicAspect(e.currentTarget.videoWidth, e.currentTarget.videoHeight)
            if (real != null) setAspect(real)
            onVideoDuration?.(src, e.currentTarget.duration)
          }}
          onDurationChange={(e) => {
            setMediaEpoch((n) => n + 1)
            onVideoDuration?.(src, e.currentTarget.duration)
          }}
          onTimeUpdate={
            slaved
              ? undefined
              : (e) => {
                  const sec = e.currentTarget.currentTime
                  onVideoTime?.(sec)
                  // Setting the same id is a no-op re-render in React, so the
                  // caption only repaints when the line actually changes.
                  setVideoSoundingCellId(cellIdAtSec(cells, sec))
                }
          }
          // Standalone only: the queue is idle here, so it cannot tell the
          // playhead whether anything is running. `ended` is included because
          // it does not imply `pause` on every engine.
          onPlay={slaved ? undefined : () => onVideoPlaying?.(true)}
          onPause={slaved ? undefined : () => onVideoPlaying?.(false)}
          onEnded={slaved ? undefined : () => onVideoPlaying?.(false)}
        />
        {/* Anchored to the PICTURE, not the black field: the exported video
             has no bars, so this is where the line really lives — and it can
             never drift into a bar as the pane is resized. */}
        {hasCaption && placement === "picture" && <VideoPaneCaption {...captionProps} />}
        {needsGesture && (
          <button
            type="button"
            data-testid="video-pane-play-gesture"
            onClick={() => {
              setNeedsGesture(false)
              playFailuresRef.current = 0
              const video = videoRef.current
              if (video) requestPlay(video)
            }}
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 text-xs font-medium text-white"
          >
            Click to start the picture
          </button>
        )}
      </div>
      {/* The other choice: keep the image itself completely clear and put
           the line in the black below it. Anchored to the FIELD, so it
           lands in the bar when there is one. */}
      {hasCaption && placement === "bar" && <VideoPaneCaption {...captionProps} />}
      <VideoPaneControls
        mode={mode}
        placement={placement}
        revealed={modeRevealed}
        onModeChange={setMode}
        onPlacementChange={setPlacement}
      />
      </div>
    </div>
  )
}
