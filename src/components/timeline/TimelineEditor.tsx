// The timeline editor: composes the lanes, ruler, playhead and chip strip into
// the top of the Media-lens surface. Owns zoom (persisted per file), horizontal
// scroll/windowing, and selection. Hand-rolled, with no media dependency of its
// own — the play queue is the master clock, and the linked video lives beside
// the text table as MediaVideoPane (AQU-646).

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import {
  AudioLines,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardCheck,
  Film,
  FolderInput,
  GripVertical,
  Link2,
  LocateFixed,
  Magnet,
  Minus,
  Plus,
  Users,
  Volume2,
  LockOpen,
  VolumeX,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { deriveLanes } from "@/lib/timeline/lanes"
import { deriveSourceRegions, EMPTY_SOURCE_REGIONS } from "@/lib/timeline/source-regions"
import { isLineEmpty, isUserAddedLine } from "@/lib/timeline/user-lines"
import { Spinner } from "@/components/ui/spinner"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import { SourceRegionLane } from "./SourceRegionLane"
import type { LaneLinkOverlay } from "./CueLinkOverlay"
import { CueLinkConfirmDialog } from "./CueLinkConfirmDialog"
import { EMPTY_CUE_LINK_INDEX, type CueLinkIndex } from "@/lib/sync/cell-links-read"
import { chipOverlaps, MIN_ADDABLE_SPAN_SEC } from "@/lib/timeline/lane-timing"
import { resolveCueCharacter, formatCueCharacter } from "@/lib/timeline/cue-character"
import { buildTimelineLayout, type TimelineLayout } from "@/lib/timeline/layout"
import { deriveTracksForFile, type TimelineTrack, type TrackKind } from "@/lib/timeline/tracks"
import { computeFollowScroll } from "@/lib/timeline/follow"
import { secToPx, pxToSec, ZOOM_MIN, ZOOM_MAX, ZOOM_DEFAULT } from "@/lib/timeline/scale"
import {
  chipHeightPx,
  chipPadPx,
  clampRowHeight,
  MIN_LABEL_SUB_H_PX,
  MIN_SPEAKER_FULL_H_PX,
  ROW_H_DEFAULT,
  ROW_H_MAX,
  ROW_H_MIN,
  TL_ROW_H_CLASS,
} from "@/lib/timeline/row-metrics"
import { orderForDrop, proposeDropIndex, type RowBound } from "@/lib/timeline/track-reorder"
import { RowMetricsContext, useRowMetrics, type RowMetrics } from "./useRowMetrics"
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
import { resolveTargetAudio } from "@/lib/audio/track-audio"
import { loadSnapEnabled, saveSnapEnabled } from "@/lib/timeline/snap"
import { setMediaCursorCell, setMediaSyncActive } from "@/lib/timeline/media-cursor"
import { useVideoClockSec, useVideoClockPlaying } from "@/lib/timeline/video-clock"
import { useVideoDurationSec } from "@/lib/timeline/video-duration"
import { useUiSlot } from "@/lib/ui-slots"
import { setAudioQualityPref, useAudioQualityPref } from "@/lib/store/audio-quality-pref"
import { useBatchProgress, canTranscribeCell } from "@/lib/audio/batch-audio"
import { useOnline } from "@/hooks/useOnline"
import { TimelineRuler } from "./TimelineRuler"
import { TimelineLane } from "./TimelineLane"
import { TargetAudioLane, type TargetAudioItem } from "./TargetAudioLane"
import { TimelinePlayhead } from "./TimelinePlayhead"
import { MediaTextHeader, TimelineTimingRow } from "./TimelineChipStrip"
import { TimelineTranscribeBar } from "./TimelineTranscribeBar"
import { applySelect, selectedIdsInOrder, type SelectMods } from "./selection"
import { useTimelineClock } from "./useTimelineClock"
import { resolveEntryAudio, useClipAudioMissing } from "./useClipAudioMissing"
import type { CellData } from "@/hooks/useCells"
import { type AudioTimingMode, type ProjectRecord } from "@/lib/parsers/types"
import type { FrontierSession } from "@/lib/frontier/types"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

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
  /**
   * AQU-646: the project's timing lock. When on, every imported row and cue is
   * frozen for everyone — including project leads, which Sam asked for
   * explicitly. Lines someone added here are exempt: they carry no imported
   * timing to corrupt.
   *
   * Absent reads as LOCKED at the call site, not here, so a project whose
   * settings have not arrived does not flash the handles up and then take
   * them away.
   */
  timingLocked?: boolean
  /** Round 6/7: move a section's dub chip — its clip-zero anchor (file sec). */
  onRetimeTarget?(cellId: string, anchorSec: number): void
  /** Matt's QA (2026-08-21): a drag on an AUDIO-CUE chip, final bounds in
   *  seconds, fired once on pointer-up. The workspace commits it as
   *  `cell.retime` against the hidden sibling — the same event a re-import's
   *  reconcile emits. Offered only while the project's timings are unlocked;
   *  absent leaves the Source-audio row frozen exactly as it always was. */
  onRetimeCue?(cellId: string, startSec: number, endSec: number): void
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
  /**
   * May this user add and remove cells here at all?
   *
   * AQU-1068 collapsed the old MAY/SHOULD pair into one answer. There used to
   * be a second `allowLineCreation` prop carrying the project's policy, kept
   * separate so that switching policy off could not strand a line somebody had
   * already made. The tier that replaced it governs adds and removes together
   * — "that setting is enabling lines being added or removed" — so a single
   * authority is now the thing that keeps the surfaces agreeing.
   */
  canAddLine?: boolean
  /**
   * May they remove an IMPORTED cell, not just a line added here?
   *
   * The second gate, maintainer-only, whatever tier the project runs. An
   * imported line is the client's own work; the confirmation dialog upstream
   * is what makes taking one back safe.
   */
  canRemoveImportedCells?: boolean
  /** Take back a line someone added, while it is still empty. */
  onRemoveLine?(cellId: string): void
  /** False disables the control — `file.video.set` needs contributor access,
   *  and the emit throws rather than failing quietly. */
  canLinkVideo?: boolean
  /** AQU-646 stage 2: open the audio-VTT import dialog. It lives up in the
   *  workspace for the same reason the link-video one does — it owns the upload
   *  and the refresh. Presence renders the control. */
  onRequestImportAudioVtt?(): void
  /** AQU-646 stage 6: the character spreadsheet. */
  onRequestImportCharacters?(): void
  canImportCharacters?: boolean
  /** How many cells already carry a cast name — the Characters row's state. */
  characterCount?: number
  /** How many HEARD lines carry a character — the audio sheet's own count. */
  audioCharacterCount?: number
  /** A character write is in flight — hundreds of events, so the row says so
   *  rather than showing a count that is about to change. */
  charactersWriting?: boolean
  /** Links where the two character sheets contradict each other. Non-zero puts
   *  an amber count on the Characters row: two independent opinions disagreeing
   *  is the one signal neither sheet can give on its own. */
  characterDisagreements?: number
  /** Open the list of those disagreements. */
  onReviewCharacterDisagreements?(): void
  /**
   * May this person use the CHECK tools at all?
   *
   * Reviewing pairings and settling character disagreements is setup work that
   * happens BEFORE a file is handed to translators and dubbers — and they are
   * exactly the contributors who should not be re-deciding it afterwards. The
   * client's own producer sets the projects up, so she clears this; a
   * contributor does not. (Sam, 2026-08-18.)
   *
   * Absent ⇒ allowed, so every existing caller and test is unaffected.
   */
  canCheck?: boolean
  /**
   * Stage 4: the cells that CARRY TARGET AUDIO, when that is not this file's
   * own cells — the audio cues, merged with their attachments.
   *
   * A subtitle line performed as two heard lines needs two takes, and
   * `cell_audio.selected` is per (cell, slot), so the takes have to hang on the
   * cues. Absent ⇒ the historic arrangement, takes on this file's cells.
   */
  targetCells?: CellData[] | null
  /** Linking mode turned on or off here. The workspace opens its review
   *  drawer in step, so the drawer being open IS the mode. */
  onLinkingModeChange?(on: boolean): void
  /** Push the mode from outside — the drawer's own close button. Nonce-keyed
   *  like `activateRequest`, so setting it to the same value twice still
   *  fires. */
  linkingModeRequest?: { on: boolean; nonce: number }
  /** An audio cue chip was selected. Separate from `onChipActivated`, which
   *  scrolls the dialogue table BY CELL ID — a cue has no row there, so it
   *  reaches the table through its links instead. */
  onCueActivated?(cueCellId: string): void
  /** Stage 4: which subtitle line each heard line performs. Empty until an
   *  audio VTT has been imported and the auto-linker has run. */
  cueLinks?: CueLinkIndex
  /** The auto-linker is writing pairings right now — several hundred events,
   *  a few seconds. Without a sign of life the row looks like a matcher that
   *  did nothing rather than one still working. */
  cueLinksPending?: boolean
  /** The links READ failed — which must render differently from "no links":
   *  when we couldn't ask, we don't know what is linked, and painting every
   *  chip as an orphan would state a fact nobody has. */
  cueLinksFailed?: boolean
  /** Add or remove one pairing. Absent ⇒ linking mode is not offered at all. */
  onToggleCueLink?(textCellId: string, cueCellId: string, linked: boolean): void
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
  /**
   * Was this file imported as subtitles (VTT/SRT/SBV)?
   *
   * Only the workspace can answer it — the file's type does not otherwise
   * reach this component — and it decides one thing here: what the text
   * column under the timeline is called. See `textHeadingLabel`.
   */
  isSubtitleImport?: boolean
  /** Needed by the missing-audio probe behind the chip strip's badge. */
  project?: ProjectRecord
  /** Fires when the highlighted section changes so a sibling transport (the
   *  bottom playback bar) can start playback from the selected section. */
  onSelectCell?(cellId: string | null): void
  /** AQU-928: run transcription over exactly these sections. Present = the
   *  media view shows its section-scoped transcribe row; absent (read-only
   *  users, focused unit tests) = no row at all, since the run would emit
   *  events the server would reject. */
  onTranscribeSections?(cellIds: string[]): void
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
  /**
   * AQU-646 stage 3: give one track a new sort key, because the user dragged
   * its name up or down the gutter (or pressed Alt+Arrow on it). The order is
   * PROJECT-WIDE — the workspace persists it with `file.track.set` — so this is
   * a write, not a view preference, and the number is a SORT KEY: fractional
   * and negative values are normal, and only the named track changes.
   *
   * ABSENT IS THE PERMISSION GATE, and it withholds the whole affordance: no
   * pointerdown handler, no grip, no grab cursor, no tab stop. Rendering a
   * draggable-looking row that mints a 403 on release is the same lie
   * `hideTimingMode` was added to stop telling — a control you cannot use is
   * worse than no control, because you have to try it to find out.
   */
  onReorderTrack?(trackId: string, order: number): void
}

/** The default prop, resolved ONCE. A `deriveTracksForFile(null)` call in the
 *  parameter list would hand every render a new array and churn every memo
 *  downstream of it. */
const DEFAULT_TRACKS = deriveTracksForFile(null)

/** The timing modes' user-facing copy, per mode.
 *
 *  `AUDIO_TIMING_MODE_LABELS` (lib/parsers/types) resolves the same
 *  `editor.timeline.timingMode*` name/description keys for
 *  TimingModeChangedDialog; this table adds `lockedDescription` — the same
 *  sentence plus the below-maintainer note, kept whole rather than
 *  concatenated, because a `{mode}` frame filled with a translated noun
 *  cannot be made grammatical in every locale. */
const TIMING_MODE_KEYS: Record<
  AudioTimingMode,
  { name: MessageKey; description: MessageKey; lockedDescription: MessageKey }
> = {
  dubbing: {
    name: "editor.timeline.timingModeDubbing",
    description: "editor.timeline.timingModeDubbingHint",
    lockedDescription: "editor.timeline.timingModeDubbingHintLocked",
  },
  audioFirst: {
    name: "editor.timeline.timingModeFree",
    description: "editor.timeline.timingModeFreeHint",
    lockedDescription: "editor.timeline.timingModeFreeHintLocked",
  },
}

/** Each audio track's speaker-button copy. Whole sentences per track, not one
 *  frame per state with the track's name poured in — the name inflects. */
const SPEAKER_TOGGLE_KEYS: Record<
  keyof TrackAudibility,
  { mute: MessageKey; unmute: MessageKey; audibleTitle: MessageKey; mutedTitle: MessageKey }
> = {
  source: {
    mute: "editor.timeline.muteSourceAudio",
    unmute: "editor.timeline.unmuteSourceAudio",
    audibleTitle: "editor.timeline.sourceAudioAudible",
    mutedTitle: "editor.timeline.sourceAudioMuted",
  },
  target: {
    mute: "editor.timeline.muteTargetAudio",
    unmute: "editor.timeline.unmuteTargetAudio",
    audibleTitle: "editor.timeline.targetAudioAudible",
    mutedTitle: "editor.timeline.targetAudioMuted",
  },
}

const zoomKey = (fileId: string) => `aquilla:timelineZoom:${fileId}`

function loadZoom(fileId: string): number {
  try {
    const v = Number(localStorage.getItem(zoomKey(fileId)))
    return Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX ? v : ZOOM_DEFAULT
  } catch {
    return ZOOM_DEFAULT
  }
}

const rowHeightKey = (fileId: string) => `aquilla:timelineRowHeight:${fileId}`

/**
 * Stage 3's vertical zoom, remembered PER FILE exactly as the horizontal one is
 * (Sam's call): a four-row episode and a two-row dubbing file want different
 * heights, and one global setting would have each visit undo the other.
 *
 * Clamped on the way in as well as on the way out. The stored number is written
 * by whatever build the user last opened this file in, and a value from a wider
 * range — or a fractional one — would blur every `border-b` down the timeline
 * (see `clampRowHeight`).
 */
function loadRowHeight(fileId: string): number {
  try {
    const v = Number(localStorage.getItem(rowHeightKey(fileId)))
    return Number.isFinite(v) && v >= ROW_H_MIN && v <= ROW_H_MAX ? clampRowHeight(v) : ROW_H_DEFAULT
  } catch {
    return ROW_H_DEFAULT
  }
}

/**
 * Everything a gutter row needs to be DRAGGED, or undefined for a user who may
 * not reorder tracks — in which case the row renders exactly the DOM it always
 * has. See `onReorderTrack` for why the gate is all-or-nothing.
 */
interface LaneLabelReorder {
  trackId: string
  /** How far this row is currently lifted, in px; null unless it is the one
   *  under the pointer. Raw pointer delta — no rAF, no easing (TimelineCard's
   *  drag does the same on the other axis, and a lifted label that lags the
   *  finger reads as the app being busy). */
  liftPx: number | null
  /** Which of this row's own edges carries the 2px drop-indicator line, if
   *  either. The line is the whole readout — there is no drag chip. */
  dropEdge: "top" | "bottom" | null
  onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void
  onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void
}

function LaneLabel({
  name,
  sub,
  dot,
  trailing,
  reorder,
}: {
  name: string
  sub: string
  dot: string
  trailing?: ReactNode
  reorder?: LaneLabelReorder
}) {
  const t = useT()
  const lifted = reorder?.liftPx != null
  // The same ruler the chips beside this label degrade against. Stage 3 wired
  // it for them and left the gutter rendering at full size into a clip, which
  // is why the names printed over each other at the compact end.
  const { rowH } = useRowMetrics()
  return (
    // `overflow-hidden` because the two lines inside are fixed-size chrome and
    // the row around them is not any more: at the compact end of the vertical
    // zoom the sublabel is taller than its row, and without the clip it would
    // print across the label below it rather than being cut off by it.
    //
    // Stage 3: THE WHOLE LABEL IS THE DRAG HANDLE (Sam: "dragging on the
    // name"). The grip beside the dot is an affordance and nothing more — it
    // has no handler of its own, so there is no thin target to hunt for.
    // `role="listitem"` and deliberately NOT `role="button"`: the app's
    // keyboard layer treats buttons as controls that refuse Space
    // (`spacebarShouldToggle`), so a focused label would silently kill the
    // timeline's transport key.
    <div
      // How `beginTrackDrag` finds the rows to measure. A data attribute and
      // not a testid, and only on the draggable rows: the gutter's contract is
      // that it renders what the hardcoded rows did, and the untimed strip
      // below the tracks is not one of them.
      data-tl-track-row={reorder ? "" : undefined}
      role={reorder ? "listitem" : undefined}
      aria-roledescription={reorder ? t("editor.timeline.sortableTrackRole") : undefined}
      tabIndex={reorder ? 0 : undefined}
      onPointerDown={reorder?.onPointerDown}
      onKeyDown={reorder?.onKeyDown}
      className={cn(
        "flex items-center justify-between gap-1 overflow-hidden border-b border-border px-3",
        TL_ROW_H_CLASS,
        // Everything on this line is withheld from a user who cannot reorder,
        // down to the `relative` — the row a viewer sees is byte-for-byte the
        // row that shipped. `touch-none` for the same reason TimelineCard has
        // it: without it the browser claims a vertical drag as a scroll gesture
        // and the pointer stream stops mid-drag.
        reorder && "group relative cursor-grab touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-500",
        // The lift. Opaque background + shadow because the row it passes over
        // is still drawn where it always was — the other rows deliberately do
        // NOT part (see the gutter's comment), so the only thing separating the
        // travelling row from the stationary one underneath is this.
        lifted && "z-10 cursor-grabbing bg-background opacity-90 shadow-lg",
      )}
      style={lifted ? { transform: `translateY(${reorder?.liftPx}px)` } : undefined}
    >
      {reorder?.dropEdge && (
        <span
          aria-hidden
          data-testid="tl-track-drop-line"
          className={cn(
            "pointer-events-none absolute inset-x-0 z-20 h-0.5 bg-sky-500",
            reorder.dropEdge === "top" ? "top-0" : "bottom-0",
          )}
        />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
          {/* An <svg> inside the existing name span, and it MUST NOT grow a
              `span.font-semibold` of its own: the gutter parity test reads the
              track names by selecting exactly that class and mapping
              textContent, so a wrapper here would read back as a nameless
              extra row. An icon contributes no text, so the names are
              untouched. */}
          {reorder && (
            <GripVertical
              data-testid={`tl-track-grip-${reorder.trackId}`}
              className="-ml-1.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-30 transition-opacity group-hover:opacity-100"
            />
          )}
          <span className={cn("h-1.5 w-1.5 shrink-0 rounded-sm", dot)} />
          {/* TRUNCATE, NEVER WRAP — and this was wrong at every row height, not
              just the short ones. "Source subtitles" does not fit the 128px
              gutter beside a grip and a dot, so it wrapped to two lines; that
              is a four-line label in a row built for two, which is most of what
              made the compact end overflow so badly. A plain span, because the
              parity test matches `span.font-semibold` and this one must not. */}
          <span className="truncate">{name}</span>
        </span>
        {/* The sublabel is the first thing to go as the row shrinks — see
            MIN_LABEL_SUB_H_PX. */}
        {rowH >= MIN_LABEL_SUB_H_PX && <span className="truncate text-[10px] text-muted-foreground">{sub}</span>}
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
  onRetimeCue,
  timingLocked = false,
  onTrimTarget,
  onTogglePlay,
  onRequestLinkVideo,
  onAddLine,
  canAddLine,
  canRemoveImportedCells = false,
  onRemoveLine,
  canLinkVideo = true,
  onRequestImportAudioVtt,
  onRequestImportCharacters,
  canImportCharacters = false,
  characterCount = 0,
  audioCharacterCount = 0,
  charactersWriting = false,
  characterDisagreements = 0,
  onReviewCharacterDisagreements,
  canCheck = true,
  targetCells,
  onLinkingModeChange,
  linkingModeRequest,
  onCueActivated,
  cueLinks,
  cueLinksFailed = false,
  cueLinksPending = false,
  onToggleCueLink,
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
  isSubtitleImport = false,
  project,
  onSelectCell,
  onTranscribeSections,
  session,
  audioByCellId,
  legacyMeasure,
  tracks = DEFAULT_TRACKS,
  onReorderTrack,
}: TimelineEditorProps) {
  const t = useT()
  const audioFirst = timingMode === "audioFirst"
  const [pxPerSec, setPxPerSec] = useState(() => loadZoom(fileId))
  // Stage 3: the OTHER zoom. Every row container and every chip box reads these
  // three numbers through CSS custom properties on the root below, so one state
  // value resizes the gutter, four lanes and everything drawn on them at once —
  // there is no second copy of the geometry to fall out of step.
  const [rowH, setRowH] = useState(() => loadRowHeight(fileId))
  const rowMetrics = useMemo<RowMetrics>(
    () => ({ rowH, chipH: chipHeightPx(rowH), chipPad: chipPadPx(rowH) }),
    [rowH],
  )
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
  // AQU-928: the sections selected ALONGSIDE the primary chip — purely a batch
  // scope for the transcribe row. Every rule about how a click changes this
  // lives in `applySelect`; this component only stores the two halves.
  const [extraIds, setExtraIds] = useState<readonly string[]>([])
  const [scrollLeft, setScrollLeft] = useState(0)
  const [viewportPx, setViewportPx] = useState(0)
  const [follow, setFollow] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  /** The clipped label column, and the div inside it that carries the vertical
   *  offset. The gutter does not scroll — see `handleTrackScroll`. */
  const gutterRef = useRef<HTMLDivElement>(null)
  const gutterInnerRef = useRef<HTMLDivElement>(null)
  /** The horizontal offset this component has already reacted to. Stage 3 made
   *  the track column scroll in y as well, so a scroll event no longer implies
   *  a horizontal move — everything keyed on one has to check first. */
  const lastScrollLeft = useRef(0)
  /** Programmatic scrolls stamp this; the onScroll handler treats scroll
   *  events within 150ms of a stamp as our own, not a user disengage. */
  const lastProgrammaticScrollAt = useRef(0)
  /**
   * Stage 3: a track being dragged up or down the gutter.
   *
   * `bounds` is snapshotted from the live DOM at pointerdown and carried in the
   * state rather than recomputed per move — the rows deliberately do not move
   * during a drag, so one measurement is the whole truth, and measuring 60x a
   * second would be four forced layouts per frame for an answer that cannot
   * have changed. It is also why the row height never appears in this code:
   * hit-testing measured midpoints is correct with rows of different heights
   * and survives the vertical zoom being changed between two drags, which
   * dividing a pointer offset by a row height is not and does not.
   */
  const [trackDrag, setTrackDrag] = useState<{
    fromIndex: number
    /** Where it would land on release — an index into `tracks`, already past
     *  proposeDropIndex's lifted-row adjustment. */
    toIndex: number
    /** Raw pointer travel, straight onto the row's transform. */
    dy: number
    bounds: RowBound[]
  } | null>(null)
  const clock = useTimelineClock()
  const chipStripSlot = useUiSlot("media-chip-strip")

  // AQU-646: bridge the audio play-queue into the timeline clock. Progress is
  // file-timeline seconds for imported media (one shared clip); the cellIdSet
  // guard keeps a stale singleton queue (playing another file) from hijacking
  // this timeline's playhead.
  const cellIdSet = useMemo(() => new Set(cells.map((c) => c.id)), [cells])
  // AQU-928: what "from here to there" means for a Shift-click — the file's own
  // cell order, i.e. the order the text table below shows, not lane order.
  const orderedIds = useMemo(() => cells.map((c) => c.id), [cells])
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

  // Stage 3: RE-READ THE PER-FILE VIEW PREFERENCES WHEN THE FILE CHANGES.
  //
  // Both are `useState(() => load…(fileId))`, and an initialiser runs once —
  // but this component is NOT remounted on a file switch (same subtree, no
  // key), so without this the two settings Sam asked to be remembered per file
  // were in fact remembered per session: open episode 2 and it kept episode 1's
  // zoom, then wrote it back under episode 2's key the moment you touched a
  // stepper. The horizontal zoom has carried that gap since it shipped; the row
  // height would have arrived with it, and one of the pair silently behaving
  // differently from the other is exactly what reads as a bug rather than as a
  // limitation. Skipped on the first run for the file we mounted with, so a
  // freshly-mounted editor never re-renders for values it already has.
  const loadedPrefsFor = useRef(fileId)
  useEffect(() => {
    if (loadedPrefsFor.current === fileId) return
    loadedPrefsFor.current = fileId
    setPxPerSec(loadZoom(fileId))
    setRowH(loadRowHeight(fileId))
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

  /** `name` overrides the track's own sentence for a row whose button silences
   *  something else — see `editor.timeline.muteNamed`. */
  function speakerToggle(track: keyof TrackAudibility, name?: string) {
    const audible = audibility[track]
    const keys = SPEAKER_TOGGLE_KEYS[track]
    const compactSpeaker = rowH < MIN_SPEAKER_FULL_H_PX
    const speakerLabel = name
      ? t(audible ? "editor.timeline.muteNamed" : "editor.timeline.unmuteNamed", { name })
      : t(audible ? keys.mute : keys.unmute)
    const speakerTitle = name
      ? t(audible ? "editor.timeline.namedAudible" : "editor.timeline.namedMuted", { name })
      : t(audible ? keys.audibleTitle : keys.mutedTitle)
    return (
      <button
        type="button"
        data-testid={`tl-speaker-${track}`}
        aria-label={speakerLabel}
        aria-pressed={audible}
        title={speakerTitle}
        onClick={() => toggleAudibility(fileId, track)}
        className={cn(
          "inline-flex shrink-0 items-center rounded-md border border-border",
          // It shrinks rather than vanishing: at 24px the full button is
          // exactly as tall as its row, which is what put it across two of them
          // in Sam's screenshot. See MIN_SPEAKER_FULL_H_PX — muting a track is
          // the thing you reach for WHILE zoomed out to see several at once, so
          // dropping the control at the very height that makes it useful would
          // be the wrong trade.
          compactSpeaker ? "p-0.5" : "p-1",
          audible
            ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300"
            : "bg-background text-foreground/50 hover:bg-muted",
        )}
      >
        {audible ? (
          <Volume2 className={cn(compactSpeaker ? "h-3 w-3" : "h-3.5 w-3.5")} />
        ) : (
          <VolumeX className={cn(compactSpeaker ? "h-3 w-3" : "h-3.5 w-3.5")} />
        )}
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

  // What the text column under the timeline is called.
  //
  // Pinned rather than derived per-cell, because in this workflow every cell is
  // a text cell and the header would otherwise change as you clicked around.
  //
  // "SUBTITLES", not "Dialogue" (Sam, 2026-08-20): these cells ARE the
  // subtitles, the track gutter directly above already calls them that, and
  // the thing they were being confused with — the heard lines from the audio
  // sibling — is labelled "Audio cues" a few inches away. A heading of its own
  // invention sitting between those two invited exactly that mix-up.
  //
  // Keyed on the FILE now, not on `subtitleFileWithFootage` (a linked-video
  // heuristic). That gate left a subtitle file with no video falling through to
  // the per-cell derivation, which says "Dialogue" whenever nothing is
  // selected — the confusing case, on the one file type that can least afford
  // it.
  const textHeadingLabel = isSubtitleImport ? "Subtitles" : undefined

  // Stretches of film that no cell covers — where a line can still be added.
  // Derived from the same sweep the Source track draws, so the two can never
  // disagree about where there is room.
  //
  // Round 8, "no room, no add": the length floor is the SAME one the band uses
  // to decide whether a gap gets a chip. Without it, zooming past ~160px/s let
  // the pencil appear over a silence the row had declined to draw — an offer to
  // fill a stretch you cannot see. Both the pencil and the mic read this array,
  // so one filter covers both surfaces.
  //
  // THE SETTING IS THE SINGLE AUTHORITY (Sam, 2026-08-21). Stage 4 used to
  // hard-off all of this the moment an audio VTT was imported — on the
  // grounds that inventing a line against a finished film's cue lists means
  // nothing, and that the mic over a silence could mint a take matching NO
  // audio cue. That rule predates the project setting; once the setting
  // existed (default OFF, flippable only at maintainer), keeping the hard-off
  // underneath it made the toggle a visible no-op on every dubbing episode —
  // which is how Matt's QA found it. The stage-4 protection now lives where
  // it belongs: in the default being OFF. Turning it on is the "very active
  // decision" this project reserves for dangerous things, and ON means on.
  // Emptying this one array still closes all three surfaces at once (both
  // subtitle pencils and the empty-stretch mic); the mic over a real cue with
  // no take yet is a different affordance, comes from `emptyCells`, and stays.
  const addableSpans = useMemo(
    () =>
      !canAddLine
        ? []
        : sourceRegions.regions
            .filter((r) => r.kind === "gap" && r.endSec - r.startSec >= MIN_ADDABLE_SPAN_SEC)
            .map((r) => ({ startSec: r.startSec, endSec: r.endSec })),
    [sourceRegions, canAddLine],
  )
  // Round 5: the Target-audio track's chips — one per section with dub audio.
  // AQU-646: in the VTT-plus-footage arrangement the takes hang off TEXT cells
  // — there are no media cells to hang them on — so the Target track resolves
  // them without the medium gate. Everywhere else it is exactly as before.
  // ── Linking mode (stage 4) ───────────────────────────────────────────────
  // OFF BY DEFAULT AND OFF IS THE NORMAL STATE (Sam, 2026-08-14). While it is
  // off nothing about clicking changes anywhere on the timeline — the overlays
  // are simply not rendered — which is why this is a mode and not a modifier
  // key or a special click target on the chips themselves.
  const [linkingMode, setLinkingMode] = useState(false)
  // Which chip a pairing is being made FROM, and which row it came from. A pick
  // can start on either row: from a heard line to find its subtitle, or from a
  // subtitle to find the lines that perform it.
  const [pickedLink, setPickedLink] = useState<{ id: string; side: "cue" | "text" } | null>(null)
  /**
   * A pairing waiting to be confirmed. (AQU-646, Sam 2026-08-20: "when a link
   * is broken or made, there should be a modal pop-up that asks are you
   * sure?… better safe than sorry.")
   *
   * Held HERE rather than in the overlay because both lanes' overlays funnel
   * into one `toggleLink`, so one piece of state and one dialog cover both
   * directions — and the picked chip stays picked while the question is up, so
   * cancelling leaves you exactly where you were rather than making you
   * re-pick.
   */
  const [pendingLink, setPendingLink] = useState<
    { textCellId: string; cueCellId: string; linking: boolean } | null
  >(null)
  const linkingAvailable = Boolean(onToggleCueLink && audioCues && editable && canCheck)
  // Leaving the mode must not strand a half-made pairing on screen.
  useEffect(() => {
    if (!linkingMode) {
      setPickedLink(null)
      setPendingLink(null)
    }
  }, [linkingMode])
  // The drawer's close button reaches back in here. Nonce-keyed so closing,
  // reopening and closing again all land.
  const linkingNonceRef = useRef<number | null>(null)
  useEffect(() => {
    if (!linkingModeRequest) return
    if (linkingNonceRef.current === linkingModeRequest.nonce) return
    linkingNonceRef.current = linkingModeRequest.nonce
    setLinkingMode(linkingModeRequest.on)
  }, [linkingModeRequest])
  useEffect(() => {
    if (!linkingAvailable) setLinkingMode(false)
  }, [linkingAvailable])

  // Each row states what the file HAS, and opens the dialog that owns that
  // source's verbs — so no row needs two actions. Permission is per row rather
  // than per button, which is strictly better than the buttons were: linking a
  // film is contributor-level, while both cell-writing imports sit at the
  // source.cell.create floor.
  /**
   * The CHECK menu — reviewing, as against Sources' importing. (Sam,
   * 2026-08-18: "make a check drop down for link cues and for characters".)
   *
   * "Check links" is where the old "Link cues" button went, and it still ARMS
   * LINKING MODE rather than only opening a list. That is deliberate: the
   * drawer being open IS the mode. Because a dropdown item reads like "show me
   * a list", the drawer says in its header that linking is on — a line that is
   * present exactly while the mode is, which a toast cannot be.
   */
  const checkMenuItems = useMemo<OverflowMenuItem[]>(() => {
    const items: OverflowMenuItem[] = []
    if (linkingAvailable) {
      items.push({
        id: "check-links",
        label: linkingMode ? "Stop linking" : "Check links",
        icon: Link2,
        badge: cueLinksPending ? (
          <span className="text-[11px] text-muted-foreground">{t("editor.timeline.badgePairing")}</span>
        ) : undefined,
        onClick: () =>
          setLinkingMode((on) => {
            onLinkingModeChange?.(!on)
            return !on
          }),
      })
    }
    if (onReviewCharacterDisagreements && canCheck) {
      items.push({
        id: "check-characters",
        label: "Check characters",
        icon: Users,
        badge:
          characterDisagreements > 0 ? (
            <span className="text-[11px] font-medium text-amber-600 dark:text-amber-400">
              {characterDisagreements}
            </span>
          ) : undefined,
        onClick: onReviewCharacterDisagreements,
      })
    }
    return items
  }, [
    linkingAvailable, linkingMode, cueLinksPending, onLinkingModeChange,
    onReviewCharacterDisagreements, characterDisagreements, canCheck,
  ])

  const sourceMenuItems = useMemo<OverflowMenuItem[]>(() => {
    const items: OverflowMenuItem[] = []
    if (onRequestLinkVideo) {
      items.push({
        id: "film",
        label: "Film",
        icon: Film,
        disabled: !canLinkVideo,
        badge: (
          <span className="text-[11px] text-muted-foreground">
            {coreMediaUrl ? t("editor.timeline.badgeLinked") : t("editor.timeline.badgeNotLinked")}
          </span>
        ),
        onClick: onRequestLinkVideo,
      })
    }
    if (onRequestImportAudioVtt) {
      items.push({
        id: "audio-cues",
        label: "Audio cues",
        icon: AudioLines,
        disabled: !canImportAudioVtt,
        badge: (
          <span className="text-[11px] text-muted-foreground">
            {hasAudioCueTrack
              ? t("editor.timeline.badgeImportedCount", { count: audioCues?.length ?? 0 })
              : t("editor.timeline.badgeNotImported")}
          </span>
        ),
        onClick: onRequestImportAudioVtt,
      })
    }
    if (onRequestImportCharacters) {
      items.push({
        id: "characters",
        label: "Characters",
        icon: Users,
        disabled: !canImportCharacters,
        badge: charactersWriting ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Spinner className="h-3 w-3" /> {t("common.saving")}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {characterCount === 0 && audioCharacterCount === 0
              ? t("editor.timeline.badgeNotImported")
              : [
                  characterCount > 0 ? `${characterCount} subtitle` : null,
                  audioCharacterCount > 0 ? `${audioCharacterCount} heard` : null,
                ]
                  .filter(Boolean)
                  .join(" + ")}
          </span>
        ),
        onClick: onRequestImportCharacters,
      })
    }
    return items
  }, [
    onRequestLinkVideo, canLinkVideo, coreMediaUrl,
    onRequestImportAudioVtt, canImportAudioVtt, hasAudioCueTrack, audioCues?.length,
    onRequestImportCharacters, canImportCharacters, characterCount, audioCharacterCount,
    charactersWriting,
  ])

  /**
   * Is there anything in Sources this person can actually do?
   *
   * All three entries — the film, the audio cues, the character sheets — are
   * project SETUP, and as of 2026-08-18 all three are gated at project lead on
   * the server. For the translators and dubbers who receive the file that
   * leaves a button opening onto three greyed-out rows, which reads as "you're
   * missing something" rather than "this isn't yours". Sam: "you could also
   * totally just hide the sources drop-down button."
   *
   * Hidden only when NOTHING in it is available — a lead who happens to lack
   * one specific permission still sees the menu, and the badges that say what
   * is already attached.
   */
  const sourcesUsable = useMemo(
    () => sourceMenuItems.some((item) => !item.disabled),
    [sourceMenuItems],
  )

  const links = cueLinks ?? EMPTY_CUE_LINK_INDEX
  // The amber "no subtitle behind this" mark exists to surface a HANDFUL of
  // genuine orphans (~10 per episode) among hundreds of paired cues. Two states
  // make it a lie and suppress it entirely:
  //  - the read FAILED: we don't know what is linked, so marking anything as
  //    unlinked would state a fact nobody has (this is exactly how a dead
  //    links table rendered as "548 confident orphans" on 2026-08-14);
  //  - NOTHING is linked: the matcher has simply never run, and a wall of
  //    amber says nothing — the notice below says the true thing instead.
  const neverPaired =
    !cueLinksPending && links.textForCue.size === 0 && (audioCues?.length ?? 0) > 0
  const suppressUnlinkedMarks = cueLinksFailed || neverPaired
  const unlinkedCueIds = useMemo(
    () =>
      suppressUnlinkedMarks
        ? new Set<string>()
        : new Set((audioCues ?? []).filter((c) => !links.textForCue.has(c.id)).map((c) => c.id)),
    [audioCues, links, suppressUnlinkedMarks],
  )
  const unlinkedTextIds = useMemo(
    () =>
      suppressUnlinkedMarks
        ? new Set<string>()
        : new Set(subtitle.filter((c) => !links.cuesForText.has(c.id)).map((c) => c.id)),
    [subtitle, links, suppressUnlinkedMarks],
  )
  /**
   * Flip one pairing — after asking. `linking` is what it should BECOME.
   *
   * THE SINGLE CHOKE POINT for both directions and both lanes, which is why
   * the confirmation lives here rather than in either overlay: a click that
   * makes a pairing and a click that breaks one arrive at the same function.
   */
  const toggleLink = (textCellId: string, cueCellId: string) => {
    const already = (links.cuesForText.get(textCellId) ?? []).includes(cueCellId)
    setPendingLink({ textCellId, cueCellId, linking: !already })
  }
  const commitPendingLink = () => {
    if (!pendingLink) return
    onToggleCueLink?.(pendingLink.textCellId, pendingLink.cueCellId, pendingLink.linking)
    setPendingLink(null)
  }
  const cueLinkOverlay: LaneLinkOverlay | undefined = linkingMode
    ? {
        pickedId: pickedLink?.side === "cue" ? pickedLink.id : null,
        linkedIds:
          pickedLink?.side === "text"
            ? new Set(links.cuesForText.get(pickedLink.id) ?? [])
            : new Set<string>(),
        unlinkedIds: unlinkedCueIds,
        onPick: (id) => {
          if (pickedLink?.side === "text") toggleLink(pickedLink.id, id)
          else setPickedLink((p) => (p?.id === id ? null : { id, side: "cue" }))
        },
      }
    : undefined
  const textLinkOverlay: LaneLinkOverlay | undefined = linkingMode
    ? {
        pickedId: pickedLink?.side === "text" ? pickedLink.id : null,
        linkedIds:
          pickedLink?.side === "cue"
            ? new Set(links.textForCue.get(pickedLink.id) ?? [])
            : new Set<string>(),
        unlinkedIds: unlinkedTextIds,
        onPick: (id) => {
          if (pickedLink?.side === "cue") toggleLink(id, pickedLink.id)
          else setPickedLink((p) => (p?.id === id ? null : { id, side: "text" }))
        },
      }
    : undefined

  // Stage 4: when the file has audio cues, THEY are what the Target row is
  // about — one chip per heard line, on that line's own window. Their cells are
  // ordinary text cells (`medium` is never "media" — cue cells deliberately
  // read as text so they miss the media surfaces), so the resolver has to be
  // the ungated one, exactly as for a subtitle file with footage.
  // WHAT THE TARGET ROW IS ABOUT: whatever this file's units ARE. Audio cues
  // once an audio VTT is imported, the imported recording's media cells for an
  // mp3, the subtitle cues otherwise. A linked video has nothing to do with it
  // (Sam, 2026-08-14) — it used to, and that was the defect: the middle term
  // read `subtitleFileWithFootage ? subtitle : dialogue`, so a subtitle file
  // with no video fell through to `dialogue`, which a VTT import never fills,
  // and the row came up empty with every record button gone. Nothing else
  // changes: a subtitle-with-footage file has an empty dialogue lane and still
  // lands on `subtitle`, an mp3 import still lands on `dialogue`.
  const targetSource = targetCells ?? (dialogue.length > 0 ? dialogue : subtitle)
  // Always the ungated resolver now. The `medium: "media"` gate existed only to
  // stop a MIXED file putting dub chips on every subtitle cue as well as its
  // media cells — and picking the cell set above already decides that, so the
  // gate was guarding a case that can no longer arise.
  const resolveTarget = resolveTargetAudio
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
  // Searches the AUDIO CUES too (stage 4): a cue is a legitimate selection now,
  // and it lives in the hidden sibling file, so looking only in `cells` left the
  // timing readout blank for every chip on the Source-audio row.
  const currentCell = useMemo(
    () =>
      cells.find((c) => c.id === currentCellId) ??
      audioCues?.find((c) => c.id === currentCellId) ??
      null,
    [cells, audioCues, currentCellId],
  )
  // AQU-646 stage 6: who speaks the current chip, and whether the camera is on
  // them. Resolved HERE because this is the one place that holds both halves —
  // the links and the subtitle cells the character sheet was keyed to. A cue
  // has no character of its own, so without this the header opposite the video
  // named nobody for the only kind of chip stage 4 leaves you selecting.
  const currentCharacter = useMemo(
    () => resolveCueCharacter({ cell: currentCell, links, textCells: cells }),
    [currentCell, links, cells],
  )
  // One object for the header's two call sites below — portalled and inline.
  // They render the SAME thing and used to say so twice; a third prop was one
  // more chance for the two to drift apart.
  const mediaTextHeaderProps = {
    cell: currentCell,
    headingLabel: textHeadingLabel,
    castName: formatCueCharacter(currentCharacter.names),
    cameraState: currentCharacter.cameraState ?? null,
  }
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
    // Belt and braces for the axis test in handleTrackScroll: the scroll event
    // this write provokes already knows where we put it. (If the browser clamps
    // to a different offset the values differ, the handler runs in full, and the
    // real number wins — which is exactly what should happen.)
    lastScrollLeft.current = left
    setScrollLeft(left)
  }

  /**
   * The one scroll handler on the track column, which owns BOTH axes now.
   *
   * The gutter transform is written FIRST and synchronously. Scroll steps run
   * before paint, so the labels land in the same frame as the rows they name;
   * routing the offset through React state instead would draw one frame of
   * labels sitting beside the wrong lanes on every wheel tick.
   *
   * Then: NOTHING ELSE HAPPENS UNLESS THE HORIZONTAL OFFSET ACTUALLY MOVED.
   * Everything below this line is about x — the visibility window, the viewport
   * measurement, and above all the follow-playhead release, which reads a manual
   * scroll as "stop following me". That is a horizontal statement. Scrolling
   * down to look at another track says nothing about whether you still want the
   * view to track playback, and without this check it would silently turn
   * following off every time.
   */
  function handleTrackScroll() {
    const el = scrollRef.current
    if (!el) return
    const inner = gutterInnerRef.current
    if (inner) inner.style.transform = `translateY(${-el.scrollTop}px)`
    if (el.scrollLeft === lastScrollLeft.current) return
    lastScrollLeft.current = el.scrollLeft
    setScrollLeft(el.scrollLeft)
    setViewportPx(el.clientWidth)
    // A MANUAL scroll while playback runs means "stop following me". Our own
    // programmatic scrolls fire this handler too — the 150ms stamp window
    // filters them out.
    if (transportPlaying && performance.now() - lastProgrammaticScrollAt.current > 150) {
      setFollow(false)
    }
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

  /**
   * The vertical zoom's `applyZoom`, and deliberately the plainer of the two:
   * there is no anchor to keep, no re-scroll to schedule.
   *
   * `applyZoom` needs that dance because changing px/sec rewrites the track's
   * WIDTH, which invalidates the scroll offset it is measured in — the browser
   * would clamp it to the old width and the time under the cursor would jump.
   * Row height only ever makes the stack taller or shorter; every existing
   * scrollTop stays a legal scrollTop (the browser clamps a now-too-large one
   * for us and emits the scroll event that re-syncs the gutter), and nothing
   * horizontal moves at all. Adding an anchor here would be motion for its own
   * sake.
   */
  /** Commit a height without disturbing the pinch accumulator. */
  function commitRowHeight(next: number) {
    const h = clampRowHeight(next)
    setRowH(h)
    try {
      localStorage.setItem(rowHeightKey(fileId), String(h))
    } catch {
      /* private mode / unavailable — the height just won't persist */
    }
  }

  /** The stepper's entry point, and anything else that sets a height outright:
   *  commit it AND re-seat the pinch accumulator, so a pinch begun after a
   *  button press carries on from what the button did rather than from wherever
   *  the last pinch happened to stop. */
  function applyRowHeight(next: number) {
    rowHTargetRef.current = clampRowHeight(next)
    commitRowHeight(next)
  }

  /**
   * The pointer's position in the gutter's CONTENT coordinates — the frame
   * `RowBound`s are stored in.
   *
   * The `scrollTop` term is the whole point. The gutter is dragged along by the
   * track column, which the user can keep scrolling mid-drag (a wheel still
   * works, and edge-autoscroll would too if it is ever added); bounds taken
   * once at pointerdown would be wrong by exactly the distance scrolled from
   * that moment on, so the pointer is converted into their frame instead of
   * them being re-measured into its.
   *
   * The gutter COLUMN's top is the origin, not the inner div's: the inner div
   * is the thing carrying `translateY(-scrollTop)`, so measuring against it
   * would cancel the offset out again and quietly reintroduce the bug.
   */
  function gutterContentY(clientY: number): number {
    const top = gutterRef.current?.getBoundingClientRect().top ?? 0
    return clientY - top + (scrollRef.current?.scrollTop ?? 0)
  }

  /** Where the drag ends up, as a single `file.track.set` write. Shared by the
   *  pointer drop and the keyboard move — one implementation, two inputs. */
  function commitTrackMove(fromIndex: number, toIndex: number) {
    if (!onReorderTrack) return
    const drop = orderForDrop(tracks, fromIndex, toIndex)
    // null covers both "did not move" and an index off either end (which is how
    // Alt+ArrowUp on the top row resolves), so neither needs its own guard.
    if (!drop) return
    onReorderTrack(drop.trackId, drop.order)
  }

  /**
   * TimelineCard's `beginDrag`, retargeted from clientX to clientY, plus the
   * two things a vertical drag inside a scroller needs that a chip drag does
   * not: a `pointercancel` listener (the browser can and does take the pointer
   * back — a touch turning into a scroll, a system gesture) and the body's
   * `userSelect` saved and restored, both exactly as EditorTable's drag-select
   * does them. Without the cancel listener a taken-back pointer leaves the row
   * lifted forever with window listeners still attached.
   */
  function beginTrackDrag(fromIndex: number, e: ReactPointerEvent<HTMLDivElement>) {
    if (!onReorderTrack || e.button !== 0) return
    // The speaker toggle lives INSIDE the label, and the label is the handle:
    // without this, muting a track starts a drag and the click never lands.
    if (e.target instanceof Element && e.target.closest("button")) return
    const inner = gutterInnerRef.current
    if (!inner) return
    const rows = Array.from(inner.querySelectorAll<HTMLElement>("[data-tl-track-row]"))
    if (rows.length !== tracks.length) return
    const originTop = gutterRef.current?.getBoundingClientRect().top ?? 0
    const scrolled = scrollRef.current?.scrollTop ?? 0
    const bounds: RowBound[] = rows.map((row) => {
      const rect = row.getBoundingClientRect()
      return { top: rect.top - originTop + scrolled, bottom: rect.bottom - originTop + scrolled }
    })

    const startY = e.clientY
    try {
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    } catch {
      /* happy-dom / unsupported — the window listeners still carry the drag */
    }
    const restoreUserSelect = document.body.style.userSelect
    document.body.style.userSelect = "none"
    setTrackDrag({ fromIndex, toIndex: fromIndex, dy: 0, bounds })
    // Same 3px threshold TimelineCard uses: a drag has to be INTENDED. Below
    // it the row does not follow and a release commits nothing, so a click that
    // wobbles by a pixel cannot silently reorder the timeline.
    let moved = false
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY
      if (Math.abs(dy) > 3) moved = true
      const toIndex = moved ? proposeDropIndex(fromIndex, gutterContentY(ev.clientY), bounds) : fromIndex
      setTrackDrag((d) => (d ? { ...d, dy, toIndex } : d))
    }
    const stop = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      document.body.style.userSelect = restoreUserSelect
      setTrackDrag(null)
    }
    const onUp = (ev: PointerEvent) => {
      stop()
      if (!moved) return
      commitTrackMove(fromIndex, proposeDropIndex(fromIndex, gutterContentY(ev.clientY), bounds))
    }
    // A CANCELLED drag commits nothing. The pointer was taken away, so there is
    // no release position to read as an intention.
    const onCancel = () => stop()
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
  }

  /**
   * The same move from the keyboard. ~20 lines because the arithmetic already
   * exists — this is a second INPUT to one implementation, not a second
   * implementation, which is what makes it worth having rather than a TODO.
   *
   * Alt+Arrow, and the handler is ON THE ELEMENT: a document-level listener
   * would have to enter the audio-shortcut ownership stack to know whether it
   * is allowed to act, and a plain ArrowUp/ArrowDown would fight the scroller
   * the label sits in.
   *
   * Focus survives the move for free, because the gutter rows are keyed by
   * track id: React moves the existing DOM node rather than rebuilding the row
   * in place. Key them by index and holding Alt+ArrowDown would move a
   * different track on every press, with nothing to say why.
   */
  function onTrackLabelKeyDown(fromIndex: number, e: ReactKeyboardEvent<HTMLDivElement>) {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return
    e.preventDefault()
    e.stopPropagation()
    commitTrackMove(fromIndex, e.key === "ArrowDown" ? fromIndex + 1 : fromIndex - 1)
  }

  /**
   * The insertion boundary the drop-indicator line is drawn at: 0..tracks.length,
   * counting the gaps between rows rather than the rows themselves.
   *
   * It is `proposeDropIndex`'s lifted-row adjustment read backwards — dragging
   * DOWN to index i means the line sits below row i (boundary i+1), dragging up
   * means above it. null while the drop would change nothing, so a drag that
   * has not left its own slot draws no promise it will not keep.
   */
  const dropBoundary =
    trackDrag && trackDrag.toIndex !== trackDrag.fromIndex
      ? trackDrag.toIndex > trackDrag.fromIndex
        ? trackDrag.toIndex + 1
        : trackDrag.toIndex
      : null
  /**
   * The same line, in the LANE column, in content pixels.
   *
   * The two columns share a coordinate frame by construction: the gutter's
   * non-translating spacer is the same `h-7` as the ruler, so a row's content-y
   * measured in the gutter is the same content-y in the scroller — which is
   * exactly what `top` inside the track content div means. If either height
   * ever changes without the other, the line will be off by the difference.
   */
  const dropLineContentY =
    trackDrag && dropBoundary != null
      ? dropBoundary < trackDrag.bounds.length
        ? trackDrag.bounds[dropBoundary].top
        : trackDrag.bounds[trackDrag.bounds.length - 1].bottom
      : null

  // SUB-12: cursor-centered wheel/pinch zoom (ctrl + wheel — a trackpad pinch
  // arrives as a ctrlKey wheel). Native listener with passive:false because
  // React's synthetic onWheel can't reliably preventDefault (the browser would
  // page-zoom). Plain wheel (no modifier) keeps scrolling untouched.
  //
  // Stage 3 hangs the VERTICAL zoom off the same listener under ⌘ + scroll —
  // see the metaKey branch in onWheel for why that gesture and not a pinch.
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
  /**
   * The row height a ⌘-pinch is steering toward, advanced SYNCHRONOUSLY on
   * every wheel event.
   *
   * This is not the same thing as a ref that mirrors the state, and the first
   * cut of the gesture used one of those and barely moved. A pinch emits dozens
   * of events per frame while React re-renders once, so every event in a burst
   * read the same stale height, computed the same small step from it, and threw
   * all but the last away — a vigorous pinch advanced about one step per frame
   * and read as broken. The horizontal zoom has always had this accumulator
   * (`zoomTargetRef`); the vertical one skipped it along with the easing loop it
   * sits next to, and only the easing was genuinely unwanted.
   */
  const rowHTargetRef = useRef(rowH)
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
      // ⌘ + two-finger SCROLL zooms the ROWS instead of the seconds (Sam,
      // 2026-08-13).
      //
      // A SCROLL, and not a pinch, and that is not a preference — VERIFIED on
      // macOS: a trackpad pinch reaches the page as a wheel event that the
      // browser synthesizes with ctrlKey set, and it does NOT carry whatever
      // else you are holding. ⌘ + pinch arrives here indistinguishable from a
      // bare pinch and falls straight through to the horizontal zoom below.
      // So no "modifier + pinch" binding is implementable on this platform,
      // for any modifier — do not try again. A real two-finger scroll is an
      // ordinary wheel event and reports its modifiers honestly, which is why
      // this one works.
      //
      // ctrl is unavailable regardless: a bare pinch already sets it, so ctrl
      // could never mean anything but "the horizontal zoom" without taking
      // pinch-to-zoom away.
      if (e.metaKey) {
        const rowMag = Math.abs(e.deltaY)
        // Half the horizontal gain, because the two axes travel very different
        // distances for the same gesture: seconds/px spans 8→240, a factor of
        // 30, while a row spans 24→160, under 7. Sharing the exponent made the
        // rows arrive at their limit about four times sooner than the seconds
        // do, which reads as a control with two settings.
        const rowSpeed = (rowMag >= 90 ? rowMag * 0.0022 : Math.min(rowMag * 0.019, 0.55)) * 0.5
        // FRACTIONAL, and from the accumulator rather than the rendered height.
        // Both halves matter. A row height is an integer — half pixels blur the
        // border under every lane — so a gentle tick's third-of-a-pixel step
        // rounds straight back to where it started, and a gesture built on the
        // committed value cannot move at all however long it is held. The
        // fraction is kept here and only the DISPLAY is rounded, so slow pinches
        // accumulate instead of being thrown away one tick at a time.
        const from = rowHTargetRef.current
        const next = from * Math.exp(e.deltaY < 0 ? rowSpeed : -rowSpeed)
        rowHTargetRef.current = Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, next))
        commitRowHeight(rowHTargetRef.current)
        return
      }
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

    // Stage 3: the same gesture, over the LABEL GUTTER. The gutter is
    // `overflow-hidden` — it is dragged along by the track column, it does not
    // scroll — so a wheel there finds nothing to scroll and, worse, a ctrl+wheel
    // there PAGE-ZOOMS THE BROWSER, because the preventDefault listener above is
    // bound to the track column and never sees the event. Both cases are
    // consumed here and forwarded: the pinch reaches the same zoom path (its
    // anchor lands a gutter-width left of the viewport, which is where the
    // pointer genuinely is), the plain wheel drives the column's own scroller,
    // whose scroll event then slides the gutter back under the pointer.
    const onGutterWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        onWheel(e)
        return
      }
      e.preventDefault()
      el.scrollTop += e.deltaY
      el.scrollLeft += e.deltaX
    }

    const gutter = gutterRef.current
    el.addEventListener("wheel", onWheel, { passive: false })
    gutter?.addEventListener("wheel", onGutterWheel, { passive: false })
    return () => {
      el.removeEventListener("wheel", onWheel)
      gutter?.removeEventListener("wheel", onGutterWheel)
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
    // Searches the AUDIO CUES too. A cue is a legitimate destination now — the
    // pairing drawer navigates to one — and looking only in `cells` meant every
    // such request found nothing and silently returned, so the track never
    // moved.
    const cell = cells.find((c) => c.id === cellId) ?? audioCues?.find((c) => c.id === cellId)
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
    // AQU-928: a row click is a plain selection, so it replaces the batch scope.
    setExtraIds([])
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
  // A cue chip SELECTS now (Sam, 2026-08-14) — it draws as selected and fills
  // the timing readout like any other chip. Deliberately not `selectFromChip`:
  // that one fires `onChipActivated`, which scrolls the dialogue table by cell
  // id, and a cue has no row there to scroll to. The table is reached through
  // the cue's LINKS instead, which is the workspace's job.
  const selectCueFromChip = (cueCellId: string) => {
    setSelectedId(cueCellId)
    onCueActivated?.(cueCellId)
  }

  const selectFromChip = (cellId: string, mods?: SelectMods) => {
    const next = applySelect({ primaryId: selectedId, extraIds }, cellId, mods, orderedIds)
    setSelectedId(next.primaryId)
    setExtraIds(next.extraIds)
    // AQU-928: only a PLAIN click is a navigation — a modified one is building
    // a batch scope, and scroll-yanking the text table on each ⌘-click would
    // make picking a handful of sections unusable.
    if (!mods) onChipActivated?.(cellId)
  }

  // AQU-928: the batch scope the transcribe row acts on. `selectedIdsInOrder`
  // is strict about `orderedIds`, so a section that left the file (file switch,
  // deletion) drops out of the scope instead of lingering invisibly.
  const selectedIds = useMemo(
    () => selectedIdsInOrder({ primaryId: selectedId, extraIds }, orderedIds),
    [selectedId, extraIds, orderedIds],
  )
  const multiSelectedIds = useMemo(
    () => new Set(selectedIds.filter((id) => id !== selectedId)),
    [selectedIds, selectedId],
  )
  // Only sections with audio can be transcribed; the row reports the shortfall
  // rather than silently running over a smaller set than the user selected.
  const transcribeTargetIds = useMemo(
    () => selectedIds.filter((id) => {
      const cell = cells.find((c) => c.id === id)
      return cell ? canTranscribeCell(cell) : false
    }),
    [selectedIds, cells],
  )

  const laneProps = {
    layout,
    pxPerSec,
    viewStartSec,
    viewEndSec,
    selectedId,
    multiSelectedIds,
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
            // AQU-646: THE LOCK IS THE ONLY ANSWER to "may this move?".
            //
            // This used to read `subtitleFileWithFootage ? isUserAddedLine :
            // undefined` — an imported VTT cue was frozen whenever a film was
            // linked, on the grounds that "arguing for the VTT's integrity
            // while letting anyone drag its cues is incoherent" (Sam,
            // 2026-08-11). That was right while there was NO WAY TO SAY
            // OTHERWISE. There is now: unlocking is a project-wide setting, a
            // rank above project lead, that announces itself in this toolbar
            // for as long as it is off.
            //
            // Keeping the old clause as an extra condition made unlocking a
            // NO-OP on exactly the files this exists for — a subtitle VTT with
            // a film linked, which is every episode in the dubbing workflow
            // (Sam, 2026-08-20: "when timing is unlocked … timing is still
            // locked"). The blanket freeze retires into the lock, which does
            // its job better: it does not depend on whether a film happens to
            // be linked, and it defaults to ON.
            //
            // A line someone added here still moves either way — it carries no
            // imported timing to corrupt.
            canRetimeCell={timingLocked ? isUserAddedLine : undefined}
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
            // AQU-1068 widened this: a MAINTAINER may take back any cell,
            // imported ones included, and the confirmation dialog upstream is
            // what makes that safe. Below that rank the old rule stands — only
            // a line added here, only while it is still empty, because a cell
            // carrying takes or comments would strand every one of them.
            // The same predicate the text table asks, so the two surfaces can
            // never disagree about what is removable.
            canRemove={
              canAddLine
                ? (c) => canRemoveImportedCells || (isUserAddedLine(c) && isLineEmpty(c))
                : undefined
            }
            onRemove={onRemoveLine}
            // Only THIS subtitle row takes part in linking. The target-subtitles
            // row below draws the same cells, and giving both an overlay would
            // put two click targets on one line for the same pairing.
            linkOverlay={textLinkOverlay}
          />
        )
      case "source-audio":
        // Two tenants, and which one shows up is decided by the CELLS, never by
        // whether a video is linked. An imported recording's dialogue lane,
        // whose source split is FROZEN at import and never retimable (round 6 —
        // that split is the recording's own segmentation, not imported timing,
        // so the timing lock has no claim on it); or, when there are no media
        // cells at all, the audio VTT's cues — which the lock DOES govern —
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
            // AUDIO CHIPS SELECT, AND ALWAYS SHOULD HAVE. Stage 2 refused it
            // because selection drove three TEXT-cell surfaces at once and a
            // cue has a row in none of them — but the fix was to separate them,
            // not to make the chip inert. It now draws as selected and fills
            // the timing readout (`currentCell` searches the cues); reaching
            // the dialogue table goes through the cue's LINKS, which is a
            // question stage 4 can finally answer and stage 2 could not.
            onSelect={selectCueFromChip}
            onSeek={seekAudioCue}
            onSeekSec={seekTo}
            linkOverlay={cueLinkOverlay}
            // Matt's QA (2026-08-21): THE LOCK COVERS THE AUDIO CHIPS TOO —
            // Sam's original ruling on the timing lock, which this row never
            // received. No user-inserted exemption here: nobody hand-adds a
            // heard line, so locked means frozen, full stop.
            retimable={!timingLocked}
            onRetime={onRetimeCue}
            snapEnabled={snapOn}
          />
        )
      case "target-subtitles":
        // The translation of each cue, at the cue's own timings — the same
        // cells as the Subtitles row above, showing their other side (see
        // TimelineCard's labelText). Frozen: moving a translation would mean
        // moving the cue, which is the source row's timing and not ours.
        return (
          <TimelineLane
            key={track.id}
            cells={subtitle}
            variant="target-subtitle"
            retimable={false}
            {...laneProps}
            // The same pencil, in the same silences, doing the same thing —
            // and that is the point (Sam, 2026-08-13). It creates the SAME cell
            // the source row's pencil creates, because these two rows are two
            // views of one set of cues. Offering it on one row and not the
            // other would have the user learn which half of a pair of identical
            // rows accepts a new line, which is a rule with no reason behind it.
            emptySpans={addableSpans}
            onAddLine={canAddLine && onAddLine ? (s, e) => void onAddLine(s, e) : undefined}
          />
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
            externalMaster={Boolean(coreMediaUrl)}
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
    // Stage 3: the editor FILLS the height it is given, and gives it all to the
    // tracks. It sits in a resizable panel now, so it no longer sizes itself to
    // its content (which is what the 2026-08-07 note here used to say) — every
    // piece of chrome is `shrink-0` and the track grid is the sole `flex-1
    // min-h-0`, so dragging the divider lengthens and shortens the scrolling
    // stack and nothing else. `overflow-hidden` is what makes that true rather
    // than merely intended: without it the grid reports its content height, the
    // flex floor keeps the panel from shrinking, and there is no scrollbar.
    //
    // The custom properties are the whole vertical zoom: they are inherited by
    // the gutter labels, all four lanes and every chip on them, so the geometry
    // exists in exactly one place. The context beside them carries the same
    // numbers to the components that need to make DECISIONS about the height
    // (which pieces of a chip still fit) rather than merely be that tall.
    <div
      data-testid="tl-editor"
      className="flex h-full min-h-0 flex-col overflow-hidden"
      style={
        {
          "--tl-row-h": `${rowMetrics.rowH}px`,
          "--tl-chip-h": `${rowMetrics.chipH}px`,
          "--tl-chip-top": `${rowMetrics.chipPad}px`,
        } as CSSProperties
      }
    >
      {/* toolbar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground">{t("editor.timeline.title")}</span>
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
            className="ms-2 inline-flex items-center overflow-hidden rounded-md border border-border text-[11px]"
          >
            {(["dubbing", "audioFirst"] as const).map((mode) =>
              onChangeTimingMode ? (
                <button
                  key={mode}
                  type="button"
                  data-testid={`tl-timing-mode-${mode}`}
                  aria-pressed={timingMode === mode}
                  title={t(TIMING_MODE_KEYS[mode].description)}
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
                  {t(TIMING_MODE_KEYS[mode].name)}
                </button>
              ) : timingMode === mode ? (
                <span
                  key={mode}
                  data-testid={`tl-timing-mode-${mode}`}
                  title={t(TIMING_MODE_KEYS[mode].lockedDescription)}
                  className="px-2 py-1 text-foreground/70"
                >
                  {t(TIMING_MODE_KEYS[mode].name)}
                </span>
              ) : null,
            )}
          </div>
        )}
        <div className="ms-auto flex items-center gap-1.5">
          {/* Meeting 2026-08-05: generated voices default to compressed
              playback; fast connections can opt into the original WAV. Mic
              recordings have no lossless form — the tooltip says so. */}
          <AppTooltip
            content={
              audioQuality === "original"
                ? t("editor.timeline.qualityOriginalTooltip")
                : t("editor.timeline.qualityCompressedTooltip")
            }
          >
            <button
              type="button"
              aria-label={t("editor.timeline.qualityToggleAria")}
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
          <AppTooltip content={snapOn ? t("editor.timeline.snapOnTooltip") : t("editor.timeline.snapOffTooltip")}>
            <button
              type="button"
              aria-label={t("editor.timeline.snapToggleAria")}
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
          <AppTooltip content={t("editor.timeline.followPlayhead")}>
            <button
              type="button"
              aria-label={t("editor.timeline.followPlayhead")}
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
          {/* AQU-646 stage 6: ONE menu for everything that attaches material to
              the file already open — the film, the heard lines, the cast — as
              distinct from the Import button, which mints a NEW file. Three
              separate buttons said nothing about what a file already had;
              a menu row can carry its state, so "548 imported" replaces a
              label that had to choose between "Import" and "Replace" and got
              it wrong either way.

              Built from `items`, not three hardcoded rows: stage 8's untimed
              pocket bin is the same category and will want a fourth. */}
          {sourceMenuItems.length > 0 && sourcesUsable && (
            <OverflowMenu
              items={sourceMenuItems}
              triggerVariant="outline"
              triggerLabel={t("editor.timeline.sourcesMenu")}
              triggerIcon={FolderInput}
              testId="tl-sources-menu"
              ariaLabel={t("editor.timeline.sourcesMenuAria")}
            />
          )}
          {/* AQU-646: the reminder, for as long as the project is unlocked.
              Sam: "the app should remind you when you're unlocked." A toast
              would be exactly wrong here — it goes away, and the whole risk is
              somebody leaving a project unlocked for a week without noticing.
              This sits in the toolbar and does not leave until the lock is back
              on, which is also why it is deliberately plain rather than an
              alarm: it is a state, not an error. */}
          {!timingLocked && (
            <span
              data-testid="tl-timing-unlocked"
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-700 dark:text-amber-400"
            >
              <LockOpen className="h-3 w-3" />
              {t("editor.timeline.timingsUnlocked")}
            </span>
          )}
          {/* Stage 4: linking mode. An explicit toggle, off by default, because
              while it is off clicking must stay exactly what it always was —
              seek, select, drag, trim. Only offered once there are cues to pair
              with and the file is editable. */}
          {checkMenuItems.length > 0 && (
            <OverflowMenu
              items={checkMenuItems}
              triggerVariant="outline"
              triggerLabel={t(linkingMode ? "editor.timeline.checkMenuLinking" : "editor.timeline.checkMenu")}
              triggerIcon={cueLinksPending ? Spinner : ClipboardCheck}
              // Armed linking is a MODE, so the control has to look different
              // while it is on — the confusing state Sam hit was one where
              // nothing on screen said which way it was set.
              triggerClassName={cn(
                linkingMode &&
                  "bg-violet-100 text-violet-700 hover:bg-violet-100 dark:bg-violet-950 dark:text-violet-300",
              )}
              // THE COUNT RIDES ON THE TRIGGER, not on an item — a badge you
              // have to open a menu to see is not doing a badge's job.
              triggerBadge={
                characterDisagreements > 0 ? (
                  <span
                    data-testid="tl-check-count"
                    className="ml-0.5 rounded-full bg-amber-500/20 px-1.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"
                  >
                    {characterDisagreements}
                  </span>
                ) : undefined
              }
              testId="tl-check-menu"
              ariaLabel={t("editor.timeline.checkMenuAria")}
            />
          )}
          {/* The two states in which the overlay would otherwise lie by
              omission get a sentence instead of paint (2026-08-14: a dead
              links table rendered as every chip confidently amber). */}
          {linkingAvailable && linkingMode && cueLinksFailed && (
            <span
              data-testid="tl-linking-notice"
              className="text-xs text-red-600 dark:text-red-400"
            >
              {t("editor.timeline.pairingsFailed")}
            </span>
          )}
          {linkingAvailable && linkingMode && !cueLinksFailed && neverPaired && (
            <span data-testid="tl-linking-notice" className="text-xs text-muted-foreground">
              {t("editor.timeline.neverPaired")}
            </span>
          )}
          <div className="inline-flex items-center rounded-md border border-border">
            <button
              type="button"
              aria-label={t("editor.timeline.zoomOut")}
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
              aria-label={t("editor.timeline.zoomIn")}
              onClick={() => applyZoom(pxPerSec * 1.3)}
              className="px-1.5 py-1 text-foreground/70 hover:bg-muted"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Stage 3: the vertical zoom, in the horizontal one's chrome and
              immediately beside it — same stepper, the other axis.
              "Shorter rows"/"Taller rows" rather than another zoom pair: two
              controls both labelled some flavour of "zoom" leave a user
              hovering to find out which is which, and the readout says the
              number of pixels for the same reason — a second "1.0×" next door
              to the first is unreadable at a glance. */}
          <div className="inline-flex items-center rounded-md border border-border">
            <button
              type="button"
              aria-label={t("editor.timeline.rowsShorterAria")}
              title={t("editor.timeline.rowsShorterTooltip")}
              onClick={() => applyRowHeight(rowH / 1.3)}
              className="px-1.5 py-1 text-foreground/70 hover:bg-muted"
            >
              <ChevronsDownUp className="h-3.5 w-3.5" />
            </button>
            <span className="border-x border-border px-2 font-mono text-[11px] tabular-nums text-muted-foreground">
              {rowH}px
            </span>
            <button
              type="button"
              aria-label={t("editor.timeline.rowsTallerAria")}
              title={t("editor.timeline.rowsTallerTooltip")}
              onClick={() => applyRowHeight(rowH * 1.3)}
              className="px-1.5 py-1 text-foreground/70 hover:bg-muted"
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
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
          className="shrink-0 border-b border-border bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          {t("editor.timeline.videoHiddenNote")}
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
          className="flex shrink-0 items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-1.5 text-[11px] text-muted-foreground"
        >
          <span className="min-w-0 flex-1">
            {t("editor.timeline.measureNote", { count: legacyMeasure.count })}
          </span>
          <AppTooltip
            content={
              !online
                ? t("editor.timeline.measureOfflineTooltip")
                : batchProgress != null
                  ? t("editor.timeline.measureBusyTooltip")
                  : t("editor.timeline.measureTooltip")
            }
          >
            <button
              type="button"
              data-testid="tl-measure-run"
              disabled={!online || batchProgress != null}
              onClick={legacyMeasure.onMeasure}
              className="rounded border border-border bg-background px-2 py-0.5 font-medium text-foreground/80 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("editor.timeline.measureNow")}
            </button>
          </AppTooltip>
          <button
            type="button"
            aria-label={t("editor.timeline.measureDismiss")}
            data-testid="tl-measure-dismiss"
            onClick={() => setMeasureDismissedFor(fileId)}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* timeline */}
      {/* Stage 3, and the layout the whole round turns on: the TRACK COLUMN
          owns both scroll axes and the gutter beside it is clipped and slaved
          to it. The obvious arrangement — one scroller around both columns,
          ruler `sticky top-0` — cannot work: this column is `overflow-x-auto`,
          CSS computes the unspecified axis to `auto`, so it is ALREADY a
          scrollport in y and establishes the sticky context for everything
          inside it. A sticky ruler would stick to a box with no y-overflow and
          never offset. There is no way out of that (`overflow-y: visible`
          beside `overflow-x: auto` is DEFINED to compute back to `auto`), so
          the gutter follows the scroller rather than sharing one with it.

          `grid-rows-[minmax(0,1fr)]` is load-bearing, not tidiness: with an
          implicit `auto` row the row sizes to its content, the columns overflow
          the panel, and there is NO SCROLLBAR AT ALL — a failure that looks
          exactly like the resizable panel not having taken. */}
      <RowMetricsContext.Provider value={rowMetrics}>
        <div className="grid min-h-0 flex-1 grid-cols-[128px_1fr] grid-rows-[minmax(0,1fr)]">
          {/* NOTHING MAY BE INSERTED BETWEEN THESE TWO COLUMNS, and the gutter
              must not grow a testid: TimelineEditor.test.tsx reads the labels
              through `tl-scroll`'s previousElementSibling, on the stated
              contract that the gutter renders exactly the DOM the hardcoded
              rows did. */}
          <div ref={gutterRef} className="overflow-hidden border-r border-border bg-muted/20">
            {/* The ruler's opposite number. It does NOT translate — the labels
                below slide under it exactly as the chips slide under the sticky
                ruler — which is why it has to be opaque. The column's
                `bg-muted/20` is a tint over the page, so a label scrolling
                through it would still be perfectly legible; this paints
                `bg-background` and lays the same tint back over it, reproducing
                today's composite to the pixel. */}
            <div className="relative z-10 h-7 border-b border-border bg-background">
              <div className="absolute inset-0 bg-muted/20" />
            </div>
            {/* Slaved to the track column's scrollTop by handleTrackScroll.
                `role="list"` only when the rows can actually be reordered: it
                is the reorder affordance's announcement, and a list of one
                immovable thing after another is noise. (The untimed strip below
                is a sibling in here and carries no listitem role — it is not a
                track, and it cannot be moved.) */}
            <div
              ref={gutterInnerRef}
              role={onReorderTrack ? "list" : undefined}
              aria-label={onReorderTrack ? t("editor.timeline.gutterReorderAria") : undefined}
            >
              {/* The gutter is the track list, exactly as the lanes beside it are —
                  one row here per row there, in the same order, off the same
                  array. `name` comes from the track and not from the kind, which
                  is the whole seam a rename arrives through. */}
              {tracks.map((track, index) => {
                const render = TRACK_RENDER[track.kind]
                // EVERY audible row gets its speaker, in every arrangement.
                //
                // Stage 2 withheld this one on a subtitle file, on the reasoning
                // that the button could only reach the play queue's own elements
                // and the film's sound was not one of them. That stopped being
                // true in the same stage: MediaVideoPane reads the audibility
                // flag directly and mutes its element from it, so this button
                // silences the film perfectly well. The mute then spent a day in
                // the video pane's header and a few hours on the picture itself
                // before landing back here (2026-08-14, Sam) — this row IS the
                // source audio, the way the row below is the target audio, and
                // the pair should carry the same control.
                //
                // The playback bar's mute is the same flag, not a second one.
                const speaker = render.audibilityKey
                return (
                  <LaneLabel
                    key={track.id}
                    name={track.name}
                    sub={render.sub}
                    dot={render.dot}
                    trailing={
                      speaker
                        ? speakerToggle(
                            speaker,
                            // On a subtitle file this row's cues are timings over
                            // the FILM's soundtrack, and that is what the button
                            // silences. Saying "source audio" there would be
                            // true and useless; the operator wants to know the
                            // film is about to go quiet.
                            speaker === "source" && subtitleFileWithFootage
                              ? "the film's own sound"
                              : render.speakerName,
                          )
                        : undefined
                    }
                    reorder={
                      onReorderTrack
                        ? {
                            trackId: track.id,
                            liftPx: trackDrag?.fromIndex === index ? trackDrag.dy : null,
                            dropEdge:
                              dropBoundary === index
                                ? "top"
                                : dropBoundary === tracks.length && index === tracks.length - 1
                                  ? "bottom"
                                  : null,
                            onPointerDown: (e) => beginTrackDrag(index, e),
                            onKeyDown: (e) => onTrackLabelKeyDown(index, e),
                          }
                        : undefined
                    }
                  />
                )
              })}
              {/* SUB-37: the untimed parking strip only exists when something is
                  actually untimed — an always-on empty row read as a mystery. */}
              {untimed.length > 0 && (
                <div className="flex h-12 flex-col justify-center px-3">
                  <span className="text-xs font-semibold text-foreground">{t("editor.timeline.laneUntimed")}</span>
                  <span className="text-[10px] text-muted-foreground">{t("editor.timeline.laneUntimedSub")}</span>
                </div>
              )}
            </div>
          </div>
          {/* `overflow-auto` says out loud what `overflow-x-auto` already
              computed to. `overscroll-contain` is new and deliberate: now that
              there is somewhere to scroll vertically, running out of track
              would otherwise chain the gesture into the page behind it and
              scroll the whole workspace away. */}
          <div
            ref={scrollRef}
            data-testid="tl-scroll"
            className="overflow-auto overscroll-contain"
            onScroll={handleTrackScroll}
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
              {/* The drop indicator's other half. THE ROWS DELIBERATELY DO NOT
                  PART AND THE LANES DO NOT MOVE while a track is dragged: the
                  lanes carry absolutely positioned cards on a pixel timeline
                  with a playhead drawn across the whole stack, so animating
                  four of them apart would mean re-laying out every card sixty
                  times a second and visually severing the playhead for the
                  length of the drag. One 2px line in each column says where the
                  row will land, and on release both columns move together
                  because they are rendered off the same array. */}
              {dropLineContentY != null && (
                <div
                  aria-hidden
                  data-testid="tl-track-drop-line-lane"
                  className="pointer-events-none absolute inset-x-0 z-30 h-0.5 bg-sky-500"
                  style={{ top: `${dropLineContentY}px` }}
                />
              )}
            </div>
          </div>
        </div>
      </RowMetricsContext.Provider>

      {/* AQU-928: the section-scoped transcribe row. Above the timing row so
          the numbers stay flush against the text band they head. */}
      {onTranscribeSections && (
        <div className="shrink-0">
          <TimelineTranscribeBar
            selectedCount={selectedIds.length}
            eligibleCount={transcribeTargetIds.length}
            busy={batchProgress != null}
            onTranscribe={() => onTranscribeSections(transcribeTargetIds)}
            onClear={() => {
              setSelectedId(null)
              setExtraIds([])
            }}
          />
        </div>
      )}
      {/* 2026-08-08 (Sam): the NUMBERS stay with the timeline — they measure
          the chips above, not the dialogue below — and close this section off
          at its bottom edge. The wrapper is the row's `shrink-0`: it is chrome,
          and the panel's height belongs to the tracks. */}
      <div className="shrink-0">
        <TimelineTimingRow cell={currentCell} chipStats={currentChipStats} audioMissing={audioMissing} />
      </div>
      {/* The section label, the line's own context and the segment navigator
          head the TEXT column of the band below, opposite the Video header.
          The slot is owned by the workspace; portal when it exists, render
          inline when this editor is mounted alone (tests). */}
      {chipStripSlot
        ? createPortal(<MediaTextHeader {...mediaTextHeaderProps} />, chipStripSlot)
        : <MediaTextHeader {...mediaTextHeaderProps} />}
      {/* Both lanes' clicks arrive at one `toggleLink`, so one dialog covers
          making and breaking alike. Rendered unconditionally and gated on its
          own `open` — a dialog that unmounts mid-animation flickers. */}
      <CueLinkConfirmDialog
        open={pendingLink != null}
        linking={pendingLink?.linking ?? false}
        subtitle={
          pendingLink
            ? (() => {
                const c = subtitle.find((x) => x.id === pendingLink.textCellId)
                return c ? { startSec: c.startTime ?? 0, text: c.original ?? "" } : null
              })()
            : null
        }
        cue={
          pendingLink
            ? (() => {
                const c = (audioCues ?? []).find((x) => x.id === pendingLink.cueCellId)
                return c ? { startSec: c.startTime ?? 0, text: c.original ?? "" } : null
              })()
            : null
        }
        onConfirm={commitPendingLink}
        onCancel={() => setPendingLink(null)}
      />
    </div>
  )
}
