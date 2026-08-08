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
import { Film } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SegmentTabs } from "@/components/ui/tabs"
import type { CellData } from "@/hooks/useCells"
import { hasAnyPlayableAudio, queueClockIsFileTime, useQueueForFile } from "@/lib/audio/play-queue"
import { effectiveSourceText } from "@/lib/cell-text"
import { resolveTextDirection, type DirectionMode, type TextDirection } from "@/lib/text-direction"
import { videoSyncAction } from "./video-sync"

export type SubtitleMode = "target" | "source" | "both" | "off"

const SUBTITLE_MODES: readonly SubtitleMode[] = ["target", "source", "both", "off"]
const SUBTITLE_MODE_KEY = "codex:video-subtitle-mode"

/** Read the persisted caption preference. Deliberately global rather than
 *  per-project: it expresses how someone likes to watch, not anything about the
 *  material. An unrecognised stored value falls back rather than rendering. */
export function readSubtitleMode(): SubtitleMode {
  if (typeof window === "undefined") return "target"
  try {
    const raw = window.localStorage.getItem(SUBTITLE_MODE_KEY)
    return SUBTITLE_MODES.includes(raw as SubtitleMode) ? (raw as SubtitleMode) : "target"
  } catch {
    return "target"
  }
}

function writeSubtitleMode(mode: SubtitleMode): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(SUBTITLE_MODE_KEY, mode)
  } catch {
    /* ignore persistence failures */
  }
}

export interface MediaVideoPaneProps {
  src: string
  cells: CellData[]
  /** A nonce-keyed seek from the timeline. Applied unconditionally, because the
   *  queue drops seeks in several ordinary cases (no session, scrubbing into
   *  the trailing pad, a gap no section owns) and the picture must still move. */
  seekSec?: { sec: number; nonce: number } | null
  /** Only called in the no-audio arrangement, where the video owns the clock. */
  onVideoTime?: (sec: number) => void
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
  onVideoTime,
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
  const [failed, setFailed] = useState(false)
  const [needsGesture, setNeedsGesture] = useState(false)
  /** Bumped by loadedmetadata/durationchange: the media load algorithm resets
   *  playbackRate when the source changes, so rate has to be re-applied. */
  const [mediaEpoch, setMediaEpoch] = useState(0)

  const slaved = useMemo(() => hasAnyPlayableAudio(cells), [cells])

  const setMode = useCallback((next: SubtitleMode) => {
    setModeState(next)
    writeSubtitleMode(next)
  }, [])

  const soundingCell = useMemo(
    () => (queue.cellId != null ? cells.find((c) => c.id === queue.cellId) : undefined),
    [cells, queue.cellId],
  )
  const clockIsFileTime = queueClockIsFileTime(soundingCell)

  const prevTickRef = useRef<{ sec: number; at: number } | null>(null)
  const lastSeekAtRef = useRef<number | null>(null)
  const playFailuresRef = useRef(0)

  const requestPlay = useCallback((video: HTMLVideoElement) => {
    const attempt = video.play()
    if (!attempt || typeof attempt.catch !== "function") return
    attempt.catch(() => {
      // Muted + playsInline is normally allowed to autoplay, but Safari's
      // "Never Auto-Play" and iOS Low Power Mode refuse it anyway. Retry once
      // on the next tick, then stop asking and offer a click instead.
      playFailuresRef.current += 1
      if (playFailuresRef.current >= 2) {
        setNeedsGesture(true)
        return
      }
      window.setTimeout(() => {
        const retry = videoRef.current?.play()
        if (retry && typeof retry.catch === "function") retry.catch(() => setNeedsGesture(true))
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

    if (queue.playing) requestPlay(video)
    else video.pause()
  }, [slaved, failed, queue.kind, queue.playing, clockIsFileTime, tickSec, rate, mediaEpoch, requestPlay])

  // Playback speed. Set both, because `defaultPlaybackRate` is what survives a
  // load, and re-apply whenever the element reloads.
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
    if (!video || !slaved) return
    try {
      video.currentTime = Math.max(0, seekTarget)
      lastSeekAtRef.current = Date.now()
      prevTickRef.current = null
    } catch {
      /* not seekable yet */
    }
  }, [seekNonce, seekTarget, slaved])

  // A new source is a fresh element as far as we're concerned.
  useEffect(() => {
    setFailed(false)
    setNeedsGesture(false)
    playFailuresRef.current = 0
    prevTickRef.current = null
    lastSeekAtRef.current = null
  }, [src])

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

  if (failed) {
    return (
      <div
        data-testid="tl-video-pane"
        data-video-state="error"
        className="flex h-full min-h-0 flex-col gap-2 overflow-hidden border-r border-border p-2"
      >
        <div className="flex min-h-0 flex-1 flex-col items-start justify-center gap-2 rounded-md border border-dashed border-border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
            <Film className="h-3.5 w-3.5 shrink-0" />
            This video could not be loaded
          </div>
          <p className="break-all text-[11px] leading-snug text-muted-foreground">{src}</p>
          {onChangeVideo && (
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onChangeVideo}>
              Change video
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      data-testid="tl-video-pane"
      data-video-state={slaved ? "slaved" : "standalone"}
      className="flex h-full min-h-0 flex-col gap-2 overflow-hidden border-r border-border p-2"
    >
      <div className="relative aspect-video max-h-full w-full shrink-0 overflow-hidden rounded-md bg-black">
        <video
          ref={videoRef}
          key={src}
          src={src}
          data-testid="video-pane-media"
          aria-label="Linked video"
          className="h-full w-full object-contain"
          playsInline
          preload="metadata"
          // Slaved: silent picture, no competing controls. Standalone: this IS
          // the player, so it keeps both.
          muted={slaved}
          controls={!slaved}
          onError={() => setFailed(true)}
          onLoadedMetadata={() => setMediaEpoch((n) => n + 1)}
          onDurationChange={() => setMediaEpoch((n) => n + 1)}
          onTimeUpdate={
            slaved ? undefined : (e) => onVideoTime?.(e.currentTarget.currentTime)
          }
        />
        {hasCaption && (
          // aria-hidden on purpose: this repeats the row the table has already
          // scrolled to and marked as sounding. Announcing it again would read
          // every line twice.
          <div
            aria-hidden="true"
            data-testid="video-pane-caption"
            className="pointer-events-none absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-1 px-2 text-center"
            style={{ maxWidth: "92%" }}
          >
            {captionTarget && (
              <span
                data-testid="video-pane-caption-target"
                dir={resolveTextDirection(targetDirectionMode, captionTarget, targetTextDirection)}
                className="inline-block whitespace-pre-wrap rounded px-2 py-1 text-xs font-medium leading-tight text-white"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.75)",
                  textShadow: "1px 1px 2px rgba(0, 0, 0, 0.9)",
                }}
              >
                {captionTarget}
              </span>
            )}
            {captionSource && (
              <span
                data-testid="video-pane-caption-source"
                dir={resolveTextDirection(sourceDirectionMode, captionSource, sourceTextDirection)}
                className="inline-block whitespace-pre-wrap rounded px-2 py-1 text-[11px] leading-tight text-white/80"
                style={{
                  backgroundColor: "rgba(0, 0, 0, 0.65)",
                  textShadow: "1px 1px 2px rgba(0, 0, 0, 0.9)",
                }}
              >
                {captionSource}
              </span>
            )}
          </div>
        )}
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
      <div className="flex shrink-0 items-center justify-between gap-2">
        <SegmentTabs<SubtitleMode>
          value={mode}
          onValueChange={setMode}
          aria-label="Subtitle text"
          options={[
            { label: "Target", value: "target" },
            { label: "Source", value: "source" },
            { label: "Both", value: "both" },
            { label: "Off", value: "off" },
          ]}
          listClassName="h-7 [&_button]:h-6 [&_button]:px-2 [&_button]:text-[11px]"
        />
      </div>
    </div>
  )
}
