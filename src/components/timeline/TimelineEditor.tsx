// The timeline editor: composes the lanes, ruler, playhead, video preview, and
// detail pane into the Media-lens surface. Owns zoom (persisted per file),
// horizontal scroll/windowing, selection, and the master clock. Hand-rolled;
// the only "media" dependency is a native <video> element for the linked-URL
// preview (the remote host serves Range — no streaming work needed here).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { AudioLines, Film, LocateFixed, Magnet, Minus, Plus, Volume2, VolumeX } from "lucide-react"
import { cn } from "@/lib/utils"
import { deriveLanes } from "@/lib/timeline/lanes"
import { buildTimelineLayout, type TimelineLayout } from "@/lib/timeline/layout"
import { computeFollowScroll } from "@/lib/timeline/follow"
import { secToPx, pxToSec, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from "@/lib/timeline/scale"
// Read-only queue subscriptions only — playback COMMANDS stay in the
// workspace (onSeekToTime), keeping this component testable with a spy prop.
// Round 5 exception: the per-track speaker buttons drive setQueueAudibility
// directly — muting is a pure element-level concern with no workspace state.
import { useQueueProgress, useQueueState, setQueueAudibility, type TrackAudibility } from "@/lib/audio/play-queue"
import { isInEditableContext, isTopAudioShortcutOwner, pushAudioShortcutOverride } from "@/lib/audio/audio-coordinator"
import { spacebarShouldToggle } from "@/lib/audio/playback-keys"
import { activeTargetForCell } from "@/lib/audio/track-audio"
import { loadSnapEnabled, saveSnapEnabled } from "@/lib/timeline/snap"
import { setAudioQualityPref, useAudioQualityPref } from "@/lib/store/audio-quality-pref"
import { TimelineRuler } from "./TimelineRuler"
import { TimelineLane } from "./TimelineLane"
import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import { TimelinePlayhead } from "./TimelinePlayhead"
import { TimelineCellDetail, type TimelineDetailActions } from "./TimelineCellDetail"
import { useTimelineClock } from "./useTimelineClock"
import { resolveEntryAudio, useClipAudioMissing } from "./useClipAudioMissing"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import type { AudioTimingMode, ProjectRecord, RuleInfraction } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { AppTooltip } from "@/components/ui/tooltip"

export type { TimelineDetailActions } from "./TimelineCellDetail"

export interface TimelineEditorProps {
  cells: CellData[]
  coreMediaUrl: string | null
  editable: boolean
  /** Used to scope the persisted zoom preference. */
  fileId: string
  /** Round 6 (SUB-36): retiming exists ONLY on the subtitle row — the source
   *  split is frozen at import. Media cells get an independent subtitle span;
   *  text cells' own timing IS their subtitle timing (the workspace routes).
   *  (Renamed from `onRetime` when the source row was frozen.) */
  onRetimeSubtitle(cellId: string, startSec: number, endSec: number): void
  /** Round 6/7: move a section's dub chip — its clip-zero anchor (file sec). */
  onRetimeTarget?(cellId: string, anchorSec: number): void
  /** Round 7: trim a dub chip — complete trim state (undefined clears). */
  onTrimTarget?(cellId: string, audioId: string, trims: { trimStartMs?: number; trimEndMs?: number }): void
  /** Round 7 (SUB-44): Space — toggle queue playback (playing→pause,
   *  paused→resume, idle→start). The editor claims the app-wide audio
   *  shortcut while mounted so a last-played single cell can't steal Space. */
  onTogglePlay?(): void
  /** `valueHtml` (AQU-659): the detail pane runs the shared editor now, so a
   *  commit can carry rich text alongside the plain value. */
  onCommitTarget(cellId: string, value: string, valueHtml?: string): void
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
  /** SUB-53: which job this project is for. "dubbing" (the default) draws the
   *  track against the imported recording's clock; "audioFirst" lays the
   *  verses out end to end at their real lengths. */
  timingMode?: AudioTimingMode
  /** SUB-53: change the project's mode. Absent = the control is read-only
   *  (the server requires maintainer to write project settings). */
  onChangeTimingMode?(mode: AudioTimingMode): void
  /** Forwarded to the clip detail pane so it can resolve/stream source audio. */
  project?: ProjectRecord
  /** Active managed terminology concepts for the detail-pane editor's chips. */
  terminologyConcepts?: Concept[]
  /** Per-cell rule infractions (keyed by cell id) for the detail-pane blots. */
  infractions?: Map<string, RuleInfraction[]>
  /** Fires when the highlighted section changes so a sibling transport (the
   *  bottom playback bar) can start playback from the selected section. */
  onSelectCell?(cellId: string | null): void
  /** Session for the missing-audio probe that badges a selected clip whose
   *  recording is permanently gone. Absent (focused unit tests) → no probe. */
  session?: FrontierSession | null
  /** Per-file audio-attachment reads (from useFileAudioAttachments). Timeline
   *  cells carry no attachments, so the probe resolves the selected clip's take
   *  from this map. Absent → no badge. */
  audioByCellId?: Map<string, CellAudioEntry>
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
  timingMode = "dubbing",
  onChangeTimingMode,
  project,
  terminologyConcepts,
  infractions,
  onSelectCell,
  session,
  audioByCellId,
}: TimelineEditorProps) {
  const audioFirst = timingMode === "audioFirst"
  const [pxPerSec, setPxPerSec] = useState(() => loadZoom(fileId))
  const [audibility, setAudibility] = useState<TrackAudibility>(() => loadAudibility(fileId))
  const [snapOn, setSnapOn] = useState(loadSnapEnabled)
  const audioQuality = useAudioQualityPref()
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
  // Smooth-playback round: the readiness gate flips playing→loading→playing at
  // a cold verse boundary. `queuePlaying` stays STRICT (the playhead's rAF
  // interpolation must park during a gate — that's the whole point), but the
  // follow re-engage below keys on running-or-loading, or every cold boundary
  // would re-yank a user who deliberately scrolled away mid-playback.
  const queueRunning =
    (queueState.kind === "playing" || queueState.kind === "loading") && cellIdSet.has(queueState.cellId)
  useEffect(() => {
    if (queueActive) clock.setCurrentSec(queueProgress.currentTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock setters are stable
  }, [queueActive, queueProgress.currentTime])
  useEffect(() => {
    if (queuePlaying) clock.play()
    else clock.pause()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock setters are stable
  }, [queuePlaying])
  useEffect(() => {
    // Starting playback is an explicit "watch this" — re-engage follow. Keyed
    // on running (playing OR loading) so a gate's brief "loading" dip doesn't
    // count as a fresh start.
    if (queueRunning) setFollow(true)
  }, [queueRunning])

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
      // SUB-52: the timeline holds this claim for as long as it is mounted,
      // and the recording modal opens on top of it without unmounting it —
      // so Space was starting playback here at the same time as it started
      // the recording. Stand down whenever something has claimed above us.
      if (!isTopAudioShortcutOwner(releaseOverride.owner)) return
      // FORTIFY: the shared predicate also refuses Space when focus sits on a
      // button/slider/menu item — with only the editable-context check, Space
      // on a focused control (mute button, an open dialog's default button)
      // toggled the transport underneath instead of activating the control.
      if (spacebarShouldToggle(e)) {
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
  // SUB-53: the single answer to "where does this go on the track?". Dubbing
  // returns the pre-SUB-53 geometry verbatim; audio-first returns the laid-out
  // programme. Everything below reads positions through this.
  const layout = useMemo<TimelineLayout>(
    () => buildTimelineLayout(timingMode, cells, dialogue),
    [timingMode, cells, dialogue],
  )
  // Round 5: the Target-audio track's chips — one per section with dub audio.
  const targetItems = useMemo<TargetAudioItem[]>(
    () =>
      dialogue.flatMap((c) => {
        const target = activeTargetForCell(c)
        return target ? [{ cell: c, kind: target.kind, audioId: target.audioId }] : []
      }),
    [dialogue],
  )
  // SUB-51: the complement — sections still waiting for a dub. Their empty
  // space in the Target row offers a record button on hover.
  const emptyTargets = useMemo(
    () => dialogue.filter((c) => !activeTargetForCell(c)),
    [dialogue],
  )
  const durationSec = layout.totalSec
  const trackWidthPx = secToPx(durationSec, pxPerSec)
  // SUB-18: overscan the visibility window by ~240px each side so cards at the
  // edges don't pop in/out during zoom glides and fast scrolls (windowing was
  // exact-to-the-pixel, so any transient scroll/zoom mismatch blinked cards).
  const overscanSec = pxToSec(240, pxPerSec)
  const viewStartSec = pxToSec(scrollLeft, pxPerSec) - overscanSec
  // Before the scroll container is measured (viewportPx 0), fall back to the
  // full track so every card renders — correct, and keeps tests deterministic.
  const viewEndSec = pxToSec(scrollLeft + (viewportPx || trackWidthPx), pxPerSec) + overscanSec
  const selectedCell = useMemo(
    () => cells.find((c) => c.id === selectedId) ?? null,
    [cells, selectedId],
  )
  // Meeting note (2026-08-05): the detail readout carries the dub's own
  // numbers — its range, its duration, and ALWAYS the end-to-end difference
  // (original end − dub end). Ends are what timing work cares about; the diff
  // goes negative exactly when the dub outruns its verse. Dubbing only, and
  // never from a guessed width (SUB-48).
  const selectedChipStats = useMemo(() => {
    if (audioFirst || !selectedCell) return null
    const item = targetItems.find((t) => t.cell.id === selectedCell.id)
    if (!item) return null
    const geom = layout.targetGeom(item.cell, item.cell.attachments?.[item.audioId])
    if (!geom || geom.usingFallback) return null
    const sectionEnd = selectedCell.endTime
    return {
      startSec: geom.start,
      endSec: geom.end,
      durationSec: geom.end - geom.start,
      endDiffSec: typeof sectionEnd === "number" ? sectionEnd - geom.end : null,
    }
  }, [audioFirst, selectedCell, targetItems, layout])
  const selectedClipAudio = useMemo(
    () => (selectedId ? resolveEntryAudio(audioByCellId?.get(selectedId)) : null),
    [audioByCellId, selectedId],
  )
  const audioMissing = useClipAudioMissing({
    audio: selectedClipAudio,
    projectId: project?.id ?? null,
    fileId,
    session: session ?? null,
  })

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

  // SUB-12: cursor-centered wheel/pinch zoom (⌘/ctrl + wheel — trackpad pinch
  // arrives as a ctrlKey wheel). Native listener with passive:false because
  // React's synthetic onWheel can't reliably preventDefault (the browser would
  // page-zoom). Plain wheel (no modifier) keeps scrolling untouched.
  //
  // Smoothness (Sam's "spazzy" feedback on v1):
  //  - the factor scales with gesture velocity (exp of deltaY) instead of a
  //    fixed 1.15 step per event — a pinch emits dozens of small-delta events,
  //    which v1 turned into runaway zoom speed;
  //  - the scroll anchor is applied in a LAYOUT effect (post-commit, pre-paint)
  //    instead of requestAnimationFrame, so the point under the cursor never
  //    visibly jumps for a frame and snaps back;
  //  - the listener attaches ONCE (refs carry current zoom), so no per-step
  //    detach/re-attach gaps.
  const pxPerSecRef = useRef(pxPerSec)
  pxPerSecRef.current = pxPerSec
  const zoomAnchorRef = useRef<{ timeSec: number; offsetX: number } | null>(null)
  // Eased zoom: wheel/pinch moves a TARGET; the committed zoom glides toward it
  // (~35%/frame exponential approach) for a light accel/decel feel. The first
  // step applies synchronously so response is immediate; the rAF loop carries
  // the tail. The anchor persists across the glide so the cursor-point stays
  // pinned through every animated frame.
  const zoomTargetRef = useRef(pxPerSec)
  const zoomAnimRef = useRef<number | null>(null)
  const zoomGestureAnchorRef = useRef<{ timeSec: number; offsetX: number } | null>(null)
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    zoomTargetRef.current = pxPerSecRef.current

    const step = () => {
      const cur = pxPerSecRef.current
      const target = zoomTargetRef.current
      // Precision bypass: a SLOW gesture (per-tick increments ≤ ~6% of the
      // current zoom, i.e. the gap never builds up) applies 1:1 with no glide —
      // easing there reads as rubber-band lag. Fast gestures/wheel notches open
      // a bigger gap and get the eased approach (and its decel tail on stop).
      const next =
        Math.abs(target - cur) <= Math.max(0.4, cur * 0.06)
          ? target
          : cur + (target - cur) * 0.35
      const anchor = zoomGestureAnchorRef.current
      zoomAnchorRef.current = anchor
      setPxPerSec(next)
      // SUB-18 (flicker): update the scroll STATE in the same batch as the
      // zoom. Otherwise each glide frame renders with new zoom + stale
      // scrollLeft (state only catches up via the DOM scroll event a beat
      // later), the visibility window miscomputes for that frame, and edge
      // cards blink out. The layout effect still writes the DOM scrollLeft.
      if (anchor) {
        setScrollLeft(Math.max(0, secToPx(anchor.timeSec, next) - anchor.offsetX))
      }
      if (next !== target) {
        zoomAnimRef.current = requestAnimationFrame(step)
      } else {
        zoomAnimRef.current = null
        zoomGestureAnchorRef.current = null
      }
    }

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      // Two very different inputs share this event: trackpad PINCH ticks are
      // floats whose magnitude tracks gesture speed (~1 slow … ~60+ hard),
      // wheel NOTCHES are ~±100+. Wheel keeps its dialed-in gain; pinch speed
      // grows linearly with the tick and is CAPPED (not cliffed) so a hard
      // pinch is uniformly fast — the old <40 threshold dropped fast-pinch
      // ticks into the 8×-weaker wheel gain, deadening exactly the fast case.
      const mag = Math.abs(e.deltaY)
      const speed = mag >= 90 ? mag * 0.0022 : Math.min(mag * 0.019, 0.55)
      const target = Math.max(
        ZOOM_MIN,
        Math.min(ZOOM_MAX, zoomTargetRef.current * Math.exp(e.deltaY < 0 ? speed : -speed)),
      )
      if (target === zoomTargetRef.current && target === pxPerSecRef.current) return
      zoomTargetRef.current = target
      const offsetX = e.clientX - el.getBoundingClientRect().left
      zoomGestureAnchorRef.current = {
        timeSec: pxToSec(el.scrollLeft + offsetX, pxPerSecRef.current),
        offsetX,
      }
      try {
        localStorage.setItem(zoomKey(fileId), String(target))
      } catch {
        /* private mode / unavailable — zoom just won't persist */
      }
      if (zoomAnimRef.current === null) step() // immediate first step; rAF glides the rest
    }

    el.addEventListener("wheel", onWheel, { passive: false })
    return () => {
      el.removeEventListener("wheel", onWheel)
      if (zoomAnimRef.current !== null) cancelAnimationFrame(zoomAnimRef.current)
      zoomAnimRef.current = null
    }
  }, [fileId])
  // Re-anchor the scroll position in the same commit as the zoom (before
  // paint), keeping the time under the cursor stationary with zero flicker.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = zoomAnchorRef.current
    if (!el || !anchor) return
    zoomAnchorRef.current = null
    // Stamp as programmatic: zoom re-anchoring must not read as a manual
    // scroll and disengage follow-playhead mid-glide.
    lastProgrammaticScrollAt.current = performance.now()
    el.scrollLeft = Math.max(0, secToPx(anchor.timeSec, pxPerSec) - anchor.offsetX)
  }, [pxPerSec])

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

  // Mirror every selection change up — one effect catches the lanes' onSelect
  // AND the untimed chips without touching call sites; the mount fire
  // harmlessly mirrors the trace seed. Two listeners, two features:
  // onSelectedCellChange feeds the media→text trace (AQU-646 round 3);
  // onSelectCell lets the bottom playback bar start from the highlighted
  // section (AQU-666).
  useEffect(() => {
    onSelectedCellChange?.(selectedId)
    onSelectCell?.(selectedId)
  }, [selectedId, onSelectedCellChange, onSelectCell])

  // AQU-646 round 3: consume the text→media trace once on mount. Reads the
  // live clientWidth (viewportPx state is still 0 here — it lands via the
  // measurement useLayoutEffect a beat later) to center the clip; seekTo cues
  // the queue paused at the clip start and re-engages follow — identical to a
  // clean card click. Untimed traced cells: selection + pane only.
  useEffect(() => {
    const id = initialSelectedCellId
    if (!id) return
    const cell = cells.find((c) => c.id === id)
    const at = cell ? layout.seekSecFor(cell) : null
    if (at == null) return
    const viewport = scrollRef.current?.clientWidth ?? 0
    scrollTrackTo(Math.max(0, secToPx(at, pxPerSec) - viewport / 2))
    seekTo(at)
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
  }, [follow, queuePlaying, queueProgress.currentTime, pxPerSec, viewportPx, trackWidthPx])

  const laneProps = {
    layout,
    pxPerSec,
    viewStartSec,
    viewEndSec,
    selectedId,
    editable,
    onSelect: setSelectedId,
    onRetime: onRetimeSubtitle,
    // Clean card click → navigate playback to the clip's start (both lanes;
    // untimed chips have no timecode to seek to). SUB-53: "the clip's start"
    // is a programme second in audio-first mode, so the layout resolves it.
    onSeek: (cellId: string) => {
      const cell = cells.find((c) => c.id === cellId)
      const at = cell ? layout.seekSecFor(cell) : null
      if (at != null) seekTo(at)
    },
  }

  return (
    <div data-testid="tl-editor" className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">Timeline</span>
        {/* SUB-53: which job this project is for. Audio-first lays the verses
            out end to end so a translation that runs long stops dragging
            everything after it out of line. Read-only below maintainer — the
            server requires that role to write project settings. */}
        <div
          data-testid="tl-timing-mode"
          data-mode={timingMode}
          className="ml-2 inline-flex items-center overflow-hidden rounded-md border border-border text-[11px]"
        >
          {(
            [
              { mode: "dubbing" as const, label: "Original's timing", hint: "The translation is fitted to the original recording's timing." },
              { mode: "audioFirst" as const, label: "Free timing", hint: "Verses are laid end to end — each takes as much room as its longer side." },
            ]
          ).map(({ mode, label, hint }) =>
            onChangeTimingMode ? (
              <button
                key={mode}
                type="button"
                data-testid={`tl-timing-mode-${mode}`}
                aria-pressed={timingMode === mode}
                title={hint}
                onClick={() => {
                  if (timingMode !== mode) onChangeTimingMode(mode)
                }}
                className={cn(
                  "px-2 py-1",
                  timingMode === mode
                    ? "bg-sky-100 font-medium text-sky-700 dark:bg-sky-950 dark:text-sky-300"
                    : "bg-background text-foreground/60 hover:bg-muted",
                )}
              >
                {label}
              </button>
            ) : timingMode === mode ? (
              <span
                key={mode}
                data-testid={`tl-timing-mode-${mode}`}
                title={`${hint} Only a maintainer can change this.`}
                className="px-2 py-1 text-foreground/70"
              >
                {label}
              </span>
            ) : null,
          )}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {/* Meeting 2026-08-05: generated voices default to compressed
              playback; fast connections can opt into the original WAV. Mic
              recordings have no lossless form — the tooltip says so. */}
          <AppTooltip
            content={
              audioQuality === "original"
                ? "Original quality (WAV) for generated voices — larger downloads. Recordings are always compressed."
                : "Compressed playback (smaller, faster). Toggle for original-quality generated voices."
            }
          >
            <button
              type="button"
              aria-label="Play generated voices at original quality"
              aria-pressed={audioQuality === "original"}
              data-testid="tl-quality-toggle"
              onClick={() => setAudioQualityPref(audioQuality === "original" ? "compressed" : "original")}
              className={cn(
                "inline-flex items-center rounded-md border border-border px-1.5 py-1",
                audioQuality === "original"
                  ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
                  : "bg-background text-foreground/70 hover:bg-muted",
              )}
            >
              <AudioLines className="h-3.5 w-3.5" />
            </button>
          </AppTooltip>
          {/* SUB-53: nothing to snap to when positions are computed. */}
          {!audioFirst && (
          <AppTooltip content={snapOn ? "Snapping on — edges magnet to neighbors" : "Snapping off"}>
            <button
              type="button"
              aria-label="Snap to neighboring edges"
              aria-pressed={snapOn}
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
          </AppTooltip>
          )}
          <AppTooltip content="Follow playhead">
            <button
              type="button"
              aria-label="Follow playhead"
              aria-pressed={follow}
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
          </AppTooltip>
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

      {/* linked-URL video preview (master clock). SUB-53: a video runs on the
          original recording's clock, so it cannot follow a re-flowed track —
          say so rather than let it drift silently against the audio. */}
      {coreMediaUrl && !audioFirst && (
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
      {coreMediaUrl && audioFirst && (
        <div
          data-testid="tl-video-hidden-note"
          className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          The linked video is hidden here — it plays on the original recording's timing, which this view no longer follows.
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
          data-testid="tl-scroll"
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
            {/* SUB-53: a subtitle span is expressed against the original's
                clock, so it can't be dragged on a re-flowed track. */}
            <TimelineLane cells={subtitle} variant="subtitle" retimable={!audioFirst} snapEnabled={snapOn} {...laneProps} />
            {/* Round 6: the source split is FROZEN at import — never retimable. */}
            <TimelineLane cells={dialogue} variant="dialogue" retimable={false} {...laneProps} />
            <TargetAudioLane
              items={targetItems}
              layout={layout}
              pxPerSec={pxPerSec}
              viewStartSec={viewStartSec}
              viewEndSec={viewEndSec}
              selectedId={selectedId}
              editable={editable}
              snapEnabled={snapOn && !audioFirst}
              onSelect={setSelectedId}
              onSeek={laneProps.onSeek}
              // SUB-53: a chip's position is computed in audio-first, so there
              // is nothing to drag it to. Trimming stays — and re-flows.
              onRetimeTarget={audioFirst ? undefined : onRetimeTarget}
              onTrimTarget={onTrimTarget}
              onOpenRecording={detailActions?.onOpenRecording}
              emptyCells={emptyTargets}
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

      <TimelineCellDetail
        cell={selectedCell}
        chipStats={selectedChipStats}
        editable={editable}
        onCommitTarget={onCommitTarget}
        onTranscribe={onTranscribe}
        detailActions={detailActions}
        project={project}
        terminologyConcepts={terminologyConcepts}
        infractions={selectedCell ? infractions?.get(selectedCell.id) : undefined}
        audioMissing={audioMissing}
      />
    </div>
  )
}
