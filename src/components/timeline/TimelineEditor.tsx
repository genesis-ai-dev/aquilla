// The timeline editor: composes the lanes, ruler, playhead and chip strip into
// the top of the Media-lens surface. Owns zoom (persisted per file), horizontal
// scroll/windowing, and selection. Hand-rolled, with no media dependency of its
// own — the play queue is the master clock, and the linked video lives beside
// the text table as MediaVideoPane (AQU-646).

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { AudioLines, Film, LocateFixed, Magnet, Minus, Plus, Volume2, VolumeX, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { deriveLanes } from "@/lib/timeline/lanes"
import { deriveSourceRegions, EMPTY_SOURCE_REGIONS } from "@/lib/timeline/source-regions"
import { isLineEmpty, isUserAddedLine } from "@/lib/timeline/user-lines"
import { SourceRegionLane } from "./SourceRegionLane"
import { chipOverlaps, MIN_ADDABLE_SPAN_SEC } from "@/lib/timeline/lane-timing"
import { buildTimelineLayout, type TimelineLayout } from "@/lib/timeline/layout"
import { deriveTracksForFile, type TimelineTrack, type TrackKind } from "@/lib/timeline/tracks"
import { computeFollowScroll } from "@/lib/timeline/follow"
import { secToPx, pxToSec, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from "@/lib/timeline/scale"
// Read-only queue subscriptions only — playback COMMANDS stay in the
// workspace (onSeekToTime), keeping this component testable with a spy prop.
// Round 5 exception: the per-track speaker buttons write muting themselves —
// a pure element-level concern with no workspace state. Stage 2 moved that
// write behind lib/audio/audibility, because the video pane's header carries a
// mute button too now and two components each merging a toggle into their OWN
// copy of the preference clobber one another.
import { useQueueForFile, useMissingClipCells, queueClockIsFileTime } from "@/lib/audio/play-queue"
import { seedAudibility, toggleAudibility, useQueueAudibility, type TrackAudibility } from "@/lib/audio/audibility"
import { isInEditableContext, isTopAudioShortcutOwner, pushAudioShortcutOverride } from "@/lib/audio/audio-coordinator"
import { spacebarShouldToggle } from "@/lib/audio/playback-keys"
import { activeTargetForCell, resolveTargetAudio } from "@/lib/audio/track-audio"
import { loadSnapEnabled, saveSnapEnabled } from "@/lib/timeline/snap"
import { setMediaCursorCell, setMediaSyncActive } from "@/lib/timeline/media-cursor"
import { useVideoClockSec, useVideoClockPlaying } from "@/lib/timeline/video-clock"
import { useVideoDurationSec } from "@/lib/timeline/video-duration"
import { useUiSlot } from "@/lib/ui-slots"
import { setAudioQualityPref, useAudioQualityPref } from "@/lib/store/audio-quality-pref"
import { useBatchProgress } from "@/lib/audio/batch-audio"
import { useOnline } from "@/hooks/useOnline"
import { TimelineRuler } from "./TimelineRuler"
import { TimelineLane } from "./TimelineLane"
import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import { TimelinePlayhead } from "./TimelinePlayhead"
import { MediaTextHeader, TimelineTimingRow } from "./TimelineChipStrip"
import { useTimelineClock } from "./useTimelineClock"
import { resolveEntryAudio, useClipAudioMissing } from "./useClipAudioMissing"
import type { CellData } from "@/hooks/useCells"
import { AUDIO_TIMING_MODE_LABELS, type AudioTimingMode, type ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { AppTooltip } from "@/components/ui/tooltip"

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
  /** When provided, shows a "Link video" control that opens the workspace's
   *  link dialog. The dialog lives up there because the video pane offers the
   *  same action from its could-not-load state. */
  onRequestLinkVideo?(): void
  /**
   * AQU-646: add a line over a stretch of the film that has no cell of its own
   * — the "T" in the Subtitles track, and the mic in the Target audio track
   * (which creates the same blank line and then opens the recorder). Resolves
   * to the new cell's id, or null if it could not be made.
   */
  onAddLine?(startSec: number, endSec: number, opts?: { thenRecord?: boolean }): Promise<string | null>
  /** Whether this user may create cells at all (source.* is PROJECT_LEAD+). */
  canAddLine?: boolean
  /** Take back a line someone added, while it is still empty. */
  onRemoveLine?(cellId: string): void
  /** False disables the control — `file.video.set` needs contributor access,
   *  and the emit throws rather than failing quietly. */
  canLinkVideo?: boolean
  /** AQU-646 stage 2: open the audio-VTT import dialog. It lives up in the
   *  workspace for the same reason the link-video one does — it owns the upload
   *  and the refresh. Presence renders the control. */
  onRequestImportAudioVtt?(): void
  /** False disables it. The import creates cells, so the server enforces
   *  `source.cell.create` (PROJECT_LEAD): offering a button that can only mint
   *  a 403 is worse than offering none. */
  canImportAudioVtt?: boolean
  /** Whether an audio-cue sibling already exists for this file — the control
   *  then REPLACES rather than adds, and says so. */
  hasAudioCueTrack?: boolean
  /**
   * AQU-646 stage 2: the audio VTT's cues — the cells of the hidden sibling
   * file, transcript in `original`, times in seconds, and no `medium` (they are
   * not media, and they are not this file's text either).
   *
   * They arrive as their own prop rather than inside `cells` deliberately:
   * `medium` is the app's only cell→surface discriminator, so a cue mixed into
   * `cells` would land in the dialogue table, the counters, the exports, the
   * search index and the play queue. Timeline-only means timeline-only. null =
   * no sibling has been imported, and there is no Source-audio row at all.
   */
  audioCues?: CellData[] | null
  /** AQU-646: navigate audio playback to a file-timeline second — ruler
   *  clicks and clean card clicks route through this (the workspace decides
   *  whether to jump the live queue or cue a paused one). */
  onSeekToTime?(sec: number): void
  /** 2026-08-07: the empty-target chips' hover record button (the one
   *  detail-pane action that lives on the lanes, not in the table below). */
  onOpenRecording?(cellId: string): void
  /** AQU-646 round 3 (text→media trace): seeds selection on mount — fills the
   *  chip strip, centers the track on the clip, and cues playback (paused)
   *  at its start via onSeekToTime, same semantics as a clean card click. */
  initialSelectedCellId?: string | null
  /** AQU-646 round 3 (media→text trace): mirrors every selection change up. */
  onSelectedCellChange?(cellId: string | null): void
  /** 2026-08-07 (wire a): fires on USER chip clicks only — the workspace
   *  scrolls the text table to the matching row. Programmatic selection
   *  (activateRequest, the mount trace) stays silent to avoid echo loops. */
  onChipActivated?(cellId: string): void
  /** 2026-08-07 (wire b): a text-table row click, as a nonce'd request —
   *  selects the chip and centers/cues exactly like a chip click. */
  activateRequest?: { cellId: string; nonce: number } | null
  /** SUB-53: which job this FILE is for (pre-merge round: per-file, resolved
   *  via resolveFileTimingMode). "dubbing" (the default) draws the track
   *  against the imported recording's clock; "audioFirst" lays the verses out
   *  end to end at their real lengths. */
  timingMode?: AudioTimingMode
  /** Pre-merge round: change THIS FILE's mode (file.timing.set). Absent = the
   *  control is read-only (the server requires maintainer to write it). */
  onChangeTimingMode?(mode: AudioTimingMode): void
  /** AQU-646 stage 1: withhold the timing-mode control altogether. A subtitle
   *  import resolves to Original timing whatever it has stored, so there is
   *  only one mode it can be in — a picker with a single choice, or a label
   *  saying so, is a question the user cannot act on. */
  hideTimingMode?: boolean
  /** Needed by the missing-audio probe behind the chip strip's badge. */
  project?: ProjectRecord
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
  /** Pre-merge round: recordings that predate duration capture draw at
   *  fallback width and break Free timing's layout. When any exist in this
   *  file, a notice row offers a deliberate, user-initiated fix (never
   *  silent). Absent (focused tests) → no notice. */
  legacyMeasure?: {
    /** Takes in the file with no measured length. 0 = no notice. */
    count: number
    /** Kick the measure-all batch (progress rides AudioBulkProgressBanner). */
    onMeasure(): void
  }
  /** AQU-646 stage 1: the rows to draw, top to bottom — the label gutter and
   *  the lanes are both this one list, so they cannot fall out of step the way
   *  two hand-mirrored blocks of JSX could. Absent (focused tests, any other
   *  mount) = the three derived defaults, unchanged from what this editor has
   *  always drawn. */
  tracks?: TimelineTrack[]
}

/** The default prop, resolved ONCE. A `deriveTracksForFile(null)` call in the
 *  parameter list would hand every render a new array and churn every memo
 *  downstream of it. */
const DEFAULT_TRACKS = deriveTracksForFile(null)

const zoomKey = (fileId: string) => `codex:timelineZoom:${fileId}`

function loadZoom(fileId: string): number {
  try {
    const v = Number(localStorage.getItem(zoomKey(fileId)))
    return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : ZOOM_DEFAULT
  } catch {
    return ZOOM_DEFAULT
  }
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

// How this build DRAWS each kind: the sublabel under the name, the colour of
// the dot beside it, and whether the row carries a speaker button (with the
// name that button uses for the thing it mutes).
//
// Deliberately not part of the persisted track contract in lib/timeline/tracks.
// That contract is data — it syncs between clients, outlives this build, and a
// client that has never seen a kind still has to store it faithfully. A zinc
// dot and the words "text · reading" are this build's rendering of a kind, and
// a later one is free to draw the same track completely differently without
// anybody migrating anything.
const TRACK_RENDER: Record<
  TrackKind,
  { sub: string; dot: string; audibilityKey: keyof TrackAudibility | null; speakerName: string }
> = {
  // No speaker button: the Subtitles row makes no sound to mute.
  "source-subtitles": { sub: "text · reading", dot: "bg-zinc-400 dark:bg-zinc-600", audibilityKey: null, speakerName: "" },
  // The speaker button publishes into the play queue, which can only reach the
  // queue's OWN elements — so it belongs to this row only while the row is an
  // imported recording's dialogue. Stage 2: on a subtitle file this row draws
  // the audio VTT's cues, which are text and make no sound at all, and the
  // film's soundtrack is silenced from the video pane's own header instead
  // (see the gutter below, which withholds the button in that arrangement).
  "source-audio": { sub: "original speech", dot: "bg-sky-600", audibilityKey: "source", speakerName: "source audio" },
  // Emerald like the dub row beneath it — same side of the file — but pale, so
  // the two subtitle-shaped rows are never mistaken for each other at a glance.
  "target-subtitles": { sub: "text · translated", dot: "bg-emerald-300 dark:bg-emerald-800", audibilityKey: null, speakerName: "" },
  "target-audio": { sub: "takes · generated", dot: "bg-emerald-600", audibilityKey: "target", speakerName: "target audio" },
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
  onRequestLinkVideo,
  onAddLine,
  canAddLine,
  onRemoveLine,
  canLinkVideo = true,
  onRequestImportAudioVtt,
  canImportAudioVtt = true,
  hasAudioCueTrack = false,
  audioCues,
  onSeekToTime,
  onOpenRecording,
  initialSelectedCellId,
  onSelectedCellChange,
  onChipActivated,
  activateRequest,
  timingMode = "dubbing",
  onChangeTimingMode,
  hideTimingMode = false,
  project,
  onSelectCell,
  session,
  audioByCellId,
  legacyMeasure,
  tracks = DEFAULT_TRACKS,
}: TimelineEditorProps) {
  const audioFirst = timingMode === "audioFirst"
  const [pxPerSec, setPxPerSec] = useState(() => loadZoom(fileId))
  // Dismissal is per-visit on purpose: while unmeasured takes remain, the
  // notice returns next time the timeline mounts — quiet, but not forgotten.
  // It is keyed by FILE because this component is not remounted on a file
  // switch (same subtree, no key), so a bare boolean would have silenced the
  // notice for every other file in the session.
  const [measureDismissedFor, setMeasureDismissedFor] = useState<string | null>(null)
  const measureNoteDismissed = measureDismissedFor === fileId
  const online = useOnline()
  const batchProgress = useBatchProgress()
  // Stage 2: the queue's store is the single source of truth for muting, shared
  // with the video pane's header button. This is a read; every write goes
  // through toggleAudibility, which merges against the store.
  const audibility = useQueueAudibility()
  const [snapOn, setSnapOn] = useState(loadSnapEnabled)
  const audioQuality = useAudioQualityPref()
  // Seeded by the text→media trace (AQU-646 round 3): the seed alone opens
  // the detail pane and rings the card.
  const [selectedId, setSelectedId] = useState<string | null>(() => initialSelectedCellId ?? null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportPx, setViewportPx] = useState(0)
  const [follow, setFollow] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Programmatic scrolls stamp this; the onScroll handler treats scroll
   *  events within 150ms of a stamp as our own, not a user disengage. */
  const lastProgrammaticScrollAt = useRef(0)
  const clock = useTimelineClock()
  const chipStripSlot = useUiSlot("media-chip-strip")

  // AQU-646: bridge the audio play-queue into the timeline clock. Progress is
  // file-timeline seconds for imported media (one shared clip); the cellIdSet
  // guard keeps a stale singleton queue (playing another file) from hijacking
  // this timeline's playhead.
  const cellIdSet = useMemo(() => new Set(cells.map((c) => c.id)), [cells])
  // `queueRunning` (playing OR loading) exists because the readiness gate flips
  // playing→loading→playing at a cold verse boundary. `playing` stays STRICT
  // (the playhead's rAF interpolation must park during a gate — that's the
  // whole point), but the follow re-engage below keys on running, or every cold
  // boundary would re-yank a user who deliberately scrolled away mid-playback.
  const queue = useQueueForFile(cellIdSet)
  const queueProgress = queue.progress
  const { active: queueActive, playing: queuePlaying, running: queueRunning } = queue
  // Decision 2026-08-05: the verse being WAITED ON shows a small spinner on
  // its chip ("loading" is exactly the parked-gate/cold-load state and
  // carries the cellId), and a definitively 404'd dub shows a missing badge.
  const loadingCellId = queue.kind === "loading" ? queue.cellId : null
  const missingCellIds = useMissingClipCells()
  // 2026-08-11: the queue's progress is only a FILE position when the master
  // element is the shared source clip. On a take it is a per-take clock that
  // restarts at 0 — play-queue says outright that "no consumer may treat [it]
  // as a position on the file" — so writing it here yanked the playhead to
  // zero whenever a take was played from a row's rail. Same test the video
  // pane already makes (MediaVideoPane's `clockIsFileTime`).
  const queueSoundingCell = useMemo(
    () => (queue.cellId != null ? cells.find((c) => c.id === queue.cellId) : undefined),
    [cells, queue.cellId],
  )
  const queueClockIsFile = queueClockIsFileTime(queueSoundingCell)
  useEffect(() => {
    if (queueActive && queueClockIsFile) clock.setCurrentSec(queueProgress.currentTime)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock setters are stable
  }, [queueActive, queueClockIsFile, queueProgress.currentTime])
  // The other driver: a file with a linked video but NO audio can never start
  // the queue, so the video plays itself and owns the playhead. Strictly gated
  // on the queue being idle, so the two writers can never overlap — which is
  // exactly what used to happen when the <video> lived in this component.
  const videoClockSec = useVideoClockSec()
  const videoPlaying = useVideoClockPlaying()
  useEffect(() => {
    if (!queueActive && videoClockSec != null) clock.setCurrentSec(videoClockSec)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock setters are stable
  }, [queueActive, videoClockSec])
  // Whichever transport actually owns the clock. Parking (rather than merely
  // withholding seconds) matters: the playhead's rAF interpolation extrapolates
  // from its last anchor while `playing`, so leaving it running against a
  // position nobody updates draws steady, confident, wrong motion.
  const transportPlaying = queueActive ? queuePlaying && queueClockIsFile : videoPlaying
  const transportRate = queueActive ? queueProgress.rate : 1
  useEffect(() => {
    if (transportPlaying) clock.play()
    else clock.pause()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- clock setters are stable
  }, [transportPlaying])
  useEffect(() => {
    // Starting playback is an explicit "watch this" — re-engage follow. Keyed
    // on running (playing OR loading) so a gate's brief "loading" dip doesn't
    // count as a fresh start.
    //
    // Round 5: EITHER transport. This was queue-only, so on a file the picture
    // drives there was no rising edge to key on — once the user scrolled away
    // or jumped, follow was released for good and pressing play never took it
    // back. The follow SCROLL below was already video-aware; only its
    // re-engagement was not, which is why the track looked half-fixed.
    if (queueRunning || videoPlaying) setFollow(true)
  }, [queueRunning, videoPlaying])

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

  // Publish THIS FILE's persisted mute preference into the store. Keyed on the
  // file and on nothing else, deliberately: seeding on any other dependency
  // would read the disk copy back over a toggle made this session, and the
  // video pane seeds the same value on its own mount — see seedAudibility.
  useEffect(() => {
    seedAudibility(fileId)
  }, [fileId])

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

  function speakerToggle(track: keyof TrackAudibility, name: string) {
    const audible = audibility[track]
    return (
      <button
        type="button"
        data-testid={`tl-speaker-${track}`}
        aria-label={audible ? `Mute ${name}` : `Unmute ${name}`}
        aria-pressed={audible}
        title={audible ? `${name} is audible — click to mute` : `${name} is muted — click to unmute`}
        onClick={() => toggleAudibility(fileId, track)}
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
  // WHAT KIND OF FILE THIS IS — not what any row draws. Stage 2 killed the band
  // this flag was born for (it was `drawsSourceBand`) and kept every other
  // reader untouched, because not one of them was ever about the band: a VTT
  // timed against footage whose cells are ALL text, because deriveLanes fills
  // the dialogue lane from `medium: "media"` cells and a subtitle import makes
  // none.
  //
  // The first reader is the one that hurts. The layout's duration floor is the
  // only thing that makes the track reach the end of the FOOTAGE rather than
  // stopping after the last cue — on a 70-minute episode whose final subtitle
  // lands at 68:12, losing it makes the last four minutes unreachable on every
  // row at once, with nothing on screen to suggest they exist. It must never
  // become conditional on whether an audio VTT has been imported.
  const videoDurationSec = useVideoDurationSec(coreMediaUrl)
  const subtitleFileWithFootage = Boolean(coreMediaUrl) && dialogue.length === 0
  // SUB-53: the single answer to "where does this go on the track?". Dubbing
  // returns the pre-SUB-53 geometry verbatim; audio-first returns the laid-out
  // programme. Everything below reads positions through this.
  const layout = useMemo<TimelineLayout>(
    () => buildTimelineLayout(timingMode, cells, dialogue, subtitleFileWithFootage ? videoDurationSec : null),
    [timingMode, cells, dialogue, subtitleFileWithFootage, videoDurationSec],
  )
  // The TEXT cues' regions. NOTHING RENDERS THESE ANY MORE — the band they fed
  // is gone. They survive for `addableSpans` below, i.e. for the two places that
  // ask "is there a stretch of film here with no line on it": the pencil in the
  // Subtitles row and the mic in the Target audio row. Both are questions about
  // the TEXT, which is why this still sweeps `cells` and not the audio cues.
  const sourceRegions = useMemo(
    () => (subtitleFileWithFootage ? deriveSourceRegions(cells, videoDurationSec) : EMPTY_SOURCE_REGIONS),
    [subtitleFileWithFootage, cells, videoDurationSec],
  )
  // The Source-audio row's own map, from the hidden sibling's cues. Same sweep,
  // a different set of boundaries: the audio VTT transcribes the film's
  // soundtrack, so its cues are misaligned with the subtitle cues by nature (on
  // episode 101, 71 of them have no text partner at all).
  const audioRegions = useMemo(
    () => deriveSourceRegions(audioCues ?? [], videoDurationSec),
    [audioCues, videoDurationSec],
  )
  // A click on a silence in that row is SEEK-ONLY now. Round 8's other half —
  // `onRevealGap`, which scrolled the text table to the lines either side and
  // pulsed them — is gone with the band, and deliberately not reconnected: it
  // found those lines by matching the gap's exact start second against the TEXT
  // region map, and these gaps come from the AUDIO map, whose boundaries do not
  // coincide with it. It would usually match nothing, and when it did match it
  // would be flashing subtitle rows around a stretch where nobody SPOKE. Two
  // tracks, conflated. (EditorTable keeps its pulseCells API for other callers.)

  // AQU-646 round 8: in this workflow every cell is a text cell, so the header
  // read "Subtitle" and changed as you clicked around. Sam asked for it to stay
  // "Dialogue" for now — pinned, so it reads the same with a chip selected and
  // with none.
  const textHeadingLabel = subtitleFileWithFootage ? "Dialogue" : undefined

  // Stretches of film that no cell covers — where a line can still be added.
  // Derived from the same sweep the Source track draws, so the two can never
  // disagree about where there is room.
  //
  // Round 8, "no room, no add": the length floor is the SAME one the band uses
  // to decide whether a gap gets a chip. Without it, zooming past ~160px/s let
  // the pencil appear over a silence the row had declined to draw — an offer to
  // fill a stretch you cannot see. Both the pencil and the mic read this array,
  // so one filter covers both surfaces.
  const addableSpans = useMemo(
    () =>
      sourceRegions.regions
        .filter((r) => r.kind === "gap" && r.endSec - r.startSec >= MIN_ADDABLE_SPAN_SEC)
        .map((r) => ({ startSec: r.startSec, endSec: r.endSec })),
    [sourceRegions],
  )
  // Round 5: the Target-audio track's chips — one per section with dub audio.
  // AQU-646: in the VTT-plus-footage arrangement the takes hang off TEXT cells
  // — there are no media cells to hang them on — so the Target track resolves
  // them without the medium gate. Everywhere else it is exactly as before.
  const targetSource = subtitleFileWithFootage ? subtitle : dialogue
  const resolveTarget = subtitleFileWithFootage ? resolveTargetAudio : activeTargetForCell
  const targetItems = useMemo<TargetAudioItem[]>(
    () =>
      targetSource.flatMap((c) => {
        const target = resolveTarget(c)
        return target ? [{ cell: c, kind: target.kind, audioId: target.audioId }] : []
      }),
    [targetSource, resolveTarget],
  )
  // SUB-51: the complement — sections still waiting for a dub. Their empty
  // space in the Target row offers a record button on hover.
  const emptyTargets = useMemo(
    () => targetSource.filter((c) => !resolveTarget(c)),
    [targetSource, resolveTarget],
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
  // 2026-08-07: the chip strip describes the CURRENT chip — an explicit
  // selection wins; with nothing selected it follows the cell the queue is
  // sounding (or holds while paused); after the queue goes idle it keeps the
  // last one so the strip doesn't blank out mid-thought. Same file guard as the
  // playhead: a stale singleton queue never fills this file's strip.
  const soundingId = queueActive ? queue.cellId : null
  const [lastTouchedId, setLastTouchedId] = useState<string | null>(null)
  useEffect(() => {
    const id = selectedId ?? soundingId
    if (id) setLastTouchedId(id)
  }, [selectedId, soundingId])
  // 2026-08-08 (Sam): an AUTOMATIC playback advance clears the selection —
  // one pointer, one moving light. EDGE-triggered on the sounding cell's
  // transitions: only when the queue moves from A to B (both non-null) and
  // the departed A was the selected cell does the selection drop. A fresh
  // click-then-jump is race-proof by construction (its selection ≠ the
  // departed cell), untimed selections survive (they never sound), and
  // pause/idle produce no transition, so nothing clears.
  const prevSoundingRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevSoundingRef.current
    prevSoundingRef.current = soundingId
    if (prev == null || soundingId == null || soundingId === prev) return
    setSelectedId((sel) => (sel === prev ? null : sel))
  }, [soundingId])
  const currentCellId = selectedId ?? soundingId ?? lastTouchedId
  const currentCell = useMemo(
    () => cells.find((c) => c.id === currentCellId) ?? null,
    [cells, currentCellId],
  )
  // Meeting note (2026-08-05): the detail readout carries the dub's own
  // numbers — its range, its duration, and ALWAYS the end-to-end difference
  // (original end − dub end). 2026-08-06 (Sam): the diff is INFORMATIONAL (a
  // difference can be intentional) — chip-vs-chip OVERLAP is the warning, a
  // separate number computed with the same trespasser gating the lane uses.
  // Dubbing only, and never from a guessed width (SUB-48).
  const currentChipStats = useMemo(() => {
    if (!currentCell) return null
    // Free timing (2026-08-06, Sam): the file-clock RANGES are meaningless
    // against the re-flowed track — the only honest numbers are durations.
    // Src = the original's window length, Tgt = the dub's measured length.
    if (audioFirst) {
      const { startTime, endTime } = currentCell
      const srcDurationSec =
        typeof startTime === "number" && typeof endTime === "number" ? endTime - startTime : null
      const item = targetItems.find((t) => t.cell.id === currentCell.id)
      const geom = item ? layout.targetGeom(item.cell, item.cell.attachments?.[item.audioId]) : null
      const tgtDurationSec = geom && !geom.usingFallback ? geom.end - geom.start : null
      if (srcDurationSec == null && tgtDurationSec == null) return null
      return { kind: "free" as const, srcDurationSec, tgtDurationSec }
    }
    const i = targetItems.findIndex((t) => t.cell.id === currentCell.id)
    if (i < 0) return null
    const geomOf = (t: (typeof targetItems)[number] | undefined) =>
      t ? layout.targetGeom(t.cell, t.cell.attachments?.[t.audioId]) : null
    const geom = geomOf(targetItems[i])
    if (!geom || geom.usingFallback) return null
    const { startTime, endTime } = currentCell
    const prev = geomOf(targetItems[i - 1])
    const next = geomOf(targetItems[i + 1])
    const { headSec, tailSec } = chipOverlaps(
      { start: geom.start, end: geom.end },
      prev ? { start: prev.start, end: prev.end } : null,
      next?.start ?? null,
    )
    // Blame the trespasser (same rule as the chip): only territory THIS chip
    // left its own section to claim counts toward its overlap number. The
    // head half also depends on the PREVIOUS chip's end, so it is masked when
    // that width is a guess (SUB-48 — same mask the lane applies).
    // 2026-08-08 (Sam): the two halves stay SEPARATE — a chip that spills at
    // both ends reads as two labeled numbers, not one meaningless sum.
    const tailTrespass = tailSec != null && typeof endTime === "number" && geom.end > endTime ? tailSec : 0
    const headTrespass =
      headSec != null && !prev?.usingFallback && typeof startTime === "number" && geom.start < startTime
        ? headSec
        : 0
    // 2026-08-08 (Sam): Diff is the whole DURATION difference now. The old
    // end-only number missed a target that also starts before its verse:
    // start + end diffs sum to (source duration − target duration), positive
    // exactly when the target is shorter. The halves survive in the hover.
    const startDiffSec = typeof startTime === "number" ? geom.start - startTime : null
    const endDiffSec = typeof endTime === "number" ? endTime - geom.end : null
    return {
      kind: "dubbing" as const,
      startSec: geom.start,
      endSec: geom.end,
      durationSec: geom.end - geom.start,
      startDiffSec,
      endDiffSec,
      durationDiffSec: startDiffSec != null && endDiffSec != null ? startDiffSec + endDiffSec : null,
      headOverlapSec: headTrespass > 0 ? headTrespass : null,
      tailOverlapSec: tailTrespass > 0 ? tailTrespass : null,
    }
  }, [audioFirst, currentCell, targetItems, layout])
  const currentClipAudio = useMemo(
    () => (currentCellId ? resolveEntryAudio(audioByCellId?.get(currentCellId)) : null),
    [audioByCellId, currentCellId],
  )
  const audioMissing = useClipAudioMissing({
    audio: currentClipAudio,
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
      // Round 5: a video-driven follow keeps its anchor too — zooming used to
      // recentre on the viewport middle instead of the playhead.
      const followAnchor = follow && (queueActive || videoPlaying)
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
    // AQU-646: explicit seeks drive the audio queue too, and re-engage follow.
    // The linked video rides along on this same call — the workspace stamps a
    // seek for the pane before deciding what the queue can do with it, because
    // the queue legitimately drops some seeks (no session, a gap no section
    // owns) and the picture must move regardless.
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

  // Center the track on a clip and cue playback (paused) at its start —
  // identical to a clean card click. Reads the live clientWidth (viewportPx
  // state can still be 0 pre-measurement). Untimed cells: no timecode, no-op.
  function centerAndCue(cellId: string) {
    const cell = cells.find((c) => c.id === cellId)
    const at = cell ? layout.seekSecFor(cell) : null
    if (at == null) return
    const viewport = scrollRef.current?.clientWidth ?? 0
    scrollTrackTo(Math.max(0, secToPx(at, pxPerSec) - viewport / 2))
    seekTo(at)
  }

  // AQU-646 round 3: consume the text→media trace once on mount (the seed
  // alone already selected the cell via the useState initializer).
  useEffect(() => {
    if (initialSelectedCellId) centerAndCue(initialSelectedCellId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only trace consume
  }, [])

  // 2026-08-07 (wire b): a text-table row click arrives as an activate
  // request — select the chip and center/cue exactly like a chip click, but
  // through the PLAIN setter: onChipActivated must not echo back and scroll-
  // yank the row the user just clicked.
  useEffect(() => {
    if (!activateRequest) return
    setSelectedId(activateRequest.cellId)
    centerAndCue(activateRequest.cellId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- consumed per nonce
  }, [activateRequest?.nonce])

  // 2026-08-07: publish the timeline's presence + chip selection to the media
  // cursor store — the table's rows highlight the pointed-at cell through it.
  useEffect(() => {
    setMediaSyncActive(true)
    return () => setMediaSyncActive(false)
  }, [])
  useEffect(() => {
    setMediaCursorCell(selectedId)
  }, [selectedId])

  // AQU-646 follow-playhead: page-flip the view when the playhead approaches
  // the right edge (or leaves the left). Reads the element's live scrollLeft —
  // state can lag a programmatic scroll by a frame.
  // 2026-08-11: reads the CLOCK, not the queue's progress. A linked video with
  // no audio never starts the queue, so this used to sit out the entire film —
  // and it is the only thing that scrolls a track which, on a 70-minute
  // episode, is roughly 160,000px wide.
  useEffect(() => {
    if (!follow || !transportPlaying) return
    const el = scrollRef.current
    if (!el) return
    const target = computeFollowScroll(
      secToPx(clock.currentSec, pxPerSec),
      el.scrollLeft,
      viewportPx,
      trackWidthPx,
    )
    if (target != null) scrollTrackTo(target)
  }, [follow, transportPlaying, clock.currentSec, pxPerSec, viewportPx, trackWidthPx])

  // 2026-08-07 (wire a): USER chip selection — as opposed to programmatic
  // selection from a row click — also notifies the workspace so the text
  // table scrolls to and flashes the matching row.
  const selectFromChip = (cellId: string) => {
    setSelectedId(cellId)
    onChipActivated?.(cellId)
  }

  const laneProps = {
    layout,
    pxPerSec,
    viewStartSec,
    viewEndSec,
    selectedId,
    editable,
    onSelect: selectFromChip,
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

  // The Source-audio row needs its OWN resolver: `laneProps.onSeek` looks the id
  // up in THIS FILE's cells, and an audio cue is not one of them — it belongs to
  // the hidden sibling — so every chip on that row would be a dead click. The
  // layout is not consulted either: a cue's second is a second of the film, and
  // the only mode this row appears in draws the film's clock verbatim.
  const seekAudioCue = (cellId: string) => {
    const cue = audioCues?.find((c) => c.id === cellId)
    if (cue && typeof cue.startTime === "number" && Number.isFinite(cue.startTime)) seekTo(cue.startTime)
  }

  // One row of the track column. Declared HERE, in the component body, because
  // it reads the lanes, the layout, the zoom window, the snap flag and every
  // handler above — hoisting it to module scope would mean threading twenty
  // reactive values through a parameter object, and the first one anybody
  // forgot to pass would be a lane that quietly stopped updating.
  function laneForTrack(track: TimelineTrack): ReactNode {
    switch (track.kind) {
      case "source-subtitles":
        // SUB-53: a subtitle span is expressed against the original's clock,
        // so it can't be dragged on a re-flowed track.
        return (
          <TimelineLane
            key={track.id}
            cells={subtitle}
            variant="subtitle"
            retimable={!audioFirst}
            // AQU-646 round 8: an imported VTT cue is frozen. Its timing is
            // the file's, not ours to nudge — arguing for the VTT's integrity
            // while letting anyone drag its cues is incoherent (Sam,
            // 2026-08-11). A line someone added here still moves, bounded by
            // its neighbours. Only this arrangement passes the predicate, so
            // SUB-36's deliberately draggable subtitle mirror is untouched —
            // and cannot collide with it anyway, since that mirror exists
            // only when there ARE dialogue cells and this predicate needs
            // there to be none.
            canRetimeCell={subtitleFileWithFootage ? isUserAddedLine : undefined}
            // ...and the line it may move within is the space its neighbours
            // leave it. Only here: SUB-36's media-subtitle card is meant to
            // sit wherever it likes, so this must never be on by default.
            boundNeighbours={subtitleFileWithFootage}
            snapEnabled={snapOn}
            {...laneProps}
            // AQU-646: the stretches of film with no line of their own. Only
            // this arrangement offers them — everywhere else the lane is
            // exactly as it was.
            emptySpans={addableSpans}
            onAddLine={canAddLine && onAddLine ? (s, e) => void onAddLine(s, e) : undefined}
            // Only a line someone added here, and only while it is still
            // empty — deleting a cell with takes or comments on it would
            // leave every one of them behind.
            canRemove={subtitleFileWithFootage && canAddLine ? (c) => isUserAddedLine(c) && isLineEmpty(c) : undefined}
            onRemove={onRemoveLine}
          />
        )
      case "source-audio":
        // Two tenants, and which one shows up is decided by the CELLS, never by
        // whether a video is linked. An imported recording's dialogue lane,
        // whose source split is FROZEN at import and never retimable (round 6);
        // or, when there are no media cells at all, the audio VTT's cues —
        // transcript chips over the film's own speech, with a dashed empty chip
        // across each stretch where nobody talks.
        return dialogue.length > 0 ? (
          <TimelineLane key={track.id} cells={dialogue} variant="dialogue" retimable={false} {...laneProps} />
        ) : (
          <SourceRegionLane
            key={track.id}
            map={audioRegions}
            cells={audioCues ?? []}
            pxPerSec={pxPerSec}
            viewStartSec={viewStartSec}
            viewEndSec={viewEndSec}
            selectedId={selectedId}
            editable={editable}
            // AUDIO CHIPS SEEK, BUT THEY DO NOT SELECT. Selection means "this is
            // the current chip", and all three things it drives — the detail
            // readout, the media cursor, and `onChipActivated`, which scrolls
            // the text table to the matching row — are TEXT-cell surfaces. An
            // audio cue has no row in any of them, so selecting one would blank
            // the readout and scroll the table to nothing. The chip's job is to
            // take you to that second of the film, and it still does.
            onSelect={() => {}}
            onSeek={seekAudioCue}
            onSeekSec={seekTo}
          />
        )
      case "target-subtitles":
        // The translation of each cue, at the cue's own timings — the same
        // cells as the Subtitles row above, showing their other side (see
        // TimelineCard's labelText). Frozen: moving a translation would mean
        // moving the cue, which is the source row's timing and not ours.
        return (
          <TimelineLane key={track.id} cells={subtitle} variant="target-subtitle" retimable={false} {...laneProps} />
        )
      case "target-audio":
        return (
          <TargetAudioLane
            key={track.id}
            items={targetItems}
            layout={layout}
            pxPerSec={pxPerSec}
            viewStartSec={viewStartSec}
            viewEndSec={viewEndSec}
            selectedId={selectedId}
            loadingCellId={loadingCellId}
            missingCellIds={missingCellIds}
            editable={editable}
            snapEnabled={snapOn && !audioFirst}
            onSelect={selectFromChip}
            onSeek={laneProps.onSeek}
            // SUB-53: a chip's position is computed in audio-first, so there
            // is nothing to drag it to. Trimming stays — and re-flows.
            onRetimeTarget={audioFirst ? undefined : onRetimeTarget}
            onTrimTarget={onTrimTarget}
            onOpenRecording={onOpenRecording}
            emptyCells={emptyTargets}
            // AQU-646: the mic over a stretch with no cell at all creates the
            // blank line first, then opens the recorder — same line the "T"
            // above would have made.
            emptySpans={addableSpans}
            onAddLineAndRecord={
              canAddLine && onAddLine ? (s, e) => void onAddLine(s, e, { thenRecord: true }) : undefined
            }
          />
        )
    }
  }

  return (
    // 2026-08-07: intrinsic height — the editor stacks above the text table
    // in a shrink-0 wrapper now, so it must not claim the full column.
    <div data-testid="tl-editor" className="flex min-h-0 flex-col">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">Timeline</span>
        {/* Pre-merge round: the mode is FILE-level again (the video link it
            interacts with is per-file), so the control returns to the
            toolbar. Same clearance as before: `onChangeTimingMode` absent =
            below the maintainer floor = the active mode renders as a plain
            label instead of buttons. The wrapper keeps its testid +
            data-mode so browser passes read the mode exactly as before.
            AQU-646 stage 1: withheld outright for a file with only one mode
            available to it — see `hideTimingMode`. */}
        {!hideTimingMode && (
          <div
            data-testid="tl-timing-mode"
            data-mode={timingMode}
            className="ml-2 inline-flex items-center overflow-hidden rounded-md border border-border text-[11px]"
          >
            {(["dubbing", "audioFirst"] as const).map((mode) =>
              onChangeTimingMode ? (
                <button
                  key={mode}
                  type="button"
                  data-testid={`tl-timing-mode-${mode}`}
                  aria-pressed={timingMode === mode}
                  title={AUDIO_TIMING_MODE_LABELS[mode].description}
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
                  {AUDIO_TIMING_MODE_LABELS[mode].name}
                </button>
              ) : timingMode === mode ? (
                <span
                  key={mode}
                  data-testid={`tl-timing-mode-${mode}`}
                  title={`${AUDIO_TIMING_MODE_LABELS[mode].description} Only a maintainer can change this.`}
                  className="px-2 py-1 text-foreground/70"
                >
                  {AUDIO_TIMING_MODE_LABELS[mode].name}
                </span>
              ) : null,
            )}
          </div>
        )}
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
          {onRequestLinkVideo && (
            <AppTooltip content="Requires at least contributor access" disabled={canLinkVideo}>
              <button
                type="button"
                data-testid="tl-link-video"
                disabled={!canLinkVideo}
                onClick={onRequestLinkVideo}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground/80 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Film className="h-3.5 w-3.5 text-muted-foreground" />
                {coreMediaUrl ? "Change video" : "Link video"}
              </button>
            </AppTooltip>
          )}
          {/* AQU-646 stage 2: the audio VTT — a near-verbatim transcript of the
              film's own speech, ~550 cues, which becomes the Source audio row.
              It lands in a hidden sibling file, so this never adds anything to
              the file list, the dialogue table or the counters. */}
          {onRequestImportAudioVtt && (
            <AppTooltip content="Requires project lead access" disabled={canImportAudioVtt}>
              <button
                type="button"
                data-testid="tl-import-audio-vtt"
                disabled={!canImportAudioVtt}
                onClick={onRequestImportAudioVtt}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground/80 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                <AudioLines className="h-3.5 w-3.5 text-muted-foreground" />
                {hasAudioCueTrack ? "Replace audio VTT" : "Import audio VTT"}
              </button>
            </AppTooltip>
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

      {/* SUB-53: a video runs on the original recording's clock, so it cannot
          follow a re-flowed track — say so rather than let it drift silently
          against the audio. In Original's timing the video renders beside the
          text table instead (MediaVideoPane), which is why only the note is
          left here. */}
      {coreMediaUrl && audioFirst && (
        <div
          data-testid="tl-video-hidden-note"
          className="border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          The linked video is hidden here — it plays on the original recording's timing, which this view no longer follows.
        </div>
      )}

      {/* Pre-merge round: recordings from before duration capture have no
          measured length — their chips draw at guessed widths, and Free
          timing cannot lay them out. The fix is deliberate (a button), never
          silent: measuring downloads and decodes each recording, then saves
          only the length. */}
      {legacyMeasure && legacyMeasure.count > 0 && !measureNoteDismissed && (
        <div
          data-testid="tl-measure-note"
          className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1">
            {legacyMeasure.count === 1
              ? "1 recording has no measured length — its chip is drawn at a guessed width."
              : `${legacyMeasure.count} recordings have no measured length — their chips are drawn at guessed widths.`}
          </span>
          <AppTooltip
            content={
              !online
                ? "Measuring downloads each recording — connect to the internet first."
                : batchProgress != null
                  ? "Another batch is running — wait for it to finish."
                  : "Download each recording, measure its real length, and fix the chips. Nothing else about the takes changes."
            }
          >
            <button
              type="button"
              data-testid="tl-measure-run"
              disabled={!online || batchProgress != null}
              onClick={legacyMeasure.onMeasure}
              className="rounded border border-border bg-background px-2 py-0.5 font-medium text-foreground/80 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              Measure now
            </button>
          </AppTooltip>
          <button
            type="button"
            aria-label="Dismiss for now"
            data-testid="tl-measure-dismiss"
            onClick={() => setMeasureDismissedFor(fileId)}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* timeline */}
      <div className="grid min-h-0 grid-cols-[128px_1fr]">
        <div className="border-r border-border bg-muted/20">
          <div className="h-7 border-b border-border" />
          {/* The gutter is the track list, exactly as the lanes beside it are —
              one row here per row there, in the same order, off the same
              array. `name` comes from the track and not from the kind, which
              is the whole seam a rename arrives through. */}
          {tracks.map((track) => {
            const render = TRACK_RENDER[track.kind]
            // Stage 2: EXACTLY ONE source-mute control on screen, whatever the
            // arrangement. The film's mute now lives on the film itself (the
            // video pane's header), and this button can only reach the play
            // queue's own elements — which exist only for a file with media
            // cells. So a dubbing file keeps its gutter speaker and this one
            // loses it, rather than showing two buttons for the same sound or
            // (worse) one that silences nothing.
            const speaker =
              render.audibilityKey === "source" && subtitleFileWithFootage ? null : render.audibilityKey
            return (
              <LaneLabel
                key={track.id}
                name={track.name}
                sub={render.sub}
                dot={render.dot}
                trailing={speaker ? speakerToggle(speaker, render.speakerName) : undefined}
              />
            )
          })}
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
            if (transportPlaying && performance.now() - lastProgrammaticScrollAt.current > 150) {
              setFollow(false)
            }
          }}
        >
          <div className="relative" style={{ width: `${trackWidthPx}px` }}>
            <TimelineRuler
              durationSec={durationSec}
              pxPerSec={pxPerSec}
              viewStartSec={viewStartSec}
              viewEndSec={viewEndSec}
              onScrub={seekTo}
            />
            {tracks.map(laneForTrack)}
            {untimed.length > 0 && (
              <div className="flex h-12 items-center gap-2 overflow-x-auto border-b border-border px-3">
                {untimed.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    data-testid={`tl-untimed-${c.id}`}
                    onClick={() => selectFromChip(c.id)}
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
              playing={transportPlaying}
              rate={transportRate}
            />
          </div>
        </div>
      </div>

      {/* 2026-08-08 (Sam): the NUMBERS stay with the timeline — they measure
          the chips above, not the dialogue below — and close this section off
          at its bottom edge. */}
      <TimelineTimingRow cell={currentCell} chipStats={currentChipStats} audioMissing={audioMissing} />
      {/* The section label, the line's own context and the segment navigator
          head the TEXT column of the band below, opposite the Video header.
          The slot is owned by the workspace; portal when it exists, render
          inline when this editor is mounted alone (tests). */}
      {chipStripSlot
        ? createPortal(<MediaTextHeader cell={currentCell} headingLabel={textHeadingLabel} />, chipStripSlot)
        : <MediaTextHeader cell={currentCell} headingLabel={textHeadingLabel} />}
    </div>
  )
}
