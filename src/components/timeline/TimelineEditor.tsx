// The timeline editor: composes the lanes, ruler, playhead, video preview, and
// detail pane into the Media-lens surface. Owns zoom (persisted per file),
// horizontal scroll/windowing, selection, and the master clock. Hand-rolled;
// the only "media" dependency is a native <video> element for the linked-URL
// preview (the remote host serves Range — no streaming work needed here).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { Film, LocateFixed, Magnet, Minus, Plus, Volume2, VolumeX } from "lucide-react"
import { cn } from "@/lib/utils"
import { deriveLanes } from "@/lib/timeline/lanes"
import { timelineBounds } from "@/lib/timeline/derive"
import { computeFollowScroll } from "@/lib/timeline/follow"
import { secToPx, pxToSec, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from "@/lib/timeline/scale"
// Read-only queue subscriptions only — playback COMMANDS stay in the
// workspace (onSeekToTime), keeping this component testable with a spy prop.
// Round 5 exception: the per-track speaker buttons drive setQueueAudibility
// directly — muting is a pure element-level concern with no workspace state.
import { useQueueProgress, useQueueState, setQueueAudibility, type TrackAudibility } from "@/lib/audio/play-queue"
import { isInEditableContext, pushAudioShortcutOverride } from "@/lib/audio/audio-coordinator"
import { activeTargetForCell } from "@/lib/audio/track-audio"
import { loadSnapEnabled, saveSnapEnabled } from "@/lib/timeline/snap"
import { TimelineRuler } from "./TimelineRuler"
import { TimelineLane } from "./TimelineLane"
import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import { TimelinePlayhead } from "./TimelinePlayhead"
import { TimelineCellDetail, type TimelineDetailActions } from "./TimelineCellDetail"
import { useTimelineClock } from "./useTimelineClock"
import type { CellData } from "@/hooks/useCells"

export type { TimelineDetailActions } from "./TimelineCellDetail"

export interface TimelineEditorProps {
  cells: CellData[]
  coreMediaUrl: string | null
  editable: boolean
  /** Used to scope the persisted zoom preference. */
  fileId: string
  /** Round 6 (SUB-36): retiming exists ONLY on the subtitle row — the source
   *  split is frozen at import. Media cells get an independent subtitle span;
   *  text cells' own timing IS their subtitle timing (the workspace routes). */
  onRetimeSubtitle(cellId: string, startSec: number, endSec: number): void
  /** Round 6/7: move a section's dub chip — its clip-zero anchor (file sec). */
  onRetimeTarget?(cellId: string, anchorSec: number): void
  /** Round 7: trim a dub chip — complete trim state (undefined clears). */
  onTrimTarget?(cellId: string, audioId: string, trims: { trimStartMs?: number; trimEndMs?: number }): void
  /** Round 7 (SUB-44): Space — toggle queue playback (playing→pause,
   *  paused→resume, idle→start). The editor claims the app-wide audio
   *  shortcut while mounted so a last-played single cell can't steal Space. */
  onTogglePlay?(): void
  onCommitTarget(cellId: string, value: string): void
  /** When provided, shows a "Link video" control. null clears the link. */
  onLinkVideo?(url: string | null): void
  /** AQU-646: transcribe a media clip's audio into source text (detail pane). */
  onTranscribe?(cell: CellData): void
  /** AQU-646: navigate audio playback to a file-timeline second — ruler
   *  clicks and clean card clicks route through this (the workspace decides
   *  whether to jump the live queue or cue a paused one). */
  onSeekToTime?(sec: number): void
  /** AQU-646 round 3: the text view's cell actions for the detail pane
   *  (AI translate, comments, history, record, footnote…). Pass-through. */
  detailActions?: TimelineDetailActions
  /** AQU-646 round 3 (text→media trace): seeds selection on mount — opens the
   *  detail pane, centers the track on the clip, and cues playback (paused)
   *  at its start via onSeekToTime, same semantics as a clean card click. */
  initialSelectedCellId?: string | null
  /** AQU-646 round 3 (media→text trace): mirrors every selection change up. */
  onSelectedCellChange?(cellId: string | null): void
}

const zoomKey = (fileId: string) => `codex:timelineZoom:${fileId}`

function loadZoom(fileId: string): number {
  try {
    const v = Number(localStorage.getItem(zoomKey(fileId)))
    return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : ZOOM_DEFAULT
  } catch {
    return ZOOM_DEFAULT
  }
}

// Round 5: which tracks are AUDIBLE, persisted per file like zoom. Both-on is
// the default; the queue itself only ever sees element.muted flags.
const audibilityKey = (fileId: string) => `codex:timelineAudibility:${fileId}`

function loadAudibility(fileId: string): TrackAudibility {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(audibilityKey(fileId)) ?? "")
    if (parsed && typeof parsed === "object") {
      const p = parsed as Partial<TrackAudibility>
      return { source: p.source !== false, target: p.target !== false }
    }
  } catch {
    /* unset / private mode */
  }
  return { source: true, target: true }
}

function LaneLabel({ name, sub, dot, trailing }: { name: string; sub: string; dot: string; trailing?: ReactNode }) {
  return (
    <div className="flex h-[66px] items-center justify-between gap-1 border-b border-border px-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
          <span className={cn("h-1.5 w-1.5 rounded-sm", dot)} />
          {name}
        </span>
        <span className="text-[10px] text-muted-foreground">{sub}</span>
      </div>
      {trailing}
    </div>
  )
}

export function TimelineEditor({
  cells,
  coreMediaUrl,
  editable,
  fileId,
  onRetimeSubtitle,
  onRetimeTarget,
  onTrimTarget,
  onTogglePlay,
  onCommitTarget,
  onLinkVideo,
  onTranscribe,
  onSeekToTime,
  detailActions,
  initialSelectedCellId,
  onSelectedCellChange,
}: TimelineEditorProps) {
  const [pxPerSec, setPxPerSec] = useState(() => loadZoom(fileId))
  const [audibility, setAudibility] = useState<TrackAudibility>(() => loadAudibility(fileId))
  const [snapOn, setSnapOn] = useState(loadSnapEnabled)
  // Seeded by the text→media trace (AQU-646 round 3): the seed alone opens
  // the detail pane and rings the card.
  const [selectedId, setSelectedId] = useState<string | null>(() => initialSelectedCellId ?? null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportPx, setViewportPx] = useState(0)
  const [follow, setFollow] = useState(true)
  const videoRef = useRef<HTMLVideoElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Programmatic scrolls stamp this; the onScroll handler treats scroll
   *  events within 150ms of a stamp as our own, not a user disengage. */
  const lastProgrammaticScrollAt = useRef(0)
  const clock = useTimelineClock()

  // AQU-646: bridge the audio play-queue into the timeline clock. Progress is
  // file-timeline seconds for imported media (one shared clip); the cellIdSet
  // guard keeps a stale singleton queue (playing another file) from hijacking
  // this timeline's playhead.
  const queueState = useQueueState()
  const queueProgress = useQueueProgress()
  const cellIdSet = useMemo(() => new Set(cells.map((c) => c.id)), [cells])
  const queueActive =
    (queueState.kind === "playing" || queueState.kind === "paused" || queueState.kind === "loading") &&
    cellIdSet.has(queueState.cellId)
  const queuePlaying = queueState.kind === "playing" && cellIdSet.has(queueState.cellId)
  useEffect(() => {
    if (queueActive) clock.setCurrentSec(queueProgress.currentTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock setters are stable
  }, [queueActive, queueProgress.currentTime])
  useEffect(() => {
    if (queuePlaying) {
      clock.play()
      // Starting playback is an explicit "watch this" — re-engage follow.
      setFollow(true)
    } else {
      clock.pause()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock setters are stable
  }, [queuePlaying])

  // Measure the scroll viewport before first paint + on resizes — the
  // windowing math and follow-scroll both need a real clientWidth.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    setViewportPx(el.clientWidth)
    if (typeof ResizeObserver === "undefined") return // happy-dom
    const ro = new ResizeObserver(() => setViewportPx(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Round 5: keep the queue's element muting in lockstep with the speaker
  // buttons (mount + every toggle).
  useEffect(() => {
    setQueueAudibility(audibility)
  }, [audibility])

  // Round 7 (SUB-44): transport keys while the timeline is on screen.
  // Space = play/pause the QUEUE; Cmd/Ctrl+Enter = back to the very start.
  // The editor claims the app-wide audio shortcut for its lifetime so the
  // global handler (which may target a last-played single cell) yields.
  const onTogglePlayRef = useRef(onTogglePlay)
  onTogglePlayRef.current = onTogglePlay
  const onSeekToTimeRef = useRef(onSeekToTime)
  onSeekToTimeRef.current = onSeekToTime
  useEffect(() => {
    const releaseOverride = pushAudioShortcutOverride()
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInEditableContext(e.target)) return
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault() // keep Space from scrolling the page
        onTogglePlayRef.current?.()
        return
      }
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        onSeekToTimeRef.current?.(0)
        const el = scrollRef.current
        if (el) {
          lastProgrammaticScrollAt.current = performance.now()
          el.scrollLeft = 0
          setScrollLeft(0)
        }
        setFollow(true)
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("keydown", onKeyDown)
      releaseOverride()
    }
  }, [])

  function toggleTrackAudible(track: keyof TrackAudibility) {
    setAudibility((prev) => {
      const next = { ...prev, [track]: !prev[track] }
      try {
        localStorage.setItem(audibilityKey(fileId), JSON.stringify(next))
      } catch {
        /* private mode — just won't persist */
      }
      return next
    })
  }

  function speakerToggle(track: keyof TrackAudibility, name: string) {
    const audible = audibility[track]
    return (
      <button
        type="button"
        data-testid={`tl-speaker-${track}`}
        aria-label={audible ? `Mute ${name}` : `Unmute ${name}`}
        aria-pressed={audible}
        title={audible ? `${name} is audible — click to mute` : `${name} is muted — click to unmute`}
        onClick={() => toggleTrackAudible(track)}
        className={cn(
          "inline-flex shrink-0 items-center rounded-md border border-border p-1",
          audible
            ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
            : "bg-background text-foreground/50 hover:bg-muted",
        )}
      >
        {audible ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
      </button>
    )
  }

  const { subtitle, dialogue, untimed } = useMemo(() => deriveLanes(cells), [cells])
  // Round 5: the Target-audio track's chips — one per section with dub audio.
  const targetItems = useMemo<TargetAudioItem[]>(
    () =>
      dialogue.flatMap((c) => {
        const target = activeTargetForCell(c)
        return target ? [{ cell: c, kind: target.kind, audioId: target.audioId }] : []
      }),
    [dialogue],
  )
  const bounds = useMemo(() => timelineBounds(cells), [cells])
  const durationSec = (bounds?.end ?? 0) + 2
  const trackWidthPx = secToPx(durationSec, pxPerSec)
  const viewStartSec = pxToSec(scrollLeft, pxPerSec)
  // Before the scroll container is measured (viewportPx 0), fall back to the
  // full track so every card renders — correct, and keeps tests deterministic.
  const viewEndSec = pxToSec(scrollLeft + (viewportPx || trackWidthPx), pxPerSec)
  const selectedCell = useMemo(
    () => cells.find((c) => c.id === selectedId) ?? null,
    [cells, selectedId],
  )

  function scrollTrackTo(left: number) {
    const el = scrollRef.current
    if (!el) return
    lastProgrammaticScrollAt.current = performance.now()
    el.scrollLeft = left
    setScrollLeft(left)
  }

  function applyZoom(next: number) {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next))
    // AQU-646: keep an anchor stable across the zoom — the playhead when
    // following live playback, otherwise the viewport center.
    const el = scrollRef.current
    if (el && viewportPx > 0) {
      const followAnchor = follow && queueActive
      const anchorSec = followAnchor ? clock.currentSec : pxToSec(scrollLeft + viewportPx / 2, pxPerSec)
      const target = Math.max(0, secToPx(anchorSec, z) - (followAnchor ? viewportPx * 0.1 : viewportPx / 2))
      setPxPerSec(z)
      // Apply after React paints the new track width, or the browser clamps
      // the scroll to the old width.
      requestAnimationFrame(() => scrollTrackTo(target))
    } else {
      setPxPerSec(z)
    }
    try {
      localStorage.setItem(zoomKey(fileId), String(z))
    } catch {
      /* private mode / unavailable — zoom just won't persist */
    }
  }

  function seekTo(sec: number) {
    clock.seekTo(sec)
    if (videoRef.current) {
      try {
        videoRef.current.currentTime = Math.max(0, sec)
      } catch {
        /* not seekable yet */
      }
    }
    // AQU-646: explicit seeks drive the audio queue too, and re-engage follow.
    onSeekToTime?.(Math.max(0, sec))
    setFollow(true)
  }

  // AQU-646 round 3: mirror every selection change up for the media→text
  // trace (one effect catches the lanes' onSelect AND the untimed chips
  // without touching call sites; the mount fire harmlessly mirrors the seed).
  useEffect(() => {
    onSelectedCellChange?.(selectedId)
  }, [selectedId, onSelectedCellChange])

  // AQU-646 round 3: consume the text→media trace once on mount. Reads the
  // live clientWidth (viewportPx state is still 0 here — it lands via the
  // measurement useLayoutEffect a beat later) to center the clip; seekTo cues
  // the queue paused at the clip start and re-engages follow — identical to a
  // clean card click. Untimed traced cells: selection + pane only.
  useEffect(() => {
    const id = initialSelectedCellId
    if (!id) return
    const cell = cells.find((c) => c.id === id)
    if (!cell || typeof cell.startTime !== "number" || !Number.isFinite(cell.startTime)) return
    const viewport = scrollRef.current?.clientWidth ?? 0
    scrollTrackTo(Math.max(0, secToPx(cell.startTime, pxPerSec) - viewport / 2))
    seekTo(cell.startTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only trace consume
  }, [])

  // AQU-646 follow-playhead: page-flip the view when the playhead approaches
  // the right edge (or leaves the left). Reads the element's live scrollLeft —
  // state can lag a programmatic scroll by a frame.
  useEffect(() => {
    if (!follow || !queuePlaying) return
    const el = scrollRef.current
    if (!el) return
    const target = computeFollowScroll(
      secToPx(queueProgress.currentTime, pxPerSec),
      el.scrollLeft,
      viewportPx,
      trackWidthPx,
    )
    if (target != null) scrollTrackTo(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- element scrollLeft is read live
  }, [follow, queuePlaying, queueProgress.currentTime, pxPerSec, viewportPx, trackWidthPx])

  const laneProps = {
    pxPerSec,
    viewStartSec,
    viewEndSec,
    selectedId,
    editable,
    onSelect: setSelectedId,
    onRetime: onRetimeSubtitle,
    // Clean card click → navigate playback to the clip's start (both lanes;
    // untimed chips have no timecode to seek to).
    onSeek: (cellId: string) => {
      const cell = cells.find((c) => c.id === cellId)
      if (cell && typeof cell.startTime === "number" && Number.isFinite(cell.startTime)) {
        seekTo(cell.startTime)
      }
    },
  }

  return (
    <div data-testid="tl-editor" className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">Timeline</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Snap to neighboring edges"
            aria-pressed={snapOn}
            title={snapOn ? "Snapping on — edges magnet to neighbors" : "Snapping off"}
            data-testid="tl-snap-toggle"
            onClick={() => {
              const next = !snapOn
              setSnapOn(next)
              saveSnapEnabled(next)
            }}
            className={cn(
              "inline-flex items-center rounded-md border border-border px-1.5 py-1",
              snapOn ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" : "bg-background text-foreground/70 hover:bg-muted",
            )}
          >
            <Magnet className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="Follow playhead"
            aria-pressed={follow}
            title="Follow playhead"
            onClick={() => {
              const next = !follow
              setFollow(next)
              if (next) {
                const el = scrollRef.current
                if (el) {
                  const target = computeFollowScroll(
                    secToPx(clock.currentSec, pxPerSec), el.scrollLeft, viewportPx, trackWidthPx,
                  )
                  if (target != null) scrollTrackTo(target)
                }
              }
            }}
            className={cn(
              "inline-flex items-center rounded-md border border-border px-1.5 py-1",
              follow ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300" : "bg-background text-foreground/70 hover:bg-muted",
            )}
          >
            <LocateFixed className="h-3.5 w-3.5" />
          </button>
          {onLinkVideo && (
            <button
              type="button"
              onClick={() => {
                const u = window.prompt("Core video URL (leave blank to clear)", coreMediaUrl ?? "")
                if (u !== null) onLinkVideo(u.trim() || null)
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground/80 hover:bg-muted"
            >
              <Film className="h-3.5 w-3.5 text-muted-foreground" />
              {coreMediaUrl ? "Change video" : "Link video"}
            </button>
          )}
          <div className="inline-flex items-center rounded-md border border-border">
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => applyZoom(pxPerSec / 1.3)}
              className="px-1.5 py-1 text-foreground/70 hover:bg-muted"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="border-x border-border px-2 font-mono text-[11px] tabular-nums text-muted-foreground">
              {(pxPerSec / ZOOM_DEFAULT).toFixed(1)}×
            </span>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => applyZoom(pxPerSec * 1.3)}
              className="px-1.5 py-1 text-foreground/70 hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* linked-URL video preview (master clock) */}
      {coreMediaUrl && (
        <div className="flex justify-center border-b border-border bg-black">
          <video
            ref={videoRef}
            src={coreMediaUrl}
            controls
            data-testid="tl-video"
            onTimeUpdate={(e) => clock.setCurrentSec(e.currentTarget.currentTime)}
            className="max-h-[240px] w-auto"
          />
        </div>
      )}

      {/* timeline */}
      <div className="grid min-h-0 grid-cols-[128px_1fr]">
        <div className="border-r border-border bg-muted/20">
          <div className="h-7 border-b border-border" />
          <LaneLabel name="Subtitles" sub="text · reading" dot="bg-zinc-400 dark:bg-zinc-600" />
          <LaneLabel name="Source audio" sub="original speech" dot="bg-sky-600" trailing={speakerToggle("source", "source audio")} />
          <LaneLabel name="Target audio" sub="takes · generated" dot="bg-emerald-600" trailing={speakerToggle("target", "target audio")} />
          {/* SUB-37: the untimed parking strip only exists when something is
              actually untimed — an always-on empty row read as a mystery. */}
          {untimed.length > 0 && (
            <div className="flex h-12 flex-col justify-center px-3">
              <span className="text-xs font-semibold text-foreground">Untimed</span>
              <span className="text-[10px] text-muted-foreground">no timecode yet</span>
            </div>
          )}
        </div>
        <div
          ref={scrollRef}
          className="overflow-x-auto"
          onScroll={(e) => {
            setScrollLeft(e.currentTarget.scrollLeft)
            setViewportPx(e.currentTarget.clientWidth)
            // A MANUAL scroll while playback runs means "stop following me".
            // Our own programmatic scrolls fire this handler too — the 150ms
            // stamp window filters them out.
            if (queuePlaying && performance.now() - lastProgrammaticScrollAt.current > 150) {
              setFollow(false)
            }
          }}
        >
          <div className="relative" style={{ width: `${trackWidthPx}px` }}>
            <TimelineRuler durationSec={durationSec} pxPerSec={pxPerSec} onScrub={seekTo} />
            <TimelineLane cells={subtitle} variant="subtitle" retimable snapEnabled={snapOn} {...laneProps} />
            {/* Round 6: the source split is FROZEN at import — never retimable. */}
            <TimelineLane cells={dialogue} variant="dialogue" retimable={false} {...laneProps} />
            <TargetAudioLane
              items={targetItems}
              pxPerSec={pxPerSec}
              viewStartSec={viewStartSec}
              viewEndSec={viewEndSec}
              selectedId={selectedId}
              editable={editable}
              snapEnabled={snapOn}
              onSelect={setSelectedId}
              onSeek={laneProps.onSeek}
              onRetimeTarget={onRetimeTarget}
              onTrimTarget={onTrimTarget}
            />
            {untimed.length > 0 && (
              <div className="flex h-12 items-center gap-2 overflow-x-auto border-b border-border px-3">
                {untimed.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`tl-untimed-${c.id}`}
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "shrink-0 rounded-md border border-dashed border-zinc-400 bg-background px-2 py-1 text-[10px] text-foreground/80 hover:bg-muted dark:border-zinc-600",
                      selectedId === c.id && "ring-2 ring-sky-500",
                    )}
                  >
                    {(c.original || c.transcription || c.cellLabel || "untimed").slice(0, 36)}
                  </button>
                ))}
              </div>
            )}
            <TimelinePlayhead
              currentSec={clock.currentSec}
              pxPerSec={pxPerSec}
              playing={queuePlaying}
              rate={queueProgress.rate}
            />
          </div>
        </div>
      </div>

      <TimelineCellDetail cell={selectedCell} editable={editable} onCommitTarget={onCommitTarget} onTranscribe={onTranscribe} detailActions={detailActions} />
    </div>
  )
}
