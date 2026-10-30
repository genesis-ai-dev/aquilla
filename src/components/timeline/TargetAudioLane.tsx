// The Target-audio track (rounds 5-7): one chip per media section that has dub
// audio — a recorded take (mic icon) or a generated voice (sparkles). DAW
// model (round 7): chips are CLIP-ZERO ANCHORED — width = the recording's
// trim-aware length, left = anchor + head-trim; the body drag MOVES the clip
// (anchor), the edge handles TRIM it non-destructively (the remaining audio
// never moves in time) — amber when running long, red when overlapping a
// neighbour's dub (both will sound). Length is never clamped. At rest the
// chip AT FAULT is the one drawn short (2026-08-08), cut at the edge of the
// neighbour it intrudes on — or, when the two intrude on each other, at the
// pair's meet point (2026-08-27, `dualFaultMeetSec`: the shared source border
// when their sections touch, the midpoint of overlap-within-the-gap when they
// don't) — with an outward chevron on the cut; hover restores the true length.

import { useEffect, useRef, useState } from "react"
import type { ReactNode } from "react"
import { AudioLines, Check, CheckCheck, ChevronsLeft, ChevronsRight, CloudAlert, CloudUpload, CopyPlus, Ellipsis, Mic, Pencil, Play, Scissors, Sparkles, Square, Trash2, VolumeX, X } from "lucide-react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  CHANGE_VOICE_QUALITIES,
  type ChangeVoiceBlocker,
  type ChangeVoiceQuality,
} from "@/lib/audio/change-voice"
import { CHANGE_VOICE_QUALITY_LABEL } from "@/lib/store/change-voice-quality"
import { cn } from "@/lib/utils"
import { AppTooltip } from "@/components/ui/tooltip"
import { toast } from "@/components/ui/toast"
import { Spinner } from "@/components/ui/spinner"
import { CloneFromTakeButton } from "@/components/cell/CloneFromTakeButton"
import { useVoicingAs } from "@/lib/audio/voicing-as"
import { MISSING_AUDIO_MESSAGE } from "@/lib/audio/play-queue"
import { TimelineSlotButton } from "./TimelineSlotButton"
import { MIN_SLOT_PX, useHotSlot } from "./slot-hover"
import { isVisible, secToPx, pxToSec, chipRadiusPx } from "@/lib/timeline/scale"
import {
  MIN_CHIP_GRIP_H_PX,
  MIN_CHIP_META_H_PX,
  slotButtonPx,
  slotIconPx,
  TL_CHIP_BOX_CLASS,
  TL_ROW_H_CLASS,
} from "@/lib/timeline/row-metrics"
import { useRowMetrics } from "./useRowMetrics"
import {
  targetChipGeom,
  chipOverflowState,
  chipOverlaps,
  chipTrespass,
  dualFaultMeetSec,
  maxAudibleStartSec,
  minAudibleEndSec,
  MIN_TARGET_LEN_SEC,
  type TargetChipGeom,
} from "@/lib/timeline/lane-timing"
import { clampMoveStart, movedTakePlace, pieceLeadInTakeSec, type TakePlace } from "@/lib/timeline/take-place"
import { sourceClipAudioForCell } from "@/lib/audio/track-audio"
import { canCutAt } from "@/lib/audio/cut-take"
import { pieceTrimLimitsMs } from "@/lib/sync/cell-audio-read-types"
import { takeBaseLabel } from "@/lib/audio/take-groups"
import { snapSpan, SNAP_THRESHOLD_PX } from "@/lib/timeline/snap"
import { trackChipClass, trackChipPlayingClass, trackHueVars } from "@/lib/timeline/track-colors"
import { DragTimeChip } from "./DragTimeChip"
import { TargetChipWaveform } from "./TargetChipWaveform"
import { useChipPreview, type ChipPreview, type ChipPreviewFactory } from "./useChipPreview"
import { previewWindowForGeom } from "@/lib/audio/clip-preview-window"
import { pauseAllTransports } from "@/lib/audio/transport-pause"
import type { ClipPreviewHandle } from "@/lib/audio/clip-preview"
import { useTargetChipPeaks } from "./useTargetChipPeaks"
import { chipWaveformWindow } from "@/lib/timeline/chip-waveform"
import { WAVEFORM_BINS } from "@/lib/audio/peaks-loader"
import type { PeaksTarget } from "@/lib/audio/peaks-loader"
import type { FrontierSession } from "@/lib/frontier/types"
import type { TimelineLayout } from "@/lib/timeline/layout"
import type { ProgrammeSlot } from "@/lib/timeline/programme"
import type { CellData } from "@/hooks/useCells"
import { useT } from "@/lib/i18n/I18nProvider"
import { takeBadgeState } from "@/components/cell/audio-validation-state"
import { isHiddenCell } from "@/lib/cells/hidden"
import { CHIP_PLAYLINE_CLASS, CHIP_VALIDATED_BADGE_CLASS, chipCornerButtonClass } from "@/components/audio/chip-classes"
import type { TakeVoiceNote } from "@/lib/audio/take-voice"

/** AQU-1758: the take's-voice label needs a full-height chip (46 px by
 *  default) to sit under the sparkle, and room for a short name. */
const TAKE_VOICE_LABEL_MIN_H_PX = 44
const TAKE_VOICE_LABEL_MIN_W_PX = 56

export interface TargetAudioItem {
  cell: CellData
  kind: "take" | "generated"
  /** The active dub attachment's id (for duration/trim lookup). */
  audioId: string
  /** AQU-1767: which piece of a cut take this is (0-based, clip order), and
   *  how many there are. Absent for a take that was never cut. */
  pieceIndex?: number
  pieceCount?: number
}

export interface TargetAudioLaneProps {
  /** Already derived + time-sorted (from the dialogue lane). */
  items: TargetAudioItem[]
  /** SUB-53: resolves chip geometry — the frozen file clock in dubbing mode,
   *  the laid-out programme in audio-first. Absent = dubbing. */
  layout?: TimelineLayout
  /**
   * AQU-2267: the OTHER timing's layout, built when asked (only a drop
   * asks). A move moves the take by the same distance there too, held by that
   * timing's own limits (its line, its neighbours on this track), so a move
   * states the take's place in both. Absent (this lane's own tests), the
   * other place moves by the same distance with no limits of its own.
   */
  getOtherLayout?: () => TimelineLayout
  pxPerSec: number
  viewStartSec: number
  viewEndSec: number
  selectedId: string | null
  /**
   * AQU-1767 (Sam, 2026-10-14): the line whose take ON THIS LANE is the
   * selected take — the one S splits at the playhead. A selected line alone
   * (from its card or its row) lights its takes more quietly, because S does
   * not act on them.
   */
  selectedTakeCellId?: string | null
  /** The verse the transport is WAITING ON (queue state "loading") — its chip
   *  shows a small spinner while the readiness gate parks. */
  loadingCellId?: string | null
  /** Cells whose dub audio definitively 404'd — their chips carry a missing
   *  badge (decision 2026-08-05). */
  missingCellIds?: ReadonlySet<string>
  editable: boolean
  /**
   * DOES THE THING DRIVING PLAYBACK HONOUR A DUB'S TRIMS?
   *
   * Renamed from `externalMaster` in stage 6B, because the old name had become
   * a lie: it asked "is a film the master", when the question the one consumer
   * below actually asks is whether the trim handles would tell the truth. Two
   * masters honour trims by firing takes through the overlay pool — the linked
   * PICTURE (video-first) and the VIRTUAL clock (a file with timings and no
   * media at all, stage 3h) — and the second of those was invisible to this
   * gate for a whole round, so a VTT-only file offered no handles anywhere
   * (Sam, 2026-08-27: "trimming just doesn't work... there was no film").
   *
   * The master that does NOT honour them is the queue playing an imported
   * source recording: a take-only section sounds through that master, which
   * ignores dub trims, so a handle there would move nothing. That case keeps
   * its withheld handles — see `resizable` below.
   */
  masterHonorsTrims?: boolean
  snapEnabled?: boolean
  onSelect(id: string): void
  /** AQU-1767 (Sam, 2026-10-14): a clean click on a take selects THAT take,
   *  after `onSelect` has selected its line. */
  onSelectTake?(cellId: string): void
  /** A double-click on a take jumps playback to its line (a single click
   *  selects it and leaves the playhead where it is — Sam, 2026-10-14). */
  onSeek?(id: string): void
  /** Round 6/7: move a chip — the dub's new CLIP-ZERO ANCHOR (file seconds).
   *
   *  AQU-646 stage 3: it also carries the TAKE being moved, not just its line. Placement is
   *  stored per take now — two tracks share a line, and a per-cell anchor
   *  would make dragging one chip move the other.
   *
   *  AQU-2267: and `place`, what to store — the take's place in BOTH timings
   *  after the move (`movedTakePlace`). `anchorSec` stays the anchor in the
   *  timing the move was made in. */
  onRetimeTarget?(cellId: string, anchorSec: number, audioId: string, place: TakePlace): void
  /** Round 7: trim a chip — the COMPLETE desired trim state (both keys
   *  resolved; undefined clears a key back to the clip edge). */
  onTrimTarget?(cellId: string, audioId: string, trims: { trimStartMs?: number; trimEndMs?: number }): void
  /** AQU-1767: the blade is in hand — a click on a chip cuts it there. */
  bladeActive?: boolean
  /** AQU-1767: cut one take at `atMs`, a position in its own audio. */
  onCutTarget?(cellId: string, audioId: string, atMs: number): void
  /** AQU-1767: what a right-click on a take offers. Absent, it offers nothing. */
  takeMenu?: TakeMenuActions
  /** AQU-1758: a take's voice, when it is not the line's — named on its clip. */
  takeVoiceFor?(cell: CellData, audioId: string): TakeVoiceNote | null
  /** AQU-1758: where the playhead is on this lane's clock, read when a take's
   *  ⋯ opens its menu (Split there splits at the playhead). */
  getPlayheadSec?(): number
  /** Round 8b: corner mic button — opens the recording modal on this cell. */
  onOpenRecording?(cellId: string): void
  /** SUB-51: timed media sections with NO dub yet. Their empty space in this
   *  row reveals a record button on hover, so starting a line doesn't need a
   *  trip to the detail pane. */
  emptyCells?: CellData[]
  /** AQU-646: stretches of film with no cell at all. The mic here creates the
   *  blank line first and then opens the recorder. */
  emptySpans?: readonly { startSec: number; endSec: number }[]
  onAddLineAndRecord?(startSec: number, endSec: number): void
  /** AQU-646: what the waveform loader needs to fetch take bytes. All three
   *  absent = no waveforms, which is what this lane's own tests get. */
  projectId?: string | null
  /**
   * The project's required number of audio validators, for the chip's tick.
   *
   * REQUIRED, deliberately. It was optional with a default of 1, and both of
   * TimelineEditor's lane sites simply never passed it — so every clip in the
   * product measured itself against a threshold of one and wore a "fully
   * validated" tick after a single vote, on projects asking for two. A default
   * is exactly what let that go unnoticed: the lane looked like it was doing
   * the comparison, and it was, against the wrong number. Now the compiler
   * asks every caller.
   */
  validationRequirementAudio: number
  fileId?: string | null
  session?: FrontierSession | null
  /** Test/story seam: supplied peaks bypass the loader entirely, so a test can
   *  assert the drawing without mocking OPFS, the network or AudioContext. */
  peaksByAudioId?: ReadonlyMap<string, Float32Array>
  /** Test/story seam, same rule: a supplied factory bypasses the engine
   *  binding, so a test can hold a chip in the PLAYING state — the real engine
   *  ends instantly under happy-dom (no AudioContext), which is right for the
   *  button tests and useless for the mini-playhead's. */
  previewFactory?: ChipPreviewFactory
  /** AQU-646 stage 2: the palette id this track has been given, if any. Absent
   *  or unknown draws the shipped emerald/violet pair — see track-colors. */
  color?: string | null
  /**
   * AQU-646 stage 2: this lane's root testid.
   *
   * DEFAULTS TO THE ONE THAT SHIPPED, and the default is the point: a file can
   * now hold more than one of these, so a single fixed id would give
   * `getByTestId` two matches and throw — in tests that have nothing to do with
   * the new track. The DERIVED dub row keeps `tl-target-lane` byte for byte,
   * so every existing test and browser pass is untouched, and only the added
   * tracks carry a namespaced one.
   *
   * Stage 3 note: the CHIPS still use `tl-target-<cellId>`, which is unique
   * only while one lane holds chips. When added tracks start holding takes,
   * those need namespacing the same way.
   */
  laneTestId?: string
}

type ChipDragMode = "move" | "resize-l" | "resize-r"

interface ChipGeometry {
  item: TargetAudioItem
  geom: TargetChipGeom
  section: { start: number; end: number }
  /** AQU-2215: this take's line in the programme, when there is one. The move
   *  gesture needs its start: following the recordings a take moves inside
   *  its own line, so the line's start is the floor the drag stops at. Null in
   *  dubbing mode, where there is no programme. */
  slot: ProgrammeSlot | null
  resizable: boolean
  /** SUB-53: how the translation compares to the original — audio-first shows
   *  this instead of the amber/red warnings, because running long is the
   *  expected outcome there, not a defect. Null in dubbing mode. */
  ratio: number | null
  /**
   * AQU-2252 (Sam, Oct 29): a take on a track made a LAYER while the file
   * follows its recordings. Its line does not grow to hold it, so it behaves
   * the way a take does following the source: measured against its line,
   * amber running past it, red over the next take on its track, a lead-in
   * allowed, the move clamp stopping at its neighbours.
   */
  layer: boolean
}

/**
 * AQU-1767 (Sam, 2026-10-14): the actions a take's right-click menu offers.
 * Each is optional; a missing one is simply not in the menu.
 */
export interface TakeMenuActions {
  /** Open the recorder on this line, on this take's track. */
  reRecord?(cellId: string): void
  /** Generate a new voice for this line straight away, on this take's track. */
  regenerate?(cellId: string): void
  /**
   * AQU-2026: re-voice this line's own take into its cast voice at `quality`.
   * Nothing is synthesized from text — the words and timing are kept.
   */
  changeVoice?(cellId: string, quality: ChangeVoiceQuality): void
  /**
   * AQU-2026: what Change voice can do on this line, or `null` to leave the
   * item out of the menu entirely (a line whose only sound is the film's own
   * programme audio has nothing of its own to convert).
   */
  changeVoiceState?(cellId: string): ChangeVoiceMenuState | null
  /**
   * AQU-1758: turn this line's take into a character — the New voice dialog,
   * cloning, seeded with it. (The Audio view's voice card had this.) With
   * `cloneTake`, it is the one-step clone's More options.
   */
  makeCharacter?(cellId: string): void
  /**
   * AQU-1758 / AQU-2212: "Make a character from this voice" clones THIS take
   * in one step — name it, Add to cast — in a popover at the clip.
   */
  cloneTake?(cellId: string, audioId: string, name: string): Promise<void>
  /** The name that popover suggests (who recorded the take). */
  cloneName?(cellId: string): string
  /**
   * AQU-2212: the one-click when the line's voice and its take disagree —
   * "Change to …" / "Generate · …", first in the menu. Read when the menu
   * opens; null when they agree.
   */
  lineVoice?(cellId: string): { action: "change" | "generate"; voiceName: string } | null
  applyLineVoice?(cellId: string): void
  /** Ask for a new name; `current` is the take's own name, if it has one. */
  rename?(cellId: string, audioId: string, current: string | null): void
  /** Delete this take, or this piece of a cut take. */
  remove?(cellId: string, audioId: string): void
  /** Add or withdraw your own approval of this take. */
  vote?(cellId: string, audioId: string, validated: boolean): void
  /** Whether you may vote on this take, and whether you already have. */
  voteState?(cellId: string, audioId: string): { canVote: boolean; voted: boolean }
}

/**
 * AQU-2026: why the per-line Change voice can't run. `no-take` never reaches
 * the menu — the item is left out instead.
 */
export type ChangeVoiceMenuBlocker = ChangeVoiceBlocker | "voice-reference" | "busy"

/** AQU-2026: what a take's Change voice submenu offers for one line. */
export interface ChangeVoiceMenuState {
  /** The voice the line is cast to — named in the reason the menu gives. */
  voiceName: string
  /** The quality this take was converted at, ticked in the submenu. Null when
   *  the take is not a conversion, so nothing shows as current. */
  quality: ChangeVoiceQuality | null
  /** Why Change voice can't run at each quality; null where it can. */
  blockers: Record<ChangeVoiceQuality, ChangeVoiceMenuBlocker | null>
}

function TargetAudioChip({
  chip,
  prevChip,
  prevMeetSec,
  nextChipStartSec,
  nextMeetSec,
  paintOrder,
  audioFirst,
  pxPerSec,
  selected,
  loading,
  missing,
  editable,
  snap,
  onSelect,
  onSelectTake,
  onSeek,
  onRetimeTarget,
  onTrimTarget,
  bladeActive = false,
  onCutTarget,
  takeMenu,
  takeVoice = null,
  getPlayheadSec,
  onOpenRecording,
  validationRequirementAudio = 1,
  currentUsername = "",
  peaks,
  preview,
  layout,
  getOtherLayout,
  track,
}: {
  chip: ChipGeometry
  /** AQU-2215: the lane's layout, for the one question only it can answer —
   *  what a MOVE on this chip means, and what to store for it. Absent outside
   *  a timeline (this lane's own tests), which is dubbing's own behaviour. */
  layout?: TimelineLayout
  /** AQU-2267: the other timing's layout, and every take on this track — where
   *  a move carries the take, by the same distance, held by that timing's
   *  limits. See `TargetAudioLaneProps.getOtherLayout`. */
  getOtherLayout?: () => TimelineLayout
  track: readonly TargetAudioItem[]
  // AQU-646 stage 7: NO `color` PROP. The hue reaches this chip as inherited
  // CSS custom properties set on the lane root, so there is nothing to thread
  // and nothing to keep in step — see `trackHueVars`.
  /** AQU-646: this clip's whole-clip peaks, once they have arrived. Absent
   *  means the chip draws as it always did. */
  peaks?: Float32Array
  /** AQU-646 stage 5: this clip bound to the preview engine — the play button
   *  its play button. Absent means it does not exist, which is
   *  what a lane with no project or session hands out and therefore what this
   *  lane's own tests get, exactly as with `peaks`. */
  preview?: ChipPreview
  /** The PREVIOUS chip's span — a chip can begin before its own section
   *  (end-based drag bounds), so its head can lie under this neighbour. */
  prevChip: { start: number; end: number; usingFallback: boolean } | null
  /** 2026-08-08 / 2026-08-27: when the PREVIOUS chip and this one trespass on
   *  EACH OTHER, its end is no place to yield at — both rest-cut to this
   *  shared meet point instead (`dualFaultMeetSec`, resolved once in the
   *  lane). Null whenever the pair is not mutually at fault. */
  prevMeetSec: number | null
  nextChipStartSec: number | null
  /** …and the mirror: the meet point with the NEXT chip. */
  nextMeetSec: number | null
  /** Higher paints on top — earlier-start chips cover later ones. */
  paintOrder: number
  /** SUB-53: verses are laid out end to end, so nothing overlaps and nothing
   *  "runs long". */
  audioFirst: boolean
  pxPerSec: number
  /** "take": this is the selected take (S splits it). "line": its line is
   *  selected, but not this take. */
  selected: "take" | "line" | false
  /** The transport is parked waiting on this verse's audio (slow load). */
  loading: boolean
  /** This chip's dub audio definitively 404'd. */
  missing: boolean
  editable: boolean
  snap: { enabled: boolean; candidates: number[] }
  onSelect(id: string): void
  onSelectTake?(cellId: string): void
  onSeek?(id: string): void
  /** AQU-646 stage 3: the TAKE being moved, not just its line. Placement is
   *  stored per take now — two tracks share a line, and a per-cell anchor
   *  would make dragging one chip move the other. AQU-2267: `place` is the
   *  take's place in both timings after the move. */
  onRetimeTarget?(cellId: string, anchorSec: number, audioId: string, place: TakePlace): void
  onTrimTarget?(cellId: string, audioId: string, trims: { trimStartMs?: number; trimEndMs?: number }): void
  bladeActive?: boolean
  onCutTarget?(cellId: string, audioId: string, atMs: number): void
  takeMenu?: TakeMenuActions
  /** AQU-1758: the take's voice, when it is not the line's. */
  takeVoice?: TakeVoiceNote | null
  /** AQU-1758: the playhead on this lane's clock, for the ⋯ menu's Split. */
  getPlayheadSec?(): number
  onOpenRecording?(cellId: string): void
  /** AQU-490: how many validators the project asks for on a recording. */
  validationRequirementAudio?: number
  /** Who is looking. Blank is safe — `takeState` never reads a blank name as
   *  a validator, so an absent session degrades to "not mine", never to a
   *  false single check. */
  currentUsername?: string
}) {
  const t = useT()
  const { cell } = chip.item
  const { geom, section } = chip
  // AQU-2252: the rules FOLLOWING THE RECORDINGS gives a take — its line grows
  // to hold it, so it never runs long and moves only inside its line. Every
  // take but one on a track made a layer, which keeps following the source's.
  const freeRules = audioFirst && !chip.layer
  // This chip's own take: its length, its trims and its placement. The geometry
  // and the drag both read it, so it is resolved once here.
  const chipAtt = cell.attachments?.[chip.item.audioId]
  // AQU-1767: the first (or only) piece keeps the chip's historical test id;
  // later pieces add "-p2", "-p3"… so every piece is addressable.
  const testKey = chip.item.pieceIndex ? `${cell.id}-p${chip.item.pieceIndex + 1}` : cell.id
  // AQU-2212: the voice this line is being generated or re-voiced in, if any.
  const voicingAs = useVoicingAs(cell.id)
  // AQU-1767: where the blade would cut, while it hovers over this chip.
  const [bladeX, setBladeX] = useState<number | null>(null)
  // AQU-1767: where the take was right-clicked, so "Split here" cuts there.
  // Taken on pointerdown (which precedes the context menu) and read into state
  // when the menu opens, so the menu draws with the point it will use.
  const contextXRef = useRef<number | null>(null)
  const [menuSplitAtMs, setMenuSplitAtMs] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ mode: ChipDragMode; dx: number } | null>(null)
  /**
   * AQU-646 stage 5: is THIS chip's own preview sounding?
   *
   * Driven off the handle's lifecycle rather than off "the engine is making
   * noise", which is what lets a unit test enter this state at all — happy-dom
   * has no AudioContext, so nothing here is ever audible there.
   */
  const [previewing, setPreviewing] = useState(false)
  const previewRef = useRef<ClipPreviewHandle | null>(null)
  /**
   * Fetching the clip before it can sound (2026-09-30). On a slow connection
   * that took 14.6s with the button still saying "Play this clip" — nothing on
   * screen said anything had happened. It shows a spinner now, and a second
   * press gives up the wait.
   */
  const [priming, setPriming] = useState(false)
  const primingRef = useRef<{ cancelled: boolean } | null>(null)
  useEffect(() => () => { previewRef.current?.stop() }, [])
  /** The mini-playhead's DOM node — positioned imperatively per frame, so the
   *  60Hz ride never re-renders the chip. */
  const playlineRef = useRef<HTMLSpanElement | null>(null)
  /** The chip root, for the same ride to write `--tl-play-x` — where the
   *  progress fill's gradient splits. */
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const movedRef = useRef(false)
  // AQU-646 stage 3: how tall this chip is drawn. Outside a timeline (this
  // lane's own tests) the context answers with the shipped 46px chip, so every
  // height gate below reads exactly as it did before it existed.
  const { chipH } = useRowMetrics()
  // SUB-48: this clip is saved on this device but its event is still queued.
  const pendingSync = Boolean(chipAtt?.pendingSync)
  // AQU-924: saved on this device, and its attach event will NOT reach the
  // server without user action (quarantined / out of retries).
  const syncFailed = Boolean(chipAtt?.syncFailed)
  // AQU-490: validated at a GLANCE, and deliberately not a control.
  //
  // This is a 16px hover corner with play and record already in it; a popover
  // and a vote would not fit and would fight the chip's own drag gestures.
  // The timeline's job here is to show which takes are signed off while you
  // scrub past them — the vote itself lives on the four surfaces that have
  // room for it. The source clip is excluded, so an imported film's own
  // soundtrack never wears a tick.
  const chipTake = chipAtt
  // AQU-490, corrected 2026-09-22: the SAME state machine the gutter reduces
  // through, not a boolean. A boolean could only ever mean "done", so a chip
  // wore a double check the moment ONE person had signed it off — which, at a
  // threshold of two, told the second person their work was finished before
  // they had started. Depth instead: your own vote below the threshold is a
  // single check, a met threshold is a double one, and somebody ELSE's lone
  // vote is nothing at all. (The gutter draws that last case as a filled mic;
  // the chip has no idle affordance to fill, so it stays bare.)
  const chipValidationState = chipTake
    ? takeBadgeState(chipTake, currentUsername, validationRequirementAudio)
    : null

  // AQU-1767 (Sam, 2026-10-15): a piece's cut edge trims back out only as far
  // as its neighbouring piece's edge — in the RECORDING, not on the timeline,
  // so moving pieces about changes nothing here.
  const pieceLimits = (chip.item.pieceCount ?? 1) > 1
    ? pieceTrimLimitsMs(cell.attachments as Parameters<typeof pieceTrimLimitsMs>[0], chip.item.audioId)
    : null

  // A later piece of a take is held to its line as its take is (the take may
  // not start past the line's end), so it may sit and move past that end.
  const pieceLead = (chip.item.pieceCount ?? 1) > 1 ? pieceLeadInTakeSec(cell, chip.item.audioId) : 0

  // The one span transform shared by preview and commit.
  function proposeSpan(mode: ChipDragMode, dxSec: number): { start: number; end: number } {
    const thresholdSec = SNAP_THRESHOLD_PX / pxPerSec
    if (mode === "move") {
      let start = geom.start + dxSec
      const len = geom.end - geom.start
      if (snap.enabled) {
        // Fallback-width chips sit flush on their own section's candidate
        // edges — snapping only the START edge kills the rubber-band.
        const span = geom.usingFallback ? { start, end: start } : { start, end: start + len }
        start = snapSpan(span, "move", snap.candidates, thresholdSec).start
      }
      // END-based bounds (meeting 2026-08-05): the chip may slide back into
      // the previous section's space — a long translation borrowing a short
      // neighbour's slack — but its END may not move before its section's
      // START, and its START may not move past the section's END. The epsilon
      // keeps an audible sliver in-section on both edges and scales with the
      // section so tiny sections can't pin the chip (round-7 fix).
      // 2026-08-06 (Sam): the start also may not pass EITHER NEIGHBOUR's
      // start — overlapping a neighbour's tail is a borrowable corner, but
      // leapfrogging or fully covering another chip painted as an unreadable
      // stack and can never be intentional. The rule is symmetric: the floor
      // stops a backward drag at the previous chip's start, the ceiling stops
      // a forward drag at the next chip's start. Hard floor last: audible
      // start ≥ trimStart ⇔ stored anchor ≥ 0, so nothing renders or persists
      // before file time zero.
      // `maxAudibleStartSec` / `minAudibleEndSec` ARE these two expressions,
      // extracted (see lane-timing) so the trim arms below can enforce the same
      // bound. Identical arithmetic — the second reads "this chip's END may not
      // fall below `minAudibleEndSec`", which for a fixed length is a floor on
      // its start.
      //
      // AQU-2215: NONE OF THAT APPLIES WHEN THE FILE FOLLOWS ITS RECORDINGS.
      // Every line owns its own stretch of the track there and grows to hold
      // whatever is dragged into it, so there is no neighbour to collide with
      // and no section to keep contact with — what the drag changes is the
      // pause before the take, inside its own line. One bound is left: the
      // line's own start, because a pause cannot be negative (dragging left
      // shortens it back to none and stops).
      //
      // AQU-2252: …except a take on a track made a layer, whose line does not
      // grow to hold it: every bound above applies to it, against its line.
      //
      // AQU-2267: the arithmetic is `clampMoveStart`, shared with the move's
      // other timing, which it carries the take into by the same distance.
      start = clampMoveStart(start, {
        free: freeRules,
        lineStartSec: chip.slot?.startSec ?? null,
        section,
        lenSec: len,
        prevChipStartSec: prevChip?.start ?? null,
        nextChipStartSec,
        trimStartSec: geom.trimStartSec,
        leadInTakeSec: pieceLead,
      })
      return { start, end: start + len }
    }
    if (mode === "resize-l") {
      let start = geom.start + dxSec
      if (snap.enabled) {
        start = snapSpan({ start, end: geom.end }, "resize-l", snap.candidates, thresholdSec).start
      }
      // trimStart ≥ 0 (start ≥ anchor), len ≥ min. No section term: a chip
      // may legitimately begin before its section now (end-based bounds), so
      // the left trim handle follows the CLIP, not the section. (In free
      // timing chipSection.start === geom.anchor, so this is identical there.)
      // The previous chip's start floors it too — un-trimming a head-trimmed
      // clip must not leapfrog the neighbour the move clamp just protected.
      //
      // …BUT IT STILL MAY NOT LEAVE THE SECTION ALTOGETHER (2026-08-27, found
      // by Sam). The note above defends the absence of a section FLOOR, which
      // stands. A ceiling is the other direction, and it is the bound the move
      // arm has always had: drag a chip to the move clamp's limit and then pull
      // this handle past it, and the audible span ended up entirely after its
      // own line, with no contact at all.
      // AQU-2252: following the recordings, never before the start of the
      // span the layout measures the chip against. That IS `geom.anchor` for a
      // line's main take; a layer's sample zero can sit before its line, and
      // its head trim comes back off only as far as the line's start.
      const lo = Math.max(
        geom.anchor,
        freeRules ? section.start : -Infinity,
        prevChip?.start ?? -Infinity,
        pieceLimits?.minStartMs != null ? geom.anchor + pieceLimits.minStartMs / 1000 : -Infinity,
      )
      // Floored at `lo` so the clamp cannot invert on a chip whose end already
      // sits before its section — that chip is already outside the invariant,
      // and pinning its handle is better than sending it further out.
      const hi = Math.max(Math.min(geom.end - MIN_TARGET_LEN_SEC, maxAudibleStartSec(section) + pieceLead), lo)
      start = Math.min(Math.max(start, lo), hi)
      return { start, end: geom.end }
    }
    let end = geom.end + dxSec
    if (snap.enabled) {
      end = snapSpan({ start: geom.start, end }, "resize-r", snap.candidates, thresholdSec).end
    }
    // trimEnd ≤ duration, len ≥ min — and the mirror of the ceiling above: the
    // audible END may not be pulled back before the section, or the take stops
    // touching the line it performs.
    const hi = Math.min(
      geom.durationSec != null ? geom.anchor + geom.durationSec : end,
      pieceLimits?.maxEndMs != null ? geom.anchor + pieceLimits.maxEndMs / 1000 : Infinity,
    )
    // Capped by `hi`, because the floor must never demand a LONGER clip than
    // was actually recorded: a short take on a late-starting section cannot
    // reach it, and asking would pin the handle at audio that does not exist.
    const floor = Math.min(Math.max(geom.start + MIN_TARGET_LEN_SEC, minAudibleEndSec(section)), hi)
    end = Math.max(Math.min(end, hi), floor)
    return { start: geom.start, end }
  }

  const span = drag ? proposeSpan(drag.mode, pxToSec(drag.dx, pxPerSec)) : { start: geom.start, end: geom.end }
  // SUB-53: in audio-first every verse owns its own stretch of the track, so
  // there is nothing to run past and nothing to collide with — the warnings
  // would fire on every single line and mean nothing. AQU-2252: a take on a
  // track made a layer is the exception — its line does not hold it.
  const overflow = freeRules ? "none" : chipOverflowState(span, section, prevChip, nextChipStartSec)
  const overlaps = freeRules
    ? { headSec: null, tailSec: null }
    : chipOverlaps(span, prevChip, nextChipStartSec)
  // Blame the trespasser: a warning belongs to THIS chip only for territory
  // it left its section to claim (mirrors the chipOverflowState rule). The
  // number is masked on fallback chips — never derived from a guessed width.
  // The head number depends on the PREVIOUS chip's end too, so it is also
  // masked when THAT width is a guess (starts are always measured, so the
  // tail number needs no such mask).
  const { head: headTrespass, tail: tailTrespass } = freeRules
    ? { head: false, tail: false }
    : chipTrespass(span, section, prevChip, nextChipStartSec)
  const tailOverlapSec = tailTrespass && !geom.usingFallback ? overlaps.tailSec : null
  const headOverlapSec =
    headTrespass && !geom.usingFallback && !prevChip?.usingFallback ? overlaps.headSec : null
  // AQU-2215: following the recordings, only a take that can hold a pause
  // before its line is movable — a split take's pieces and a take of unknown
  // length are placed end to end and have nowhere to go, so they keep the
  // locked chip they have always had rather than springing back from a drag.
  const canMove =
    editable && Boolean(onRetimeTarget) && (layout?.canRetimeTarget(cell, chipAtt, chip.item.audioId) ?? true)
  // SUB-48: a chip that buries a neighbour is PAINTED short so it can never
  // hide one (Sam lost a whole take under one). The logical span is untouched
  // — overflow warnings, trims, snapping and playback all still use the true
  // edges. Hovering (or dragging) reveals the full length, which is exactly
  // when the trim handles appear and must sit on the real edge. Selection
  // deliberately does NOT expand it: selection is sticky, so clicking an
  // overlong chip would re-bury the next one for as long as it stayed
  // selected — the very symptom this fixes.
  //
  // 2026-08-08 (Sam): the chip drawn short is the one AT FAULT, on the side
  // it offends — the same booleans that redden it above, so the paint and the
  // warning can never disagree about who is to blame. Before backdragging
  // existed the cut was always "the left chip yields at the next chip's
  // start", which shortens an innocent neighbour once a chip can be dragged
  // back into it.
  //
  // An offending end yields to the NEIGHBOUR'S OWN EDGE — the least it can
  // give up and still not bury it. When both chips of a pair trespass, each
  // one's edge lies inside the other, so neither is a valid place to stop:
  // they meet back to back (»|«) at the pair's shared meet point instead
  // (2026-08-27, `dualFaultMeetSec` — the midpoint of the zone inside both
  // the audible overlap and the stretch between the two sections; with
  // touching sections that IS the shared border, the old cut). Either way the
  // painted boxes end up disjoint, an innocent chip always paints its true
  // length — and hovering one of a mutually-offending pair now extends its
  // true edge visibly ACROSS the neighbour's resting cut, so the collision
  // the red warns about can actually be seen.
  // SUB-53: inert in audio-first (verses are laid out end to end) — but for a
  // take on a track made a layer (AQU-2252), which its line does not hold.
  const engaged = hovered || drag !== null
  const headCutSec = headTrespass ? (prevMeetSec ?? prevChip?.end ?? section.start) : null
  const tailCutSec = tailTrespass ? (nextMeetSec ?? nextChipStartSec ?? section.end) : null
  const paintedStart = !engaged && headCutSec != null ? headCutSec : span.start
  const paintedEnd = !engaged && tailCutSec != null ? tailCutSec : span.end
  const truncatedHead = paintedStart > span.start + 0.0005
  const truncatedTail = paintedEnd < span.end - 0.0005
  const truncated = truncatedHead || truncatedTail
  // 2026-08-27 (Sam): a white line rides the chip while ITS OWN preview plays —
  // not interactible, appears with the play button's sound, gone on stop or
  // end. Driven from the ENGINE's clock (`positionSec` is clip seconds, null
  // until sound actually starts — a wall clock would lead by the decode
  // latency), converted here to a left offset inside the painted box; the
  // chip's own overflow-hidden crops it when the box is drawn short. Position
  // lands on the node imperatively so the ride never re-renders the chip.
  useEffect(() => {
    if (!previewing) return
    // Held for the cleanup: the ref's current can have moved on by then.
    const chipEl = chipRef.current
    let raf = 0
    const tick = () => {
      const el = playlineRef.current
      const pos = previewRef.current?.positionSec() ?? null
      if (el) {
        if (pos == null) {
          el.style.opacity = "0"
        } else {
          el.style.opacity = "1"
          el.style.left = `${secToPx(geom.anchor + pos - paintedStart, pxPerSec)}px`
        }
      }
      // The progress fill's split point. No position yet = 0px = the whole
      // chip at the "not yet" rung — press feedback while the decode runs.
      chipEl?.style.setProperty(
        "--tl-play-x",
        pos == null ? "0px" : `${Math.max(0, secToPx(geom.anchor + pos - paintedStart, pxPerSec))}px`,
      )
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      chipEl?.style.removeProperty("--tl-play-x")
    }
  }, [previewing, geom.anchor, paintedStart, pxPerSec])
  // The height term is the same argument as the width one: a trim handle is a
  // target you have to hit, and on a compact band it is smaller than the
  // pointer that has to find it.
  // AQU-1767: with the blade in hand the chip is a cutting surface — no trim
  // handles to catch the pointer, and no move.
  const blade = bladeActive && editable && Boolean(onCutTarget)
  // AQU-1767: a take only has a menu where there is something in it to do.
  const hasMenu = editable && (Boolean(onCutTarget) || Boolean(takeMenu && Object.keys(takeMenu).length > 0))
  /** The take-relative ms under a pointer x, and whether a cut there is legal. */
  const bladeAt = (clientX: number): { atMs: number; ok: boolean; x: number } | null => {
    const el = chipRef.current
    if (!el) return null
    const x = clientX - el.getBoundingClientRect().left
    const sec = paintedStart + pxToSec(x, pxPerSec)
    const atMs = (sec - geom.anchor) * 1000
    return { atMs, ok: canCutAt(chipTake, atMs), x }
  }
  const cutRef = useRef(false)
  // AQU-1758: the menu opened from the ⋯, with Split at the playhead when the
  // playhead is inside this take (null: Split is offered but cannot cut here).
  const moreOpenRef = useRef<{ atMs: number | null } | null>(null)
  const [menuFromMore, setMenuFromMore] = useState(false)
  // AQU-2212: the line's one-click, read as the menu opens (it resolves the
  // line's takes, which is too much to do for every clip on every render).
  const [menuLineVoice, setMenuLineVoice] = useState<{ action: "change" | "generate"; voiceName: string } | null>(null)
  // AQU-1758 / AQU-2212: the one-step clone, open at this clip.
  const [cloneOpen, setCloneOpen] = useState(false)
  function openMenuFromMore(e: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) {
    e.preventDefault()
    e.stopPropagation()
    const sec = getPlayheadSec?.()
    let atMs: number | null = null
    if (sec != null && Number.isFinite(sec) && sec > geom.start && sec < geom.end) {
      const ms = (sec - geom.anchor) * 1000
      if (canCutAt(chipTake, ms)) atMs = ms
    }
    moreOpenRef.current = { atMs }
    const r = e.currentTarget.getBoundingClientRect()
    chipRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.bottom,
    }))
  }
  const canResize =
    !blade && editable && Boolean(onTrimTarget) && chip.resizable &&
    chipH >= MIN_CHIP_GRIP_H_PX &&
    secToPx(geom.end - geom.start, pxPerSec) >= 24

  function beginDrag(mode: ChipDragMode, e: React.PointerEvent) {
    if (blade) {
      // AQU-1767: the blade cuts where it lands, on the primary button only.
      if (mode !== "move" || e.button !== 0 || e.ctrlKey) return
      e.stopPropagation()
      const at = bladeAt(e.clientX)
      if (at?.ok) {
        cutRef.current = true
        onCutTarget?.(cell.id, chip.item.audioId, at.atMs)
      }
      return
    }
    if (mode === "move" ? !canMove : !canResize) return
    // Primary button only, and not a macOS context-click — see the identical
    // guard in TimelineCard.beginDrag for why this is a real bug and not
    // hardening. A right-drag on a take chip moves or trims it today.
    if (e.button !== 0 || e.ctrlKey) return
    e.stopPropagation()
    const startX = e.clientX
    try {
      ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
    } catch {
      /* happy-dom / unsupported — window listeners still work */
    }
    setDrag({ mode, dx: 0 })
    movedRef.current = false

    const onMove = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - startX) > 3) {
        // ON THE THRESHOLD, NOT ON POINTERDOWN. A press that never becomes a
        // drag must stay exactly the click it always was — including that it
        // does not stop the film.
        //
        // The tape-noise grains this used to start are gone (Sam, 2026-08-28:
        // "it actually just sounds awful"). Trimming is silent now; the
        // waveform and the drag readout are the feedback. The PAUSE stays and
        // is now its own rule rather than a consequence: starting to edit a
        // take is a reason to stop playing it, and leaving the transport
        // running under a trim would be a behaviour change nobody asked for.
        if (!movedRef.current && mode !== "move") pauseAllTransports()
        movedRef.current = true
      }
      const dx = ev.clientX - startX
      setDrag((d) => (d ? { ...d, dx } : d))
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      setDrag(null)
      const s = proposeSpan(mode, pxToSec(ev.clientX - startX, pxPerSec))
      if (mode === "move") {
        // AQU-2215: the layout inverts the drag, because only it knows what
        // clock the chip was drawn on — the file clock in dubbing, the
        // programme clock when following the recordings, where what moved is
        // the take's pause before its line. Either way what comes back is the
        // FILE-clock anchor, whose offset from the line's start is stored.
        //
        // AQU-2267 (Sam, Oct 29): and the take moves by the same distance in
        // the OTHER timing, held by that timing's own limits — so the move
        // states its place in both. A drag that asks for the place the take
        // already has in this timing — a nudge under the pause threshold, say
        // — changes nothing and records no history step. (It used to be
        // compared with the take's place FOLLOWING THE SOURCE, so following
        // the recordings such a nudge put a take that led its line back on
        // its line's start.)
        const moved = movedTakePlace({
          here: layout,
          other: getOtherLayout?.(),
          track,
          take: chip.item,
          fromStartSec: geom.start,
          toStartSec: s.start,
        })
        if (!moved) return
        onRetimeTarget?.(cell.id, moved.anchorSec, chip.item.audioId, moved.place)
        return
      }
      // Resize = trim. Commit the COMPLETE trim state; at-the-edge clears.
      const trimStartMs = Math.round((s.start - geom.anchor) * 1000)
      const trimEndMs = Math.round((s.end - geom.anchor) * 1000)
      const durationMs = geom.durationSec != null ? Math.round(geom.durationSec * 1000) : null
      const changed = Math.abs(s.start - geom.start) > 0.0005 || Math.abs(s.end - geom.end) > 0.0005
      if (!changed) return
      onTrimTarget?.(cell.id, chip.item.audioId, {
        trimStartMs: trimStartMs <= 10 ? undefined : trimStartMs,
        trimEndMs: durationMs != null && trimEndMs >= durationMs - 10 ? undefined : trimEndMs,
      })
    }
    const onCancel = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      setDrag(null)
      // Nothing is committed: the pointer was taken away, so there is no
      // release position to read as intent.
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
  }

  // AQU-646: NO KIND GLYPH IN THE CHIP (Sam, 2026-08-24). A mic or sparkles sat
  // dead centre — which is exactly where speech waveforms peak — so it fought
  // the one thing the chip is now for. The emerald/violet tint already says
  // which kind this is, and `data-kind` still says it to tests and to anyone
  // inspecting. Note the hover-record mic further down is a different control
  // (an action, not a label) and stays.
  const overflowSec = span.end - section.end
  const paintedPx = Math.max(10, secToPx(paintedEnd - paintedStart, pxPerSec))
  const fullPx = secToPx(geom.end - geom.start, pxPerSec)
  // AQU-646: the waveform's window into this clip. Computed from the PAINTED
  // edges, so a chip cut short by the at-fault rule shows exactly the audio it
  // is drawn over — and hovering, which restores the true edges, widens the
  // window in place without moving a single bar that was already visible.
  // Null whenever the clip's length was never measured: there is no honest
  // mapping from bins to seconds, and a waveform scaled to a guessed width
  // would make a guess look measured.
  //
  // Computed inline rather than in a `useMemo`: this project runs the React
  // Compiler, and a manual memo here made it give up on the whole component
  // ("existing memoization could not be preserved"), which costs far more than
  // the handful of arithmetic ops it was saving. The expensive part — building
  // the path string — is memoised inside TargetChipWaveform, where the inputs
  // are primitives and one stable array.
  const waveWindow =
    peaks && peaks.length > 0
      ? chipWaveformWindow({
          geom,
          paintedStart,
          paintedEnd,
          drag: drag ? { mode: drag.mode, spanStart: span.start } : null,
          bins: peaks.length,
        })
      : null
  const waveform = peaks && waveWindow ? { peaks, ...waveWindow } : null
  // The top-left corner is a single PRIORITY slot — one glyph at a time:
  // missing (permanent, actionable) beats loading (transient seconds) beats
  // saving (informational). Same width discipline as before: the glyph needs
  // room in the PAINTED box, and the hover mic button must leave the corner
  // alone whenever any glyph wants it.
  // AQU-924: `syncFailed` ranks with `missing` — both are permanent and
  // actionable, and unlike "saving" this clip is NOT on its way anywhere. It
  // outranks loading: a spinner over a take that will never sync is a lie.
  const leftGlyph: "missing" | "syncFailed" | "loading" | "saving" | null =
    missing ? "missing" : syncFailed ? "syncFailed" : loading ? "loading" : pendingSync ? "saving" : null
  // AQU-646 stage 3: everything on this chip beyond its kind icon and its
  // colours — the "?" unknown-length badge, that corner priority slot, the
  // hover record button — is fixed-size furniture pinned near the top edge, so
  // on a short chip the chip's own overflow-hidden clips it to a sliver of a
  // circle. Below the meta height they all go.
  //
  // What deliberately STAYS at any height, because it is load-bearing and
  // costs nothing: the kind icon, the amber soft-overflow ring, the red
  // overlap body and the truncation chevrons. A row squeezed down to colour
  // bands must still be able to say "these two dubs collide".
  const fitsBadges = chipH >= MIN_CHIP_META_H_PX
  const showLeftGlyph = leftGlyph != null && fitsBadges && paintedPx >= 20
  // AQU-646 stage 5. Withheld while a state glyph holds the corner — see the
  // button's own comment — and needing the same room the record mic does.
  // Sam's decision: a hidden line's takes are drawn faded, and neither play
  // nor take a new recording from here.
  const hiddenLine = isHiddenCell(cell)
  const showPlayButton = !hiddenLine && Boolean(preview) && leftGlyph == null && fitsBadges && fullPx >= 28
  // AQU-1758 (Sam, decision 4): the take's menu from a ⋯ in its top-right
  // corner, on hover — the same menu a right-click opens. Like the other
  // corner buttons it is one fixed size whatever the take's width, so a
  // narrow take gets the same button; only a row too short for badges hides it.
  const showMoreButton = hasMenu && fitsBadges
  const showRecordButton =
    !hiddenLine &&
    editable &&
    Boolean(onOpenRecording) &&
    fitsBadges &&
    // Two corners want the width now, not one — and the ⋯ beside the mic.
    fullPx >= (leftGlyph != null || showPlayButton ? 46 : 28) + (showMoreButton ? 18 : 0)

  async function togglePreview() {
    if (previewRef.current) {
      previewRef.current.stop()
      previewRef.current = null
      setPreviewing(false)
      return
    }
    // A press while the clip is still arriving gives up waiting for it.
    if (primingRef.current) {
      primingRef.current.cancelled = true
      primingRef.current = null
      setPriming(false)
      return
    }
    if (!preview) return
    // ASK FIRST, AND SAY SO WHEN THE ANSWER IS NO (2026-08-28). This used to
    // play straight into whatever happened: a clip nobody has measured that is
    // over the byte ceiling is refused deep inside the decode path, so the
    // button made no sound and offered no reason. The device is already
    // resumed by the pointerdown handler, which runs inside the gesture, so
    // awaiting here costs nothing a browser cares about.
    const attempt = { cancelled: false }
    primingRef.current = attempt
    setPriming(true)
    let ready: Awaited<ReturnType<typeof preview.prime>>
    try {
      ready = await preview.prime()
    } finally {
      if (primingRef.current === attempt) {
        primingRef.current = null
        setPriming(false)
      }
    }
    if (attempt.cancelled) return
    if (ready !== "ready") {
      toast.add({
        type: "info",
        title: t(
          ready === "too-long"
            ? "workspace.targetAudioLane.previewTooLong"
            : ready === "too-large"
              ? "workspace.targetAudioLane.previewTooLarge"
              : "workspace.targetAudioLane.previewUnavailable",
        ),
        description:
          ready === "too-large"
            ? t("workspace.targetAudioLane.previewTooLargeDetail")
            : undefined,
      })
      return
    }
    // THE CLIP AS THE TIMELINE DRAWS IT — `takeTrims` gives every recorded take
    // a trim at birth, so this is the ordinary case rather than an edge one.
    const handle = preview.play(previewWindowForGeom(geom), {
      onEnded: () => {
        previewRef.current = null
        setPreviewing(false)
      },
    })
    // ONLY IF IT IS ACTUALLY SOUNDING. An engine with nowhere to play fires
    // `onEnded` SYNCHRONOUSLY and hands back a silent handle; storing that left
    // a dead one in the ref, and every press afterwards took the stop branch
    // above and did nothing at all — the button wedged itself.
    if (handle.isPlaying()) {
      previewRef.current = handle
      setPreviewing(true)
    }
  }
  const kindTitle = chip.item.kind === "take" ? "Recorded take" : "Generated voice"
  // SUB-53: audio-first says how the two compare instead of warning. Longer is
  // normal here; shorter is equally unremarkable.
  const lengthNote =
    freeRules && !geom.usingFallback
      ? `${(span.end - span.start).toFixed(1)}s${chip.ratio != null ? ` — ${chip.ratio.toFixed(1)}× the original` : ""}`
      : null
  // Meeting note (2026-08-05): an overlap warns with the NUMBER, in red — how
  // much of this chip double-sounds — not just prose. Native `title` can't be
  // styled, hence AppTooltip. Secondary notes keep their SUB-48 wording.
  const tipLines: ReactNode[] = []
  if (overflow === "overlap") {
    if (tailTrespass) {
      tipLines.push(
        <div key="tail" className="text-red-600 dark:text-red-400">
          {tailOverlapSec != null && (
            <span
              data-testid={`tl-target-${testKey}-tip-overlap`}
              className="font-semibold tabular-nums"
            >
              −{tailOverlapSec.toFixed(1)}s{" "}
            </span>
          )}
          <span className="opacity-90">{t("workspace.targetAudioLane.overlapsNext")}</span>
        </div>,
      )
    }
    if (headTrespass) {
      tipLines.push(
        <div key="head" className="text-red-600 dark:text-red-400">
          {headOverlapSec != null && (
            <span
              data-testid={`tl-target-${testKey}-tip-overlap-head`}
              className="font-semibold tabular-nums"
            >
              −{headOverlapSec.toFixed(1)}s{" "}
            </span>
          )}
          <span className="opacity-90">{t("workspace.targetAudioLane.overlapsPrevious")}</span>
        </div>,
      )
    }
  } else if (overflow === "soft") {
    tipLines.push(<div key="soft">{t("workspace.targetAudioLane.runsPastSectionTooltip", { sec: overflowSec.toFixed(1) })}</div>)
  } else {
    tipLines.push(<div key="kind">{lengthNote ? `${kindTitle} · ${lengthNote}` : kindTitle}</div>)
  }
  // AQU-1758: the take was made in a voice the line no longer has.
  if (takeVoice) {
    tipLines.push(
      <div key="take-voice" data-testid={`tl-target-${testKey}-tip-take-voice`}>
        {takeVoice.takeVoiceName
          ? t("editor.voice.takeVoiceDiffers", { takeVoice: takeVoice.takeVoiceName, lineVoice: takeVoice.lineVoiceName })
          : t("editor.voice.takeVoiceRemoved", { lineVoice: takeVoice.lineVoiceName })}
      </div>,
    )
  }
  // Decision 2026-08-05: a definitively 404'd clip says so, in red.
  if (missing) tipLines.push(<div key="missing" className="font-semibold text-red-600 dark:text-red-400">{MISSING_AUDIO_MESSAGE}</div>)
  // SUB-48: never let a guessed width read as a measured one.
  if (geom.usingFallback) tipLines.push(<div key="fallback" className="text-muted-foreground">{t("audio.takesStrip.unknownLengthTooltip")}</div>)
  if (pendingSync) tipLines.push(<div key="saving" className="text-muted-foreground">{t("audio.takesStrip.pendingSyncTooltip")}</div>)
  // AQU-924: a take that never reached the server says so, in red — it used to
  // disappear from the lane entirely.
  if (syncFailed) tipLines.push(<div key="sync-failed" className="font-semibold text-red-600 dark:text-red-400">{t("audio.takesStrip.syncFailedTooltip")}</div>)
  // NOTE (2026-08-08): keyed on the CUTS, not on the painted state — hovering
  // is what opens this tooltip and hovering is also what restores full length,
  // so a line keyed on `truncated` could never actually be read.
  if (headCutSec != null || tailCutSec != null) {
    const drawnShortKey =
      headCutSec != null && tailCutSec != null
        ? "workspace.targetAudioLane.drawnShortNeighboringDubsStay"
        : headCutSec != null
          ? "workspace.targetAudioLane.drawnShortPreviousDubStays"
          : "workspace.targetAudioLane.drawnShortNextDubStays"
    tipLines.push(
      <div key="truncated" className="text-muted-foreground">{t(drawnShortKey)}</div>,
    )
  }
  const tooltipContent = <div className="flex flex-col gap-0.5">{tipLines}</div>

  const chipButton = (
    <button
      type="button"
      ref={chipRef}
      data-testid={`tl-target-${testKey}`}
      // Space after clicking a chip belongs to the TRANSPORT (same opt-in as
      // the timeline cards); the corner record button inside stays native.
      data-spacebar-transport=""
      data-kind={chip.item.kind}
      data-overflow={overflow}
      {...(geom.usingFallback ? { "data-unknown-length": "true" } : {})}
      {...(pendingSync ? { "data-pending-sync": "true" } : {})}
      {...(syncFailed ? { "data-sync-failed": "true" } : {})}
      {...(missing ? { "data-missing": "true" } : {})}
      {...(loading ? { "data-loading": "true" } : {})}
      {...(hiddenLine ? { "data-hidden-line": "" } : {})}
      // AQU-646 stage 6F: the flag the LANE lifts itself by, so the drag
      // readout above this chip is not painted over by a neighbouring row. Set
      // here rather than reported upward because the drag already lives in this
      // component and nothing else needs to know about it.
      {...(drag ? { "data-tl-drag": "" } : {})}
      {...(truncated
        ? { "data-truncated": truncatedHead && truncatedTail ? "both" : truncatedHead ? "start" : "end" }
        : {})}
      // The LOGICAL span, unaffected by any rest-state cut — verification
      // reads these, never the painted box.
      data-span-start={span.start.toFixed(3)}
      data-span-end={span.end.toFixed(3)}
      {...(chip.ratio != null ? { "data-ratio": chip.ratio.toFixed(2) } : {})}
      onClick={() => {
        // AQU-1767: a blade click cut the take; it is not also a seek.
        if (cutRef.current) {
          cutRef.current = false
          return
        }
        // AQU-1767 (Sam, 2026-10-14): a click selects the take and leaves the
        // playhead where it is, so S can split it there. Jumping to the line
        // is a double-click.
        onSelect(cell.id)
        if (!movedRef.current) onSelectTake?.(cell.id)
        movedRef.current = false
      }}
      onDoubleClick={(e) => {
        // Not from the play or record button in a corner, and not a blade cut.
        if (blade || (e.target as Element).closest?.('[role="button"]')) return
        onSeek?.(cell.id)
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false)
        setBladeX(null)
      }}
      onPointerMove={(e) => {
        if (!blade) return
        const at = bladeAt(e.clientX)
        setBladeX(at?.ok ? at.x : null)
      }}
      {...(blade ? { "data-blade": "" } : {})}
      data-audio-id={chip.item.audioId}
      {...(chip.item.pieceCount ? { "data-piece": `${(chip.item.pieceIndex ?? 0) + 1}/${chip.item.pieceCount}` } : {})}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      // AQU-646 stage 2: A RIGHT-CLICK ON A CHIP OPENS NOTHING, DELIBERATELY.
      // `contextmenu` bubbles, and the lane behind this chip is now a
      // context-menu trigger for its TRACK — so without this, right-clicking a
      // take would offer to rename or delete the track it sits on, which is
      // not what the pointer is over. The track menu is for the track; the chip
      // has its own affordances on it already.
      //
      // The result really is nothing at all: the trigger's own document-level
      // listener suppresses the browser's native menu anywhere inside it, and
      // this stops the custom one. That is the intended outcome, not an
      // oversight — noted here because "nothing happened" is otherwise a
      // reasonable thing to file a bug about.
      //
      // AQU-1767 (Sam, 2026-10-14): unless the take has a menu of its own. The
      // menu's trigger owns `onContextMenu` then (one supplied alongside it
      // replaces it) and stops the event itself, so the track's menu still
      // never opens over a take.
      {...(hasMenu ? {} : {
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault()
          e.stopPropagation()
        },
      })}
      onPointerDown={(e) => {
        if (e.button === 2 || e.ctrlKey) contextXRef.current = e.clientX
        beginDrag("move", e)
      }}
      style={{
        // AQU-646 stage 7: NO COLOUR HERE ANY MORE, and that is the headline.
        // The hue arrives as inherited CUSTOM PROPERTIES set once on the lane,
        // and the identity tint below is an ordinary class referencing them —
        // so the state layers beat it by sitting later in the same `cn()`,
        // exactly as they always did. Rev 2 had to put the fill in this style
        // object and gate it on `overflow === "none"`, because an inline style
        // beats every class; that gate is gone with the style.
        left: `${secToPx(paintedStart, pxPerSec)}px`,
        width: `${paintedPx}px`,
        // Same rule as every other chip, its own smaller cap (was rounded-md).
        borderRadius: `${chipRadiusPx(paintedPx, 6)}px`,
        zIndex: (drag ? 2000 : selected || hovered ? 1000 : 0) + paintOrder,
      }}
      className={cn(
        "group/chip absolute flex touch-none select-none items-center justify-center border",
        // Matt's QA (2026-08-21): the drag readout renders above the chip's
        // bounds, so overflow can't be hidden mid-drag — same trade the
        // timeline cards make; the glyphs inside are small enough to hold.
        drag ? "overflow-visible" : "overflow-hidden",
        // The row's live geometry, or 10-46-10 outside a timeline.
        TL_CHIP_BOX_CLASS,
        // AQU-646 stage 2: THE IDENTITY TINT, AND ITS POSITION IN THIS LIST IS
        // PART OF THE DESIGN. `cn` resolves last-wins per utility group, so
        // every state layer below — dashed fallback, amber soft-overflow,
        // full-body red at-fault, the selection ring — beats the track's
        // colour by sitting after it. Injecting the palette anywhere else, or
        // letting a palette entry introduce a group the warnings do not also
        // set, would let a colour quietly win over an alarm.
        trackChipClass(chip.item.kind),
        // 2026-08-27 (Sam): the preview PROGRESS FILL rides the identity slot
        // — played side at the chip's own rung, unplayed side at the hover
        // rung, split at `--tl-play-x`. Gated off the red at-fault body (a
        // warning still beats playback paint; amber needs no gate, it is
        // border-only) and off fallback chips (a guessed width has no honest
        // progress to draw).
        previewing && !geom.usingFallback && overflow !== "overlap" &&
          trackChipPlayingClass(chip.item.kind),
        // An unmeasurable clip spans its section, so say so rather than
        // letting a placeholder width pass for the real thing.
        geom.usingFallback && "border-dashed",
        overflow === "soft" && "border-amber-500 ring-1 ring-amber-400/70",
        // 2026-08-06 (Sam): overlapping chips are ALWAYS a problem — the
        // whole body goes red, not just the border, so it can't be mistaken
        // for the informational src/tgt end difference.
        overflow === "overlap" &&
          "border-red-500 ring-1 ring-red-500/70 bg-red-100/80 text-red-800 dark:bg-red-950/70 dark:text-red-300",
        blade ? "cursor-crosshair" : canMove && "cursor-grab active:cursor-grabbing",
        "hover:brightness-105",
        selected === "take" && "ring-2 ring-sky-500",
        selected === "line" && "ring-1 ring-sky-500/50",
        // Sam's decision: faded like the table's revealed hidden row.
        hiddenLine && "opacity-60",
      )}
    >
      {drag && (
        // Matt's QA (2026-08-21): a dub-take drag used to show NOTHING — the
        // tooltip is disabled mid-drag and there was no readout at all. Same
        // bubble as the timeline cards: a move reads the whole span (sliding
        // a clip keeps its length), a trim reads the edge being pulled.
        <DragTimeChip
          mode={drag.mode}
          startSec={span.start}
          endSec={span.end}
          deltaSec={drag.mode === "resize-r" ? span.end - geom.end : span.start - geom.start}
        />
      )}
      {blade && bladeX != null && (
        // AQU-1767: where the blade will cut — a dashed line under the pointer.
        <span
          aria-hidden
          data-testid={`tl-target-${testKey}-blade-line`}
          style={{ left: `${bladeX}px` }}
          className="pointer-events-none absolute inset-y-0 z-20 w-0 border-l-2 border-dashed border-amber-500"
        />
      )}
      {waveform && (
        // FIRST, so it paints under the handles, the kind icon, the badges and
        // the truncation chevrons — it is the chip's background, not content.
        // It reads `fill-current`, so it inherits whatever colour the body
        // classes above already resolved: emerald or violet by kind, red when
        // this chip is the one at fault in an overlap, and the dark-mode
        // variant of each. No colour logic here at all.
        <TargetChipWaveform
          peaks={waveform.peaks}
          x0={waveform.x0}
          x1={waveform.x1}
          chipH={chipH}
        />
      )}
      {canResize && (
        <span
          aria-hidden
          data-testid={`tl-target-${testKey}-handle-l`}
          onPointerDown={(e) => beginDrag("resize-l", e)}
          className="absolute inset-y-0 left-0 flex w-[7px] cursor-col-resize items-center justify-center opacity-0 transition-opacity group-hover/chip:opacity-100 bg-background/70"
        >
          <span className="h-4 w-0.5 rounded bg-current" />
        </span>
      )}
      {/* AQU-646 stage 2: THE SPARKLE COMES BACK, ON GENERATED CHIPS ONLY.
          Stage 1b removed both kind glyphs because they sat dead centre, which
          is exactly where speech waveforms peak. It returns because the palette
          landed: a track's two tones are deliberately CLOSE in hue — near
          neighbours saying "same track" — and something has to carry the
          recorded/generated distinction that the tones no longer can. The two
          decisions are complementary, which is why this is not a revert.

          Left, not centre, so the waveform keeps its middle. Inset past the
          7px trim handle rather than sitting on it (Sam, 2026-08-22: "we'd just
          move the sparkles over to the right so that it doesn't collide with
          the left trim handle") — that handle is the control you reach for.

          It inherits `currentColor`, so it is the chip's own text colour in
          both themes and turns red with the body when this chip is the one at
          fault.

          WITHHELD WHEN THE CORNER GLYPH IS SHOWING, because they occupy the
          same pixels: the badge sits at left-1.5/top-1 and is 14px tall, so at
          any height where it renders at all it covers the vertical centre. A
          missing take or a parked transport is a state; "this one is
          synthetic" is an identity the chip's colour still carries. State wins.
          No recorded-take glyph either way: recorded is the default, generated
          is the exception worth marking. */}
      {/* i18n-exempt "generated" is a TargetAudioItem kind, not copy */}
      {chip.item.kind === "generated" && !showLeftGlyph && chipH >= MIN_CHIP_GRIP_H_PX && paintedPx >= 24 && (
        <span
          aria-hidden
          data-testid={`tl-target-${testKey}-generated`}
                  // AQU-646 stage 5: the play button wants this side too. The sparkle
            // is decorative and the button is an action, so on hover the
            // action wins — the same reason the sparkle already gives way to a
            // corner state badge.
            className={cn(
              "pointer-events-none absolute left-2 top-1/2 z-10 -translate-y-1/2",
              showPlayButton && "transition-opacity group-hover/chip:opacity-0",
            )}
        >
          {/* THE SAME GLYPH THAT USED TO SIT DEAD CENTRE, byte for byte
              (Sam, 2026-08-24) — same lucide icon, same 3.5 size, same outline
              rendering inheriting `currentColor`. Only where it sits changed.
              A briefly-tried filled variant read as a blob at this size and is
              gone. */}
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
        </span>
      )}
      {/* AQU-1758: the clip names the take's voice when it is not the line's
          (a voice picked for the line only assigns it). The same small
          readout a take's running time uses over a waveform; the sentence is
          in the tooltip. Bottom left, past the sparkle (only a generated take
          carries a voice), and only where the chip is tall and wide enough
          to read it. */}
      {/* AQU-2212: while the line is being generated or re-voiced, the clip
          says so in the take-voice label's place ("Voicing as …", the Audio
          view card's status line). */}
      {voicingAs && (
        <span
          role="status"
          data-testid={`tl-target-${testKey}-working`}
          className="pointer-events-none absolute bottom-1 left-6 z-10 flex max-w-[calc(100%-2rem)] min-w-0 items-center gap-1 rounded bg-background/70 px-1 text-[10px] leading-4 text-muted-foreground"
        >
          <Spinner className="size-3 shrink-0" />
          <span className="truncate">{t("editor.voice.workingAs", { voice: voicingAs })}</span>
        </span>
      )}
      {!voicingAs && takeVoice && chipH >= TAKE_VOICE_LABEL_MIN_H_PX && paintedPx >= TAKE_VOICE_LABEL_MIN_W_PX && (
        <span
          data-testid={`tl-target-${testKey}-take-voice`}
          className="pointer-events-none absolute bottom-1 left-6 z-10 max-w-[calc(100%-2rem)] truncate rounded bg-background/70 px-1 text-[10px] leading-4 text-muted-foreground"
        >
          {takeVoice.takeVoiceName ?? t("editor.voice.removedVoice")}
        </span>
      )}
      {/* SUB-48: an unmeasurable clip says so instead of quietly borrowing
          the section's width and passing for a measured take. */}
      {geom.usingFallback && fitsBadges && (
        <span
          aria-hidden
          data-testid={`tl-target-${testKey}-unknown-length`}
          className="ml-0.5 shrink-0 text-[10px] font-semibold leading-none opacity-70"
        >
          ?
        </span>
      )}
      {/* The corner priority slot: missing badge (decision 2026-08-05) >
          AQU-924 sync-failed badge (never reached the server; needs a retry) >
          loading spinner (the readiness gate is parked on this verse) >
          SUB-48 saving glyph (still in the outbox — "safe, on its way"). */}
      {showLeftGlyph && (
        <span
          title={
            leftGlyph === "missing"
              ? MISSING_AUDIO_MESSAGE
              : leftGlyph === "syncFailed"
                ? t("audio.takesStrip.syncFailedTooltip")
                : leftGlyph === "loading"
                  ? t("editor.timeline.takeLoading")
                  : t("editor.timeline.takeSaving")
          }
          data-testid={`tl-target-${testKey}-${leftGlyph}`}
          className="absolute left-1.5 top-1 z-10 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background/85 shadow-sm ring-1 ring-border"
        >
          {leftGlyph === "missing" ? (
            <VolumeX className="h-2.5 w-2.5 text-red-600 dark:text-red-400" />
          ) : leftGlyph === "syncFailed" ? (
            <CloudAlert className="h-2.5 w-2.5 text-red-600 dark:text-red-400" />
          ) : leftGlyph === "loading" ? (
            <Spinner className="h-2.5 w-2.5" />
          ) : (
            <CloudUpload className="h-2.5 w-2.5 animate-pulse" />
          )}
        </span>
      )}
      {/* Round 8b (Sam): record right from the chip — opens this cell's
          recording modal (takes and all) without a trip to the detail pane.
          Inset from the right edge so it never fights the trim handle. */}
      {/* AQU-646 stage 5: hear THIS clip, as the timeline draws it (Sam,
          2026-08-26). Mirrors the record mic at the other corner — an action,
          hover-revealed, not a state.

          IT YIELDS THE CORNER TO A STATE GLYPH. `left-1.5 top-1` is a single
          priority slot (missing > syncFailed > loading > saving), and three of
          those four mean the clip cannot play anyway. The sparkle beside it
          fades on hover instead, since both want the left side and only one of
          them is an action.

          BOTH `stopPropagation` CALLS ARE LOAD-BEARING. Without the pointerdown
          one, pressing play begins a chip MOVE drag; without the click one, the
          chip's own onClick selects the take as well. (The chip's double-click
          jump skips its corner buttons itself, so a quick second press on play
          does not move the playhead — the thing this button was ruled not to
          do.) */}
      {showPlayButton && preview && (
        <span
          role="button"
          tabIndex={0}
          title={priming ? t("common.loading") : previewing ? t("common.stop") : t("workspace.targetAudioLane.playClip")}
          aria-label={priming ? t("common.loading") : previewing ? t("common.stop") : t("workspace.targetAudioLane.playClip")}
          aria-busy={priming || undefined}
          data-testid={`tl-target-${testKey}-play`}
          onPointerDown={(e) => { e.stopPropagation(); preview.prime() }}
          onClick={(e) => { e.stopPropagation(); togglePreview() }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              e.stopPropagation()
              togglePreview()
            }
          }}
          className={chipCornerButtonClass("left")}
        >
          {priming
            ? <Spinner className="h-2.5 w-2.5" />
            : previewing ? <Square className="h-2 w-2 fill-current" /> : <Play className="h-2.5 w-2.5 fill-current" />}
        </span>
      )}
      {showRecordButton && onOpenRecording && (
        <span
          role="button"
          tabIndex={0}
          title={t("workspace.targetAudioLane.recordAudio")}
          data-testid={`tl-target-${testKey}-record`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onSelect(cell.id)
            onOpenRecording(cell.id)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              e.stopPropagation()
              onSelect(cell.id)
              onOpenRecording(cell.id)
            }
          }}
          className={cn(chipCornerButtonClass("right"), showMoreButton && "right-[1.625rem]")}
        >
          <Mic className="h-2.5 w-2.5" />
        </span>
      )}
      {showMoreButton && (
        <span
          role="button"
          tabIndex={0}
          title={t("editor.rail.moreActions")}
          aria-label={t("editor.rail.moreActions")}
          aria-haspopup="menu"
          data-testid={`tl-target-${testKey}-more`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={openMenuFromMore}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") openMenuFromMore(e)
          }}
          className={chipCornerButtonClass("right")}
        >
          <Ellipsis className="h-2.5 w-2.5" />
        </span>
      )}
      {(chipValidationState === "self" || chipValidationState === "full") && (
        <span
          data-testid={`tl-target-${testKey}-validated`}
          title={chipValidationState === "full"
            ? t("workspace.targetAudioLane.takeValidated")
            : t("workspace.targetAudioLane.takeValidatedByYou")}
          aria-label={chipValidationState === "full"
            ? t("workspace.targetAudioLane.takeValidated")
            : t("workspace.targetAudioLane.takeValidatedByYou")}
          className={CHIP_VALIDATED_BADGE_CLASS}
        >
          {chipValidationState === "full"
            ? <CheckCheck className="h-2.5 w-2.5" strokeWidth={3} />
            : <Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
      )}
      {/* The preview's mini-playhead (2026-08-27, Sam): white, non-interactive,
          exists only while this chip's own preview sounds. Left/opacity are
          written by the rAF effect above; it mounts hidden so no line flashes
          at x=0 during the decode. The faint dark halo is what keeps a white
          hairline visible over a light-theme chip wash. */}
      {previewing && (
        <span
          aria-hidden
          ref={playlineRef}
          data-testid={`tl-target-${testKey}-playline`}
          className={CHIP_PLAYLINE_CLASS}
        />
      )}
      {/* SUB-48: the cut edge of a chip drawn short — the audio really does
          keep going past here, and the amber/red ring still tells you it
          collides. Hovering restores the full-length paint. */}
      {truncatedHead && (
        <span
          aria-hidden
          data-testid={`tl-target-${testKey}-overflow-head`}
          className={cn(
            "absolute inset-y-0 left-0 flex w-[6px] items-center justify-center",
            overflow === "overlap"
              ? "bg-red-500/25 text-red-700 dark:text-red-300"
              : "bg-amber-400/25 text-amber-700 dark:text-amber-300",
          )}
        >
          <ChevronsLeft className="h-3 w-3" />
        </span>
      )}
      {truncatedTail && (
        <span
          aria-hidden
          data-testid={`tl-target-${testKey}-overflow`}
          className={cn(
            "absolute inset-y-0 right-0 flex w-[6px] items-center justify-center",
            overflow === "overlap"
              ? "bg-red-500/25 text-red-700 dark:text-red-300"
              : "bg-amber-400/25 text-amber-700 dark:text-amber-300",
          )}
        >
          <ChevronsRight className="h-3 w-3" />
        </span>
      )}
      {canResize && (
        <span
          aria-hidden
          data-testid={`tl-target-${testKey}-handle-r`}
          onPointerDown={(e) => beginDrag("resize-r", e)}
          className="absolute inset-y-0 right-0 flex w-[7px] cursor-col-resize items-center justify-center opacity-0 transition-opacity group-hover/chip:opacity-100 bg-background/70"
        >
          <span className="h-4 w-0.5 rounded bg-current" />
        </span>
      )}
    </button>
  )
  if (!hasMenu) {
    return (
      <AppTooltip content={tooltipContent} disabled={drag != null}>
        {chipButton}
      </AppTooltip>
    )
  }
  // AQU-1767 (Sam, 2026-10-14): a right-click on a take offers what can be
  // done with it. The menu's root sits outside the tooltip and its trigger
  // renders the chip itself, so the tooltip and the menu share one element.
  const audioId = chip.item.audioId
  const vote = takeMenu?.vote && takeMenu.voteState ? takeMenu.voteState(cell.id, audioId) : null
  // AQU-2026: the per-line Change voice. The state is read off the line, not
  // this chip: it converts the take the Audio tab's voice card would, which on
  // a cut take is the whole take whichever piece was right-clicked.
  const changeVoice = takeMenu?.changeVoice && takeMenu.changeVoiceState
    ? takeMenu.changeVoiceState(cell.id)
    : null
  // A reason that holds at EVERY quality is the item's own reason — a stock
  // voice, a take a voice is cloned from, or a conversion already running on
  // this line. `up-to-date` is never one of those: it can only match the one
  // quality the take already carries, which leaves the others to pick.
  const changeVoiceBlocked = changeVoice != null
    && CHANGE_VOICE_QUALITIES.every((q) => changeVoice.blockers[q] != null)
    ? changeVoice.blockers.standard
    : null
  const changeVoiceReason = changeVoiceBlocked === "not-cloned"
    ? t("editor.voice.changeVoiceNeedsClone", { name: changeVoice?.voiceName ?? "" })
    : changeVoiceBlocked === "voice-reference"
      ? t("editor.timeline.takeMenuChangeVoiceIsReference")
      : null
  const isPiece = (chip.item.pieceCount ?? 1) > 1
  const canSplit = Boolean(onCutTarget) && editable
  return (
    <>
    <ContextMenu
      onOpenChange={(open) => {
        if (!open) return
        setMenuLineVoice(takeMenu?.applyLineVoice ? takeMenu.lineVoice?.(cell.id) ?? null : null)
        const fromMore = moreOpenRef.current
        moreOpenRef.current = null
        setMenuFromMore(fromMore != null)
        if (fromMore) {
          contextXRef.current = null
          setMenuSplitAtMs(fromMore.atMs)
          return
        }
        const x = contextXRef.current
        contextXRef.current = null
        const at = x == null ? null : bladeAt(x)
        setMenuSplitAtMs(at?.ok ? at.atMs : null)
      }}
    >
      <AppTooltip content={tooltipContent} disabled={drag != null}>
        <ContextMenuTrigger render={chipButton} />
      </AppTooltip>
      <ContextMenuContent className="w-56" data-testid={`tl-take-menu-${testKey}`}>
        {/* AQU-2212: the line's voice and this take part ways — the one click
            that brings them back together, first (the Audio view's card put
            it beside the voice field). */}
        {menuLineVoice && takeMenu?.applyLineVoice && (
          <>
            <ContextMenuItem data-testid="tl-take-menu-apply-voice" onClick={() => takeMenu.applyLineVoice?.(cell.id)}>
              {menuLineVoice.action === "change" ? <AudioLines className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
              {menuLineVoice.action === "change"
                ? t("editor.voice.changeTo", { voice: menuLineVoice.voiceName })
                : t("editor.voice.generateWith", { voice: menuLineVoice.voiceName })}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        {canSplit && (
          <ContextMenuItem
            data-testid="tl-take-menu-split"
            disabled={menuSplitAtMs == null}
            onClick={() => { if (menuSplitAtMs != null) onCutTarget?.(cell.id, audioId, menuSplitAtMs) }}
          >
            <Scissors className="h-3.5 w-3.5" />
            {/* No "S" hint: S splits the selected take at the PLAYHEAD; this
                splits where you right-clicked (Sam, 2026-10-14). Opened from
                the take's ⋯ there is no click point, so it splits at the
                playhead (AQU-1758). */}
            {t(menuFromMore ? "editor.timeline.takeMenuSplitAtPlayhead" : "editor.timeline.takeMenuSplit")}
          </ContextMenuItem>
        )}
        {takeMenu?.reRecord && !hiddenLine && (
          <ContextMenuItem data-testid="tl-take-menu-rerecord" onClick={() => takeMenu.reRecord?.(cell.id)}>
            <Mic className="h-3.5 w-3.5" />
            {t("editor.timeline.takeMenuReRecord")}
          </ContextMenuItem>
        )}
        {takeMenu?.regenerate && (
          <ContextMenuItem data-testid="tl-take-menu-regenerate" onClick={() => takeMenu.regenerate?.(cell.id)}>
            <Sparkles className="h-3.5 w-3.5" />
            {t("editor.timeline.takeMenuRegenerate")}
          </ContextMenuItem>
        )}
        {/* AQU-2026: Change voice for THIS line, beside Regenerate. The Audio
            tab keeps it on the voice card, and a time-ordered file has no voice
            cards (the lens is the timeline), so this menu is the only place a
            dubbing team can re-voice one line instead of the whole file.

            A blocked item carries the reason as its LABEL rather than a
            tooltip: a disabled menu item fires no pointer events, so a tooltip
            on it would never open — the same trap `ChangeVoiceButton` works
            around with a stand-in trigger, which a menu item cannot have. */}
        {changeVoice && takeMenu?.changeVoice && (changeVoiceBlocked != null ? (
          <ContextMenuItem data-testid="tl-take-menu-change-voice" disabled>
            <AudioLines className="h-3.5 w-3.5" />
            {changeVoiceReason ?? t("editor.voice.changeVoice")}
          </ContextMenuItem>
        ) : (
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="tl-take-menu-change-voice">
              <AudioLines className="h-3.5 w-3.5" />
              {t("editor.voice.changeVoice")}
            </ContextMenuSubTrigger>
            {/* The quality the Audio tab's popover offers, as the pick-one
                shape a menu has: radio items, so the quality this take already
                carries announces as checked (the same reason TrackMenuItems'
                colour submenu uses them). Picking one converts at it; the one
                it already is, is spent, and the header says so. */}
            <ContextMenuSubContent className="w-52">
              <ContextMenuRadioGroup value={changeVoice.quality ?? ""}>
                {/* Inside the group, not above it: a menu label names the group
                    it belongs to, and Base UI throws without one. */}
                <ContextMenuLabel data-testid="tl-take-menu-change-voice-note">
                  {CHANGE_VOICE_QUALITIES.some((q) => changeVoice.blockers[q] === "up-to-date")
                    ? t("editor.voice.changeVoiceUpToDate", { name: changeVoice.voiceName })
                    : t("editor.voice.changeVoiceQuality")}
                </ContextMenuLabel>
                {CHANGE_VOICE_QUALITIES.map((q) => (
                  <ContextMenuRadioItem
                    key={q}
                    value={q}
                    data-testid={`tl-take-menu-change-voice-${q}`}
                    disabled={changeVoice.blockers[q] != null}
                    onClick={() => {
                      if (changeVoice.blockers[q] == null) takeMenu.changeVoice?.(cell.id, q)
                    }}
                  >
                    {t(CHANGE_VOICE_QUALITY_LABEL[q])}
                  </ContextMenuRadioItem>
                ))}
              </ContextMenuRadioGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
        ))}
        {/* AQU-1758: make a character from this take's voice — the Audio
            view's voice card had this; the take's menu is its home now. */}
        {takeMenu?.makeCharacter && !hiddenLine && (
          <ContextMenuItem
            data-testid="tl-take-menu-make-character"
            onClick={() => {
              // AQU-2212: in one step, at the clip — once the menu has let go
              // of focus, or it would close the popover as it opens.
              if (takeMenu.cloneTake) setTimeout(() => setCloneOpen(true), 0)
              else takeMenu.makeCharacter?.(cell.id)
            }}
          >
            <CopyPlus className="h-3.5 w-3.5" />
            {t("editor.timeline.takeMenuMakeCharacter")}
          </ContextMenuItem>
        )}
        {vote?.canVote && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              data-testid="tl-take-menu-vote"
              onClick={() => takeMenu?.vote?.(cell.id, audioId, !vote.voted)}
            >
              {vote.voted ? <X className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
              {/* A piece is approved with its whole take (Sam, 2026-10-15). */}
              {t(vote.voted ? "editor.timeline.takeMenuUnapprove" : "editor.timeline.takeMenuApprove")}
            </ContextMenuItem>
          </>
        )}
        {(takeMenu?.rename || takeMenu?.remove) && <ContextMenuSeparator />}
        {takeMenu?.rename && (
          <ContextMenuItem
            data-testid="tl-take-menu-rename"
            // A piece renames its whole take, by the take's own name.
            onClick={() => takeMenu.rename?.(cell.id, audioId, (isPiece ? takeBaseLabel(chipTake?.label) : chipTake?.label) ?? null)}
          >
            <Pencil className="h-3.5 w-3.5" />
            {t("editor.timeline.takeMenuRename")}
          </ContextMenuItem>
        )}
        {takeMenu?.remove && (
          <ContextMenuItem
            variant="destructive"
            data-testid="tl-take-menu-delete"
            onClick={() => takeMenu.remove?.(cell.id, audioId)}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {t(isPiece ? "editor.timeline.takeMenuDeletePiece" : "editor.timeline.takeMenuDeleteTake")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
    {cloneOpen && takeMenu?.cloneTake && (
      <CloneFromTakeButton
        anchor={chipRef.current}
        onClose={() => setCloneOpen(false)}
        suggestedName={takeMenu.cloneName?.(cell.id) ?? ""}
        onClone={(name) => takeMenu.cloneTake!(cell.id, audioId, name)}
        onMoreOptions={() => takeMenu.makeCharacter?.(cell.id)}
      />
    )}
    </>
  )
}

export function TargetAudioLane({
  items,
  layout,
  getOtherLayout,
  pxPerSec,
  viewStartSec,
  viewEndSec,
  selectedId,
  selectedTakeCellId = null,
  loadingCellId,
  missingCellIds,
  editable,
  masterHonorsTrims,
  snapEnabled,
  onSelect,
  onSelectTake,
  onSeek,
  onRetimeTarget,
  onTrimTarget,
  bladeActive = false,
  onCutTarget,
  takeMenu,
  takeVoiceFor,
  getPlayheadSec,
  onOpenRecording,
  validationRequirementAudio,
  emptyCells,
  emptySpans,
  onAddLineAndRecord,
  projectId,
  fileId,
  session,
  peaksByAudioId,
  previewFactory,
  color,
  laneTestId = "tl-target-lane",
}: TargetAudioLaneProps) {
  const t = useT()
  const audioFirst = layout?.mode === "audioFirst"
  // Resolve every chip first — overflow needs the NEXT chip's start, and
  // snapping needs neighbors' effective edges.
  const chips: ChipGeometry[] = []
  for (const item of items) {
    const att = item.cell.attachments?.[item.audioId]
    const geom = layout ? layout.targetGeom(item.cell, att, item.audioId) : targetChipGeom(item.cell, att)
    const { startTime, endTime } = item.cell
    // AQU-2204: following its recordings, a line with NO times of its own (a
    // verse in a book with no times) still has its slot in the programme, so
    // its take is drawn there; only the source's clock needs the cell's times.
    const section = layout?.chipSection(item.cell, att, item.audioId)
      ?? (typeof startTime === "number" && typeof endTime === "number" ? { start: startTime, end: endTime } : null)
    if (!geom || !section) continue
    const slot = layout?.programme?.byCellId.get(item.cell.id) ?? null
    chips.push({
      item,
      geom,
      section,
      slot,
      // No honest length to trim on fallback chips; in DUBBING a take-only
      // section plays via the MASTER (which ignores dub trims), so a handle
      // there would lie. Audio-first plays the dub as its own clip, trims and
      // all, so only the unknown-length case disqualifies it.
      //
      // 2026-08-14: …and when the PICTURE is the master, that "take-only"
      // reasoning inverts, exactly as planTargetOverlay's masterIsExternal
      // gate already spells out. Every cue is a section of the film whether or
      // not it has a source clip of its own, and takes on a VTT-timed file
      // hang on TEXT cells, which never have one — so this gate was switching
      // the handles off across the whole video-first workflow. The external
      // dub driver fires those takes through the overlay pool, which honours
      // trimStart AND trimEnd, so a handle there tells the truth.
      //
      // 2026-08-27 (stage 6B): AND THE SAME IS TRUE OF THE VIRTUAL CLOCK, which
      // is what `masterHonorsTrims` now carries. Stage 3h gave a file with
      // timings and no media its own transport, driving the very same overlay
      // pool — but this gate was never told, so on a film-less file every
      // clause here was false and the derived row withheld its handles
      // completely. That is the whole of Sam's "trimming just doesn't work".
      //
      // The remaining false case is honest: the queue playing an imported
      // source recording sounds a take-only section through a master that
      // ignores dub trims, so a handle would move nothing.
      resizable:
        !geom.usingFallback &&
        (audioFirst || masterHonorsTrims || sourceClipAudioForCell(item.cell) != null),
      // AQU-2252: a take on another track has its own length, so its line's
      // ratio (the main take's) is not its.
      ratio:
        slot && layout?.takeRole(item.cell, item.audioId) === "main" && slot.targetLenSec > 0 && slot.sourceLenSec > 0
          ? slot.targetLenSec / slot.sourceLenSec
          : null,
      layer: layout?.takeRole(item.cell, item.audioId) === "layer",
    })
  }

  // AQU-1767: in TIME order, not line order. A line's pieces come in clip order,
  // but a piece moved past the next line's chip must still meet its real
  // neighbours — the overlap, trespass and snap rules below all read the array
  // as the left-to-right row. Stable, and a no-op for takes never cut: the move
  // clamp already keeps a chip from passing its neighbour's start.
  chips.sort((a, b) => a.geom.start - b.geom.start)

  // AQU-646: peaks for the chips actually on screen AND actually drawable.
  //
  // Both filters matter. Visibility keeps a 70-minute episode from decoding
  // eight hundred takes to paint the dozen you can see; the duration check
  // keeps us from fetching a clip whose bins could never be mapped to seconds
  // anyway. Built here rather than in the editor because this loop is the only
  // place that has already resolved geometry.
  const peakTargets: PeaksTarget[] = []
  for (const chip of chips) {
    if (chip.geom.durationSec == null) continue
    if (!isVisible(chip.geom.start, chip.geom.end, viewStartSec, viewEndSec)) continue
    const url = chip.item.cell.attachments?.[chip.item.audioId]?.url
    if (!url) continue
    peakTargets.push({
      attachmentKey: chip.item.audioId,
      url,
      // The take's OWN file: a take on an audio cue lives in the hidden
      // sibling, and its bytes are stored under that file's path.
      fileId: chip.item.cell.fileId,
    })
  }
  const loadedPeaks = useTargetChipPeaks({
    targets: peakTargets,
    projectId: projectId ?? null,
    fileId: fileId ?? null,
    session: session ?? null,
    bins: WAVEFORM_BINS,
  })
  const peaksFor = peaksByAudioId ?? loadedPeaks

  // AQU-646 stage 5: the chip's play button, bound to the engine. No mute is
  // threaded through — the button sounds through one by ruling, and the trim
  // grains that DID respect the mute were removed on 2026-08-28.
  const boundPreview = useChipPreview({ projectId: projectId ?? null, session: session ?? null })
  const makePreview = previewFactory ?? boundPreview

  // AQU-1767: by TAKE, not by line — a piece snaps to its sibling's edges, which
  // is how two pieces are laid back end to end.
  const candidatesFor = (audioId: string, section: { start: number; end: number }): number[] => {
    if (!snapEnabled) return []
    const out: number[] = [section.start, section.end]
    for (const c of chips) {
      if (c.item.audioId === audioId) continue
      out.push(c.geom.start, c.geom.end)
    }
    return out
  }

  // Which record slot the pointer is on — ONE for both kinds, so an
  // add-and-record slot and an empty-section slot can never both be lit. Keys
  // are prefixed because a span start and a cell id share no namespace.
  const { hotKey, slotHoverProps } = useHotSlot(viewStartSec, pxPerSec)
  // The mic is a circle in a slot with no overflow-hidden, so at a fixed size it
  // draws over the lanes above and below on a short row. Stage 3 hid it there;
  // it shrinks with the ROW HEIGHT instead, because a compact timeline is
  // exactly when you can see every un-dubbed stretch at once and want to record
  // into one. It takes no account of how WIDE its region is (Sam, 2026-08-14):
  // a narrow region gets the same circle, centred and overflowing either side.
  // See `slotButtonPx`.
  const { chipH } = useRowMetrics()

  // SUB-51: a record button hiding in the empty space under each dub-free
  // section. Rendered BEFORE the chips and with no z-index, so a real chip —
  // including an overlong neighbour painting across — always wins the pointer.
  const emptySlots =
    editable && onOpenRecording
      ? (emptyCells ?? []).flatMap((cell) => {
          // A hidden line is not recorded onto from the timeline.
          if (isHiddenCell(cell)) return []
          // SUB-53: an un-dubbed verse's slot is just its original's length,
          // so the button sits over exactly where the dub will land.
          const span = layout?.spanFor(cell, "source") ?? null
          const start = span?.start ?? cell.startTime
          const end = span?.end ?? cell.endTime
          if (typeof start !== "number" || typeof end !== "number") return []
          if (!isVisible(start, end, viewStartSec, viewEndSec)) return []
          const widthPx = secToPx(end - start, pxPerSec)
          if (widthPx < MIN_SLOT_PX) return []
          return [{ cell, leftPx: secToPx(start, pxPerSec), widthPx }]
        })
      : []

  // 2026-08-08: every chip's fault flags, resolved once. A chip needs its
  // NEIGHBOUR's flag as well as its own: when both trespass on each other,
  // neither's edge is a valid place to stop, so they meet at a shared point
  // between them instead of at each other's (invalid) edges.
  const trespass = chips.map((c, i) =>
    chipTrespass(
      { start: c.geom.start, end: c.geom.end },
      c.section,
      i > 0 ? { start: chips[i - 1].geom.start, end: chips[i - 1].geom.end } : null,
      chips[i + 1]?.geom.start ?? null,
    ),
  )
  // 2026-08-27: THAT shared point, resolved here because a chip cannot compute
  // it alone — it needs its neighbour's SECTION border, which the chips are
  // never handed. `meetAfter[i]` sits between chip i and chip i+1, and exists
  // only when the pair is mutually at fault; chip i reads it as `nextMeetSec`,
  // chip i+1 as `prevMeetSec`, so the two rest-cuts land on the same second
  // and the pair meets »|« even across a gap between their sections.
  const meetAfter = chips.map((c, i) => {
    const next = chips[i + 1]
    if (!next || !trespass[i].tail || !trespass[i + 1].head) return null
    return dualFaultMeetSec(
      { chipStartSec: c.geom.start, chipEndSec: c.geom.end, sectionEndSec: c.section.end },
      { chipStartSec: next.geom.start, chipEndSec: next.geom.end, sectionStartSec: next.section.start },
    )
  })

  return (
    // `isolate`: chip z-indexes stack within the lane — never over the playhead.
    //
    // AQU-646 stage 6F: …EXCEPT WHILE A CHIP IS BEING DRAGGED, when the whole
    // lane is lifted instead. `isolate` collapses this subtree into one unit at
    // the z-auto tier, which is what keeps the chips under the playhead — but
    // it also caps the drag readout, which hangs above the chip's own top edge
    // and belongs above everything. The rows that occlude it are the ones that
    // do NOT isolate: TimelineLane and SourceRegionLane let their cards'
    // `z-10`/`z-20` and their cue-link overlays escape into the shared context,
    // and positive z beats the z-auto tier no matter the DOM order. So a
    // source region one row up painted over the readout of the take being
    // trimmed beneath it (Sam, 2026-08-27).
    //
    // The lift is driven by the chip's own `data-tl-drag`, through `:has()`, so
    // no drag state has to be hoisted into the lane or the editor to make the
    // paint order right. At rest nothing changes at all, which is what keeps
    // the playhead over the chips everywhere except mid-gesture — where the
    // thing under the pointer is what you need to see.
    <div
      data-testid={laneTestId}
      // AQU-646 stage 7: THE HUE IS SET ONCE, HERE, and inherited by everything
      // inside. Custom properties inherit and set no colour property of their
      // own, so this is both the cheapest way to reach every chip (no prop
      // threading) and the reason the identity tint can stay an ordinary class
      // that the warning states still beat.
      //
      // THE LANE ITSELF PAINTS NOTHING (Sam, 2026-08-27). It briefly wore an
      // 18% wash, from the spec's "lane background behind the grid" — but that
      // value went to the generated-voice chip instead, and a tinted lane
      // competed with the very clips sitting on it.
      style={trackHueVars(color)}
      className={`isolate relative ${TL_ROW_H_CLASS} border-b border-border has-[[data-tl-drag]]:z-40`}
    >
      {(emptySpans ?? []).map((span) => {
        const leftPx = secToPx(span.startSec, pxPerSec)
        const widthPx = secToPx(span.endSec - span.startSec, pxPerSec)
        // Same floor as a section's own slot.
        if (!editable || !onAddLineAndRecord || widthPx < MIN_SLOT_PX) return null
        if (!isVisible(span.startSec, span.endSec, viewStartSec, viewEndSec)) return null
        return (
          <div
            key={`addrec-${span.startSec}`}
            data-testid={`tl-target-add-${span.startSec}`}
            style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
            className={`absolute ${TL_CHIP_BOX_CLASS} flex items-center justify-center`}
            {...slotHoverProps(`add-${span.startSec}`)}
          >
            {(() => {
              const buttonPx = slotButtonPx(chipH)
              const iconPx = slotIconPx(buttonPx)
              return (
              <TimelineSlotButton
                testId={`tl-target-add-${span.startSec}-record`}
                label={t("editor.timeline.recordOverStretch")}
                hot={hotKey === `add-${span.startSec}`}
                sizePx={buttonPx}
                onClick={() => onAddLineAndRecord(span.startSec, span.endSec)}
              >
                <Mic style={{ width: `${iconPx}px`, height: `${iconPx}px` }} />
              </TimelineSlotButton>
              )
            })()}
          </div>
        )
      })}
      {/* Deliberate silence — a pause someone left before a take, or between
          two pieces of one — is drawn as nothing at all: plain timeline, no
          band, no words (Sam, Oct 28: "It's silence… we could just leave it
          empty"). It still counts in the line's length and plays as silence;
          the take simply starts where the pause ends. */}
      {emptySlots.map(({ cell, leftPx, widthPx }) => (
        <div
          key={`empty-${cell.id}`}
          data-testid={`tl-target-empty-${cell.id}`}
          style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
          className={`absolute ${TL_CHIP_BOX_CLASS} flex items-center justify-center`}
          {...slotHoverProps(`empty-${cell.id}`)}
        >
          {(() => {
            const buttonPx = slotButtonPx(chipH)
            const iconPx = slotIconPx(buttonPx)
            return (
              <TimelineSlotButton
                testId={`tl-target-empty-${cell.id}-record`}
                label={t("workspace.targetAudioLane.recordAudio")}
                hot={hotKey === `empty-${cell.id}`}
                sizePx={buttonPx}
                onClick={() => {
                  onSelect(cell.id)
                  onOpenRecording?.(cell.id)
                }}
              >
                <Mic style={{ width: `${iconPx}px`, height: `${iconPx}px` }} />
              </TimelineSlotButton>
            )
          })()}
        </div>
      ))}
      {chips.map((chip, i) =>
        isVisible(chip.geom.start, chip.geom.end, viewStartSec, viewEndSec) ? (
          <TargetAudioChip
            // AQU-1767: keyed by TAKE — a cut line has a chip per piece.
            key={`${chip.item.cell.id}:${chip.item.audioId}`}
            chip={chip}
            prevChip={
              i > 0
                ? {
                    start: chips[i - 1].geom.start,
                    end: chips[i - 1].geom.end,
                    usingFallback: chips[i - 1].geom.usingFallback,
                  }
                : null
            }
            prevMeetSec={i > 0 ? meetAfter[i - 1] : null}
            nextChipStartSec={chips[i + 1]?.geom.start ?? null}
            nextMeetSec={meetAfter[i]}
            paintOrder={chips.length - i}
            audioFirst={Boolean(audioFirst)}
            layout={layout}
            getOtherLayout={getOtherLayout}
            track={items}
            pxPerSec={pxPerSec}
            selected={
              selectedTakeCellId === chip.item.cell.id ? "take" : selectedId === chip.item.cell.id ? "line" : false
            }
            loading={loadingCellId === chip.item.cell.id}
            missing={missingCellIds?.has(chip.item.cell.id) ?? false}
            editable={editable}
            snap={{ enabled: Boolean(snapEnabled), candidates: candidatesFor(chip.item.audioId, chip.section) }}
            onSelect={onSelect}
            onSelectTake={onSelectTake}
            onSeek={onSeek}
            onRetimeTarget={onRetimeTarget}
            onTrimTarget={onTrimTarget}
            bladeActive={bladeActive}
            onCutTarget={onCutTarget}
            takeMenu={takeMenu}
            takeVoice={takeVoiceFor ? takeVoiceFor(chip.item.cell, chip.item.audioId) : null}
            getPlayheadSec={getPlayheadSec}
            onOpenRecording={onOpenRecording}
            validationRequirementAudio={validationRequirementAudio}
            currentUsername={session?.username ?? ""}
            peaks={peaksFor.get(chip.item.audioId)}
            preview={makePreview(chip.item.cell, chip.item.audioId, chip.geom.durationSec)}
          />
        ) : null,
      )}
    </div>
  )
}
