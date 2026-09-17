// Full-screen recording dialog. States: idle → counting → recording →
// preview → uploading → saved. Next/Prev cell navigation lives in the footer
// and in arrow-key shortcuts. Space toggles start/stop; Esc smartly
// cancels/closes based on current phase.
//
// This deliberately owns its own recorder + upload — the per-cell inline
// "capture-and-save" hook is not reused here because the modal adds a
// preview/retake step between stop and upload.

import { type ChangeEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AlertCircle, Check, ChevronLeft, ChevronRight, ChevronsRight, ChevronUp, Lock, Maximize2, Mic, Minimize2, RefreshCw, Settings2, Sparkles, Square, Timer, TimerOff, Upload, Volume2, VolumeX, X } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { MIN_USEFUL_REGION_SEC, targetOffsetMsFor } from "@/lib/timeline/lane-timing"
import {
  isDefaultTrackSlot,
  RECORDING_SLOT,
  slotsForTrack,
  trackIdForSlot,
} from "@/lib/timeline/track-slots"
import type { TimelineTrack } from "@/lib/timeline/tracks"
import { DEFAULT_TARGET_TRACK_ID, slotForTrack } from "@/lib/timeline/track-slots"
import { slotSelections, type AudioAttachmentOut, type CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { FrontierSession } from "@/lib/frontier/types"
import { takeTrims } from "@/lib/audio/take-margins"
import { cameraLabel } from "@/lib/timeline/cue-character"
import type { CameraState } from "@/lib/sync/cells-read-types"
import { isLinkableVideoUrl } from "@/components/timeline/LinkVideoUrlDialog"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import { useAudioRecorder } from "@/hooks/useAudioRecorder"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOnline } from "@/hooks/useOnline"
import { pushAudioShortcutOverride } from "@/lib/audio/audio-coordinator"
import { probeDurationMsSafe } from "@/lib/import"
import { generateCellVoice } from "@/lib/audio/voice-generate-helpers"
import { ttsStatusKey, useTtsStatus } from "@/lib/audio/tts"
import { categorizeAiError } from "@/lib/audio/ai-error"
import { COUNTDOWN_FROM, useCountdown } from "./useCountdown"
import { AudioWaveform } from "./AudioWaveform"
import { DurationBar } from "./DurationBar"
import { RecordingVideoSurface } from "./RecordingVideoSurface"
import {
  setRecordingVideoCollapsed,
  useRecordingVideoCollapsed,
} from "@/lib/store/recording-video-collapsed-pref"
import { TakesStrip, nextTakeLabel } from "./TakesStrip"
import { useRecordingAutoAdvance, setRecordingAutoAdvance } from "@/lib/store/recording-auto-advance-pref"
import { useRecordingCountdown, setRecordingCountdown } from "@/lib/store/recording-countdown-pref"
import { setRecordingFormatPref, useRecordingFormatPref } from "@/lib/store/recording-format-pref"
import { useFileAudioAttachments } from "@/hooks/useFileAudioAttachments"
import { ACCEPT, OFFLINE_MESSAGE, attachAudioFileToCell, validateAudioFile } from "@/lib/audio/attach-file"
import { recordingLimitsFor } from "@/lib/audio/recording-limits"
import { MAX_AUDIO_UPLOAD_BYTES, audioIdSeededWith, buildAudioId, uploadCellAudio, deleteCellAudio, fetchCellAudio, parseFrontierAudioUrl } from "@/lib/audio/upload"
import { audioCachePutBlob } from "@/lib/audio/bytes-cache"
import { emitCellAudioAttach, emitCellAudioSelect, emitCellLaneRetime } from "@/lib/sync/events-emit"
import { notifyAudioAttachmentsChanged, injectOptimisticAudioAttachment } from "@/lib/audio/audio-attachments-bus"
import { audioSyncTokenFetcherForSession } from "@/lib/audio/sync-token-fetcher"
import { markProjectHasAudioDataSoon } from "@/lib/audio/project-audio-state"
import { setTranscribeStatus } from "@/lib/audio/transcribe-status"
import { transcribeCell } from "@/lib/audio/transcribe"
import { probeMicPermission } from "./probeMicPermission"

interface Props {
  open: boolean
  project: ProjectRecord
  cells: CellData[]
  activeCellId: string | null
  /**
   * AQU-646 stage 3: which TRACK a new take lands on, as a storage slot.
   *
   * Defaults to the dub row's `"recording"`, so every existing caller and every
   * existing behaviour is unchanged. An added track's lane passes its own id,
   * and the take is attached, injected, transcribed and listed under that.
   */
  targetSlot?: string
  /** The file's tracks, so the takes list can be grouped under a heading per
   *  track. Absent = one ungrouped list, exactly as it has always been. */
  timelineTracks?: readonly TimelineTrack[]
  username: string
  onActiveCellChange: (cellId: string) => void
  /** AQU-646: the cell's LAST take was removed — see `onTakeSaved`'s mirror in
   *  the workspace, which resets the target row that take created. */
  onLastTakeRemoved?: (cellId: string) => void
  /** AQU-646: a take just landed on this cell. The workspace uses it to give a
   *  text-less line a target row, so a recording counts as translated work —
   *  see `ensureTargetRowForTake`. Fired after the attach event is safely
   *  emitted, so a failed upload never claims work that does not exist. */
  onTakeSaved?: (cellId: string) => void
  /**
   * AQU-646 stage 4: what to put in front of the performer for this cell.
   *
   * When an episode's audio VTT has been imported, `cells` are the AUDIO CUES
   * — the units the picture actually wants recorded — and a cue carries only a
   * transcript of the English soundtrack, never a translation. The words to
   * perform live on the SUBTITLE cells it is linked to. So the modal stops
   * assuming the line it shows and the line it records are the same row, and
   * asks instead.
   *
   * `reference` is the cue's own transcript, shown small underneath: when one
   * subtitle spans several cues the performer is handed the whole subtitle and
   * needs to know which part of it is this cue's.
   *
   * `castName` and `cameraState` (stage 6) are who performs this line and
   * whether the camera is on them, resolved through the same links — the
   * character sheet is keyed to subtitle cells, so a cue can only learn its
   * character this way. Camera state is here because "on camera" means the
   * take has to lip-sync, which changes how it is performed.
   *
   * Absent ⇒ the historic behaviour, the cell's own translated text.
   */
  readAloudFor?: (cellId: string) => {
    text: string
    reference?: string | null
    castName?: string | null
    cameraState?: CameraState | null
    /**
     * AQU-646 stage 3f: how many subtitles are behind this line. ZERO is not
     * the same as "no text" — an unlinked cue has nothing to say and needs
     * pairing, while a linked one just needs translating, and the TTS button
     * used to report both with the same string.
     */
    linkedCount?: number
    /** Whose cast assignment picks the voice — the first linked subtitle, since
     *  assignments are keyed by cell id and a cue has none of its own. */
    voiceCellId?: string | null
    /**
     * AQU-646 stage 3g: how many heard lines share the busiest subtitle this
     * cue performs. 1 for ~92% of lines.
     *
     * Above 1 the generated voice will speak the WHOLE subtitle onto this one
     * cue — more than this line covers — and the others stay silent. The user
     * is told before pressing, not after: once the clip exists the warning is
     * late.
     */
    sharedWith?: number
  } | null
  /**
   * AQU-646 stage 4: the file whose linked picture this recording is against.
   *
   * Needed because the cell being RECORDED and the file that owns the FILM
   * stopped being the same thing. With an audio VTT imported, `cells` are cues
   * living in a hidden sibling file — and that sibling has no `coreMediaUrl`
   * and is deliberately filtered out of `project.files` altogether, so looking
   * the film up by the cue's own fileId finds nothing twice over and the
   * picture silently disappears.
   *
   * Defaults to the active cell's own file, which is every arrangement without
   * audio cues.
   */
  filmFileId?: string | null
  onClose: () => void
}

// There is deliberately NO "saved" phase (Sam, 2026-08-13). Saving a take is
// not an end state — the overwhelmingly normal next move is another take on the
// same line — so a take that lands returns the panel to `idle` with every entry
// point live, and the confirmation rides alongside as a note (`savedNote`)
// instead of becoming a mode. The state it replaced disabled Record, hid
// Generate and Upload, ignored Space, and had no transition out of itself: with
// auto-advance switched off it was a genuine dead end, escapable only by
// navigating to another line or closing the dialog.
type Phase = "idle" | "counting" | "recording" | "preview" | "uploading" | "error"

/** A way out of the recorder that a take sitting unsaved has to be asked about
 *  first — closing it, or stepping to another line. */
type PendingExit = { kind: "close" } | { kind: "goto"; index: number }

// The read-aloud block's geometry, in one place and independent of whether the
// film is showing. The line the operator performs from should look the same
// whichever way the dialog is arranged; only the column width differs, and the
// fit measures that.
const READ_ALOUD_BASE_PX = 26
const READ_ALOUD_LINE_PX = 33
const READ_ALOUD_LINE_RATIO = READ_ALOUD_LINE_PX / READ_ALOUD_BASE_PX
const READ_ALOUD_LINES = 5
/** Where shrinking stops and scrolling starts. Half the base size: below this
 *  the line stops being something you can perform from, so more shrinking would
 *  be trading readability for a scrollbar we would rather just have. */
const READ_ALOUD_MIN_PX = Math.round(READ_ALOUD_BASE_PX * 0.5)

/**
 * The takes list, grouped by track. (AQU-646 stage 3, Sam's choice)
 *
 * ONE `TakesStrip` PER GROUP rather than one strip that knows about groups: a
 * strip's whole job is a flat list of takes with per-take selection, and that
 * is exactly what a group is. Threading grouping into it would have put track
 * headings inside a component that has no other reason to know tracks exist.
 *
 * With a single group there is no heading at all, so the common case renders
 * byte-for-byte what it always did.
 */
function GroupedTakes({
  groups,
  project,
  cell,
  entry,
  sourceClip,
  username,
  session,
  onLastTakeRemoved,
}: {
  groups: Array<{ trackId: string; name: string; takes: AudioAttachmentOut[] }>
  project: ProjectRecord
  cell: CellData
  entry: CellAudioEntry | undefined
  sourceClip: AudioAttachmentOut | null
  username: string
  session: FrontierSession | null
  onLastTakeRemoved?: (cellId: string) => void
}) {
  const showHeadings = groups.length > 1
  return (
    <>
      {groups.map((group) => {
        // WHICH TAKE SOUNDS, per track. For the default row that is its
        // recording pointer (falling through to the generated one, exactly as
        // it always has); for an added track it is that track's single slot.
        const isDefault = group.trackId === DEFAULT_TARGET_TRACK_ID
        const selected = isDefault
          ? (entry?.selectedAudioId ?? null)
          : (slotSelections(entry ?? { selectedAudioId: null, selectedGeneratedVoiceAudioId: null })[
              slotForTrack(group.trackId)
            ] ?? null)
        return (
          <div key={group.trackId}>
            {showHeadings && (
              <div
                data-testid={`rec-takes-group-${group.trackId}`}
                className="sticky top-0 z-10 bg-muted/60 px-4 py-1 text-[11px] font-semibold text-muted-foreground"
              >
                {group.name}
              </div>
            )}
            <TakesStrip
              chromeless
              projectId={project.id}
              fileId={cell.fileId}
              cellId={cell.id}
              takes={group.takes}
              onLastTakeRemoved={onLastTakeRemoved}
              selectedAudioId={selected}
              // The displace-to-source dance belongs to the default row alone —
              // an added track has one slot and nothing to displace onto.
              selectedGeneratedAudioId={isDefault ? (entry?.selectedGeneratedVoiceAudioId ?? null) : null}
              sourceClip={isDefault ? sourceClip : null}
              author={username}
              session={session}
            />
          </div>
        )
      })}
    </>
  )
}


export function AudioRecordingModal({
  open, project, cells, activeCellId, targetSlot = RECORDING_SLOT, timelineTracks, username,
  onActiveCellChange, onTakeSaved, onLastTakeRemoved, readAloudFor, filmFileId, onClose,
}: Props) {
  const t = useT()
  // ONE mic stream and ONE capture graph for as long as this dialog is open
  // (round 4 of the take-head hunt). Opening and closing them around takes is
  // what made the OS reconfigure the input device — measured as the first
  // second of a take at a fifteenth of its real level while the device
  // recovered. The close-cleanup below is what lets go.
  const recorder = useAudioRecorder({ holdMic: true })
  const countdown = useCountdown()
  const { session } = useFrontierSession()
  const online = useOnline()
  // Decision 2026-08-05: recording is blocked UP FRONT while offline (a take
  // can't be saved without a connection), instead of failing mid-flow with a
  // raw fetch error. One copy of the message, used by every gate.
  const offlineMessage = t("audio.recordingModal.offlineMessage")
  const [beepEnabled, setBeepEnabled] = useState(true)
  // AQU-1209: the count itself is optional. OFF means idle → recording with no
  // counting phase at all — no numbers, no GO, no tones, no film lead-in — for
  // the operator grinding through short lines who has stopped needing the cue.
  // Persisted per device; ON is the default, so nothing changes uninvited.
  const countdownEnabled = useRecordingCountdown()
  // SUB-50: saving jumps to the next cell — great on a pass down the file,
  // wrong when working one line over and over. Persisted per device.
  const autoAdvance = useRecordingAutoAdvance()
  const advanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // SUB-52 + the button-focus rule below need each other: Space on a focused
  // button activates THAT button, so the dialog must not OPEN with a button
  // focused (Base UI's default first-tabbable) or bare Space does nothing.
  // Focus the dialog surface instead; Tab still reaches every control.
  const dialogSurfaceRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<Phase>("idle")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const consumedBlobRef = useRef<Blob | null>(null)
  // The acknowledgement that replaced the "saved" screen: the take's own name,
  // shown under the duration bar for a couple of seconds and then gone. The
  // DURABLE record of the save is the takes strip a few pixels below — the
  // counter ticks up and the take is there to play — so this only has to mark
  // the moment, not stand in for it.
  const [savedNote, setSavedNote] = useState<string | null>(null)
  const savedNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // AQU-646 stage 5: takes are captured at WAV quality by default, with the
  // historic webm/opus as the opt-out. Read REACTIVELY here — for the header
  // pill's label and the near-limit copy only. The recorder hook reads the same
  // pref PLAINLY at start(), which pins the format for that take; the pill goes
  // disabled from the countdown onwards, and that is what keeps the two reads
  // describing the same take rather than disagreeing mid-flow.
  const recordingFormat = useRecordingFormatPref()
  const formatLimits = useMemo(() => recordingLimitsFor(recordingFormat), [recordingFormat])
  // Nonce-keyed "put the picture on this line" for RecordingVideoSurface,
  // following the `seekSec: {sec, nonce}` idiom the timeline already uses. A
  // nonce and not a boolean because re-arming the SAME cell — a retake, or
  // coming back to a line already recorded — has to re-fire.
  const [armNonce, setArmNonce] = useState(0)
  // THE ROLLING LEAD-IN (2026-08-14). Non-null only while a countdown is
  // running, and carries the wall-clock instant of zero so the film can play
  // the seconds leading up to the line and arrive at its first frame exactly
  // as the count reaches it. Held as state with a STABLE identity (set once
  // per countdown, cleared once) because the surface keys effects on it.
  const [leadIn, setLeadIn] = useState<{ zeroAtMs: number } | null>(null)

  const activeIndex = useMemo(
    () => (activeCellId ? cells.findIndex((c) => c.id === activeCellId) : -1),
    [cells, activeCellId],
  )
  const activeCell = activeIndex >= 0 ? cells[activeIndex] : null
  // Timeline-segment-model (Scope A) — recorder decoupling. The record target
  // is ALWAYS the active cell's own timing. In a time-ordered file the media
  // layer's rows ARE media segments with their own start/end, so recording
  // there targets the media segment's window — never a subtitle's. (The old
  // coupling, where audio rode the subtitle cell and inherited its reading-
  // speed window, no longer exists: media is a separate segment.)
  const targetSec = activeCell && activeCell.startTime != null && activeCell.endTime != null
    ? Math.max(0, activeCell.endTime - activeCell.startTime)
    : null

  // AQU-646 stage 5: the film for the line being recorded, shown beside the
  // stage so an overrun is visible as it happens rather than only measurable
  // afterwards. The `?.` on `project.files` is LOAD-BEARING: this modal's own
  // test fixtures cast a ProjectRecord with no files array at all, and
  // `project.files.find` throws there.
  //
  // Validated with the link dialog's own checker because the field is free text
  // that predates that dialog — a QA project has a paragraph of English prose
  // stored as its video URL, and nothing downstream can tell that apart from a
  // real address; a <video> pointed at it renders a black rectangle, which is
  // worse than no picture at all.
  // Stage 4: the picture belongs to the file being TRANSLATED, which is no
  // longer the file the take is written to — see `filmFileId`.
  const filmOwnerId = filmFileId ?? activeCell?.fileId
  const filmUrl = useMemo(() => {
    const raw = project.files?.find((f) => f.id === filmOwnerId)?.coreMediaUrl
    return raw && isLinkableVideoUrl(raw) ? raw : null
  }, [project.files, filmOwnerId])

  // Two layouts, one control (Sam's design exploration, 2026-08-13). Expanded
  // is a 16:9 room with the picture down the left; collapsed is a tall portrait
  // column whose lower half is the takes drawer. A line with no film is ALWAYS
  // the collapsed layout and never offers the toggle — there is nothing to
  // collapse, so a control for it would be a lie.
  const videoCollapsed = useRecordingVideoCollapsed()
  const showFilm = filmUrl != null && !videoCollapsed
  // Expanded, the takes list is a disclosure over the column rather than a
  // permanent shelf: the 16:9 column is short, and the instruments are what you
  // are looking at while recording. Collapsed, the drawer is always open
  // because the portrait column has the room and nothing else wants it.
  const [takesOpen, setTakesOpen] = useState(false)

  // THE READ-ALOUD BLOCK NEVER SCROLLS AND NEVER CLIPS (Sam, 2026-08-13). It
  // owns the height of five line boxes; a line too long for that gets a smaller
  // font until it fits. Scrolling to find the rest of your own sentence is not
  // something anyone should be doing with a live mic and a countdown running,
  // and truncation is worse still.
  //
  // Measured, not estimated: where a line wraps depends on the actual glyphs,
  // so character counts lie — especially across the scripts this app targets.
  // Binary-search the largest whole pixel size whose RENDERED height fits the
  // budget. Whole pixels because a half-pixel font size buys nothing and costs
  // a blurry baseline.
  const readAloudRef = useRef<HTMLParagraphElement | null>(null)
  const readAloudBoxRef = useRef<HTMLDivElement | null>(null)
  // ONE size, ONE leading, ONE budget, ONE floor — deliberately NOT branched on
  // `showFilm` (2026-08-14, Sam). They used to be: 26px/33px/165px beside the
  // picture and 23px/30px/150px collapsed, which made the same line land at a
  // different size in the two states, and could make the type SHRINK on
  // collapse even though the rule was supposed to be identical. The only thing
  // that legitimately differs between the states is the column's WIDTH, and the
  // fit below reads that from the DOM, so it adapts on its own.
  const readAloudBase = READ_ALOUD_BASE_PX
  // Kept as a ratio rather than a fixed px line-height so the whole block
  // scales together — shrinking the type while leaving 33px leading would open
  // gaps that waste the very space we are trying to buy.
  const readAloudRatio = READ_ALOUD_LINE_RATIO
  const readAloudBudget = READ_ALOUD_LINES * READ_ALOUD_LINE_PX
  const [readAloudPx, setReadAloudPx] = useState(readAloudBase)
  // Stage 4: the line to perform may live on a DIFFERENT cell from the one
  // being recorded — see `readAloudFor`. Falls back to the cell's own
  // translation, which is what every arrangement without audio cues does.
  const readAloud = activeCell && readAloudFor ? readAloudFor(activeCell.id) : null
  const readAloudText = readAloud?.text ?? activeCell?.translated ?? ""
  const readAloudReference = readAloud?.reference ?? null
  const readAloudCast = readAloud?.castName ?? null
  const readAloudCamera = cameraLabel(readAloud?.cameraState ?? undefined)
  /**
   * AQU-646 stage 3f: TTS SPEAKS WHAT THE PERFORMER READS.
   *
   * It used to read `activeCell.translated` — the cue's own translation, which
   * on a file with an audio-cue sibling is empty forever, because the words
   * live on the subtitle cells the cue is linked to. So the button sat disabled
   * over lines that were translated, saying "translate this line first"
   * (Sam, 2026-08-25). Read-aloud had resolved this correctly all along, ten
   * lines above; TTS simply never asked it.
   *
   * `readAloudText` already falls back to the cell's own translation when there
   * is no cue arrangement, so every other file type is untouched.
   */
  const ttsText = readAloudText.trim()
  /** A cue with no subtitle behind it — about ten an episode. There is nothing
   *  to say, and it is a different problem from "not translated yet". */
  const ttsUnlinked = readAloud?.linkedCount === 0
  /** …and a subtitle performed by several heard lines: whatever is generated
   *  here says the whole line, and the other heard lines get nothing from it. */
  const ttsSharedWith = readAloud?.sharedWith ?? 1
  // Re-fit when the column's WIDTH changes (window resize) — a narrower box
  // rewraps and can need a smaller size. Width only: the box's height is what
  // the fit itself moves, and observing that would chase its own tail.
  const [readAloudWidth, setReadAloudWidth] = useState(0)
  const hasActiveCell = activeCell != null
  useEffect(() => {
    const box = readAloudBoxRef.current
    if (!box || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setReadAloudWidth((prev) => (Math.abs(prev - w) > 0.5 ? w : prev))
    })
    ro.observe(box)
    return () => ro.disconnect()
    // `showFilm` is in here because collapsing the picture is the one moment the
    // column can be rebuilt around a different element; observing the old,
    // detached box would freeze the width at its pre-collapse value and leave
    // the type sized for a column that no longer exists.
  }, [open, hasActiveCell, showFilm])
  useLayoutEffect(() => {
    const el = readAloudRef.current
    if (!el) return
    // Step down a whole pixel at a time to the floor; only past it does the box
    // scroll, so the words always exist even for a line no size can fit.
    const floor = READ_ALOUD_MIN_PX
    const fits = (px: number) => {
      el.style.fontSize = `${px}px`
      el.style.lineHeight = `${Math.round(px * readAloudRatio)}px`
      // The half-pixel absorbs sub-pixel rounding; a whole extra line box is an
      // order of magnitude larger and cannot hide inside it.
      return el.scrollHeight <= readAloudBudget + 0.5
    }
    let best = floor
    if (fits(readAloudBase)) best = readAloudBase
    else {
      let lo = floor
      let hi = readAloudBase - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (fits(mid)) {
          best = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      fits(best)
    }
    setReadAloudPx(best)
  }, [readAloudText, readAloudBase, readAloudRatio, readAloudBudget, readAloudWidth])

  // Recording-slot takes for the active cell — drives the takes strip. The bus
  // refetch (poked on save below) keeps this fresh as new takes land.
  const { byCellId } = useFileAudioAttachments(open ? project.id : null, open ? (activeCell?.fileId ?? null) : null)
  const audioEntry = activeCell ? byCellId.get(activeCell.id) : undefined
  /**
   * The takes on THIS track. (AQU-646 stage 3)
   *
   * Drives the strip, the "Take N" numbering (`nextTakeLabel` reads this list,
   * so per-track numbering falls out with no extra code) and the duration heal.
   * `slotsForTrack` is what keeps the default row's two slots together as one
   * list while an added track's single slot stands alone.
   */
  const ownSlots = useMemo(() => new Set(slotsForTrack(trackIdForSlot(targetSlot))), [targetSlot])
  const recordingTakes = useMemo(
    () => Object.values(audioEntry?.attachments ?? {})
      // Round 8c (Sam): generated TTS is a TAKE too — one list, recorded and
      // synthesized side by side, any of them circleable.
      .filter((a) => ownSlots.has(a.slot))
      // The imported SOURCE clip rides the recording slot too (fileId-seeded,
      // per SUB-29 provenance) but is not a take — keep it out of the strip so
      // it can't be listed, named "Take 1", or deleted from here. The Source
      // audio track owns it.
      .filter((a) => !audioIdSeededWith(a.audioId, activeCell?.fileId ?? ""))
      .sort((a, b) => a.audioId.localeCompare(b.audioId)),
    [audioEntry, activeCell?.fileId, ownSlots],
  )
  /**
   * EVERY track's takes on this line, grouped. (Sam, 2026-08-24)
   *
   * Distinct from `recordingTakes` above, which is this track's alone and is
   * what "Take N", the duration heal and a new take's slot all read. This one
   * is for LOOKING: the tab lists what exists on every track under a heading
   * each, so a take on track 2 is findable from the detail pane even though
   * recording into track 2 only starts from that track's own lane.
   *
   * A single group renders exactly as the ungrouped list always did — the
   * heading only appears once there is more than one thing to tell apart.
   */
  const takeGroups = useMemo(() => {
    const all = Object.values(audioEntry?.attachments ?? {})
      // The imported SOURCE clip rides the recording slot but is not a take.
      .filter((a) => !audioIdSeededWith(a.audioId, activeCell?.fileId ?? ""))
    const byTrack = new Map<string, AudioAttachmentOut[]>()
    for (const att of all) {
      const trackId = trackIdForSlot(att.slot)
      const list = byTrack.get(trackId)
      if (list) list.push(att)
      else byTrack.set(trackId, [att])
    }
    // In the file's own track order, so the headings read down the tab the way
    // the lanes read down the timeline. Tracks this build cannot name (a
    // collaborator's newer one) still list their takes rather than hiding them.
    const ordered = (timelineTracks ?? []).filter((tr) => byTrack.has(tr.id))
    const named = new Set(ordered.map((tr) => tr.id))
    return [
      ...ordered.map((tr) => ({ trackId: tr.id, name: tr.name, takes: byTrack.get(tr.id)! })),
      ...[...byTrack.entries()]
        .filter(([id]) => !named.has(id))
        .map(([id, takes]) => ({ trackId: id, name: "", takes })),
    ].map((g) => ({ ...g, takes: g.takes.sort((a, b) => a.audioId.localeCompare(b.audioId)) }))
  }, [audioEntry, activeCell?.fileId, timelineTracks])

  /**
   * How many takes the strip will actually LIST — every track's, not this one's.
   *
   * THE GATES BELOW READ THIS AND NOT `recordingTakes`, and that distinction is
   * the whole of a bug Sam hit (2026-08-24): both render sites asked
   * `recordingTakes.length > 0`, which is THIS track's takes, and then rendered
   * `takeGroups`, which is EVERY track's. Open the recorder on a track that has
   * no takes yet and the entire strip disappeared — taking with it the takes
   * sitting on every other track, which were listed right there a moment
   * earlier while the default track happened to hold one. From the outside the
   * takes had simply vanished.
   *
   * `recordingTakes` keeps its own jobs — "Take N" numbering, the duration
   * heal, which slot a new take is written to — because those are all
   * per-track. Only "is there anything to show" is about the whole list.
   */
  const listedTakeCount = useMemo(
    () => takeGroups.reduce((n, g) => n + g.takes.length, 0),
    [takeGroups],
  )

  // The source clip itself — the recording slot's "no take" state. Activating
  // a TTS take hands the slot back to it so the generated audio can sound.
  const sourceClip = useMemo(
    () => Object.values(audioEntry?.attachments ?? {})
      .find((a) => a.slot === "recording" && audioIdSeededWith(a.audioId, activeCell?.fileId ?? "")) ?? null,
    [audioEntry, activeCell?.fileId],
  )

  // Round 8c: takes recorded before the webm-duration fix attached without a
  // durationMs (Chrome writes no duration header into MediaRecorder blobs), so
  // their chips still fall back to section width. Heal the SELECTED take once
  // per modal visit: fetch its bytes, decode the real length, re-attach with
  // it (re-attach re-selects, which is a no-op here — and COALESCE keeps the
  // name, while passing the trims keeps them).
  const healTriedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!open || !session?.jwt || !activeCell) return
    const sel = audioEntry?.selectedAudioId
    if (!sel || healTriedRef.current.has(sel)) return
    const take = recordingTakes.find((t) => t.audioId === sel && t.slot === "recording")
    if (!take || take.durationMs != null) return
    healTriedRef.current.add(sel)
    const cell = activeCell
    void (async () => {
      try {
        const frontier = parseFrontierAudioUrl(take.url)
        if (!frontier) return
        const bytes = await fetchCellAudio({
          projectId: project.id, fileId: cell.fileId,
          audioId: frontier.audioId, ext: frontier.ext,
          getSyncToken: audioSyncTokenFetcherForSession(session),
        })
        const durationMs = await probeDurationMsSafe(
          new Blob([bytes as BlobPart], { type: take.mimeType ?? "audio/webm" }),
        )
        if (durationMs == null) return
        const healEventId = await emitCellAudioAttach({
          projectId: project.id, fileId: cell.fileId, cellId: cell.id,
          // AQU-646: the take's own slot. Provably "recording" today (the find
          // above filters on it), but this re-attach assigns slot outright, so
          // it must not be the one place still naming it by hand once
          // `recordingTakes` is scoped to a target track.
          audioId: take.audioId, url: take.url, slot: take.slot,
          mimeType: take.mimeType ?? undefined,
          durationMs: Math.round(durationMs),
          label: take.label ?? undefined,
          trimStartMs: take.trimStartMs ?? undefined,
          trimEndMs: take.trimEndMs ?? undefined,
          author: username,
        })
        injectOptimisticAudioAttachment(
          cell.fileId,
          cell.id,
          { ...take, durationMs: Math.round(durationMs) },
          healEventId,
        )
        notifyAudioAttachmentsChanged(cell.fileId)
      } catch {
        /* best-effort — the take simply keeps its fallback-width chip */
      }
    })()
  }, [open, session, activeCell, audioEntry?.selectedAudioId, recordingTakes, project.id, username])

  // Whenever the user switches cells, reset the capture state so the new cell
  // opens fresh.
  useEffect(() => {
    recorder.reset()
    countdown.cancel()
    setLeadIn(null)
    setPhase("idle")
    setErrorMessage(null)
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    consumedBlobRef.current = null
    // The note names a take on the line you just left; carrying it over would
    // credit this line with a take it does not have.
    if (savedNoteTimerRef.current) { clearTimeout(savedNoteTimerRef.current); savedNoteTimerRef.current = null }
    setSavedNote(null)
    // …and put the picture on the new line's first frame.
    setArmNonce((n) => n + 1)
    // The takes disclosure describes the line you were on. Carrying it open to
    // the next line would raise a panel over the instruments listing takes that
    // are not the ones now named beneath it.
    setTakesOpen(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCellId])

  // Re-arm the picture at the top of the countdown — which is now where the
  // ROLLING LEAD-IN starts, so the surface rewinds by the countdown's length
  // and plays the run-up to the line, arriving on its first frame at zero —
  // and again when a take lands in PREVIEW, where `leadIn` is null and
  // `running` is false, so the surface simply rewinds and stays paused.
  //
  // Running the film under the preview player is a NON-GOAL, not an oversight:
  // unmuted it talks over the take, and muted it drifts the moment the user
  // scrubs the audio, because scrubbing an <audio> publishes nothing for a
  // picture to follow. Mirroring one element's clock onto another is a real sync
  // engine, and this codebase has deliberately centralised that behind the two
  // video singletons the surface is forbidden to touch. Review-against-picture
  // is a legitimate want and a separate piece of work.
  useEffect(() => {
    if (phase === "counting" || phase === "preview") setArmNonce((n) => n + 1)
  }, [phase])

  // The lead-in retires only once the take is visibly RUNNING (or the flow
  // left the countdown some other way — error, a cancel path that missed one).
  // Retiring it at zero itself would pause the film for the one commit where
  // recorder state has flipped but the phase has not. In the commit where both
  // change together, the surface sees running=true before it ever sees the
  // lead-in gone, and the picture just keeps rolling through the handoff.
  useEffect(() => {
    if (phase !== "counting") setLeadIn((prev) => (prev == null ? prev : null))
  }, [phase])

  // Warm the session the moment the dialog opens — but only when the mic
  // permission is already granted, so opening the recorder never ambushes a
  // first-time user with a browser prompt they didn't ask for. By the first
  // countdown the device has had many seconds to settle instead of 3, and
  // every take in the session then runs on the same warmed stream.
  useEffect(() => {
    if (!open) return
    let live = true
    void probeMicPermission().then((s) => {
      if (live && s === "granted") void recorder.prewarm()
    })
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Close cleanup.
  useEffect(() => {
    if (open) return
    recorder.reset()
    // holdMic means reset() deliberately KEPT the mic; closing the dialog is
    // the one moment it truly lets go (the tab's recording indicator must not
    // outlive the surface that explains it). Optional-called because consumer
    // tests mock this hook with partial objects.
    recorder.releaseMic?.()
    countdown.cancel()
    setLeadIn(null)
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    consumedBlobRef.current = null
    setPhase("idle")
    setErrorMessage(null)
    if (savedNoteTimerRef.current) { clearTimeout(savedNoteTimerRef.current); savedNoteTimerRef.current = null }
    setSavedNote(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Surface recorder state transitions.
  useEffect(() => {
    if (recorder.state.kind === "recording" && phase !== "recording") {
      setPhase("recording")
    }
    if (recorder.state.kind === "stopped") {
      const blob = recorder.state.blob
      if (consumedBlobRef.current === blob) return
      consumedBlobRef.current = blob
      const url = URL.createObjectURL(blob)
      setPreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return url })
      setPhase("preview")
    }
    if (recorder.state.kind === "error") {
      setErrorMessage(recorder.state.message)
      setPhase("error")
    }
  }, [recorder.state, phase])

  // Acting on this line OVERRIDES a pending auto-advance. Saving now leaves you
  // here rather than parking you in a dead end, so the 450ms hop and a fresh
  // Record or Upload press can genuinely collide — and reaching for a control is
  // the less ambiguous statement of the two about which line you meant. Without
  // this, a quick second take counts down and is then yanked to the next line
  // mid-countdown, and a file picked in that window attaches to the wrong line.
  const stayOnThisLine = useCallback(() => {
    if (advanceTimerRef.current) { clearTimeout(advanceTimerRef.current); advanceTimerRef.current = null }
    if (savedNoteTimerRef.current) { clearTimeout(savedNoteTimerRef.current); savedNoteTimerRef.current = null }
    setSavedNote(null)
  }, [])

  const startFlow = useCallback(() => {
    stayOnThisLine()
    // Offline gates FIRST — when both fail it is the truer cause ("sign in"
    // is unactionable without a connection anyway).
    if (!online) {
      setErrorMessage(offlineMessage)
      setPhase("error")
      return
    }
    if (!session?.jwt) {
      setErrorMessage(t("audio.recordingModal.signInRequired"))
      setPhase("error")
      return
    }
    // Probe mic permission BEFORE starting the countdown so we never count
    // down into a failed recording. If permission is denied, surface a clear
    // message instead of starting the 3-2-1 sequence. (AQU-155)
    setErrorMessage(null)
    void probeMicPermission().then((permState) => {
      if (permState === "denied") {
        // Abort — permission is blocked. Show actionable guidance.
        setPhase("error")
        setErrorMessage(t("audio.recordingModal.micBlocked"))
        return
      }
      // "granted" or "prompt" (system will ask, or already asked successfully).
      // Safe to run the countdown and hand off to the recorder.
      //
      // …unless the operator has turned the count off (AQU-1209), in which case
      // this IS zero: no counting phase, no lead-in to set, straight into the
      // take. The dialog pre-warms on open whenever permission is already
      // granted, so the armed mark path is normally ready and start() flips to
      // "recording" synchronously — the REC indicator arrives with the click.
      // On the one press where it is not (a first-ever permission prompt),
      // start() falls through to its own un-armed path and the take begins when
      // the mic does. No artificial wait is inserted to cover that: the whole
      // point of the preference is not waiting.
      if (!countdownEnabled) {
        void recorder.start()
        return
      }
      setPhase("counting")
      // Bring the mic AND the whole capture graph up now, during the countdown.
      // It runs armed — listening, discarding — so that when the count reaches
      // zero, starting the take is a bookmark rather than a build. Everything
      // this used to do at zero instead (construct an AudioContext, fetch the
      // worklet, wait out the mic's first zero-filled buffers) landed inside
      // the take as dead air, gluing the operator's voice that much later onto
      // the timeline. It also gives macOS/Chrome AGC the same head start it
      // always had.
      void recorder.prewarm()
      // The film rolls the run-up to the line and lands on it at zero. Fixed
      // from the countdown's own length so the two cues cannot drift apart.
      setLeadIn({ zeroAtMs: Date.now() + COUNTDOWN_FROM * 1000 })
      countdown.start({
        beep: beepEnabled,
        from: COUNTDOWN_FROM,
        onDone: () => {
          // ZERO. The countdown says "now", the film is on the line's first
          // frame, and the take begins — one instant, not three. `leadIn` is
          // NOT cleared here: the phase flips to "recording" one commit after
          // the recorder's state does, and clearing the lead-in first would
          // hand the surface a render with neither flag set — a pause() and a
          // play() one frame apart, a stutter landing exactly on the
          // operator's entrance. The phase effect below retires it instead.
          void recorder.start()
        },
      })
    })
  }, [beepEnabled, countdownEnabled, countdown, recorder, session?.jwt, online, stayOnThisLine])

  const stopRecording = useCallback(() => {
    recorder.stop()
  }, [recorder])

  const retake = useCallback(() => {
    recorder.reset()
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    consumedBlobRef.current = null
    setPhase("idle")
    // Immediately start the next take — user already signalled intent.
    setTimeout(startFlow, 0)
  }, [recorder, previewUrl, startFlow])

  // Hand the line back exactly as it was before the take that just landed:
  // Record armed, Generate and Upload beside it, the window bar showing the
  // target again. The stopped blob has to go with it — leaving it in the
  // recorder would let the preview effect re-adopt it and drop the user back
  // into a review of a take they have already kept.
  const returnToReady = useCallback((note: string) => {
    recorder.reset()
    if (previewUrl) { URL.revokeObjectURL(previewUrl); setPreviewUrl(null) }
    consumedBlobRef.current = null
    setErrorMessage(null)
    setPhase("idle")
    setSavedNote(note)
    if (savedNoteTimerRef.current) clearTimeout(savedNoteTimerRef.current)
    savedNoteTimerRef.current = setTimeout(() => {
      savedNoteTimerRef.current = null
      setSavedNote(null)
    }, 2500)
  }, [recorder, previewUrl])

  // Round 8: durable TTS from the recording surface — the clear "regenerate"
  // counterpart to re-recording. Uses the project engine + this cell's
  // assigned voice; the result attaches to the generated-voice slot.
  const [ttsBusy, setTtsBusy] = useState(false)
  const [ttsDone, setTtsDone] = useState(false)
  useEffect(() => {
    setTtsDone(false)
  }, [activeCellId])
  /**
   * AQU-646 stage 4c: the failure this surface has always caused and never
   * shown (Sam, 2026-08-26).
   *
   * `generateCellVoice` already writes every failure into the shared per-cell
   * status store — the same store, under the same key, that the table row's
   * voice button reads. This modal simply never read it back: it checked the
   * helper's boolean, and on `false` let the button fall silently to idle. So
   * a generation that failed looked exactly like one that had never been
   * pressed.
   *
   * THE STORE, NOT THE BOOLEAN, and that distinction is the whole correctness
   * of this. `false` also means "you declined the model download", which sets
   * an IDLE status on purpose — reddening the button for a choice the user
   * just made would be a worse lie than saying nothing.
   *
   * ONE KEY FOR BOTH SURFACES. `activeCellId` is `primaryAudioHome(...)` and
   * the row button is handed `resolveAudioHomes(...)[0]` — the same cell, so
   * on a cue file a failure paints the recorder and the table row together
   * rather than each keeping its own half of the story.
   *
   * A failure left over from before this modal opened still shows, and that is
   * deliberate: the store is only ever overwritten by the next attempt, so an
   * error sitting in it means the last thing that happened to this line's
   * voice was a failure and nothing has fixed it since. Pressing the button
   * clears it — the retry writes `loading` first.
   */
  const ttsStatus = useTtsStatus(activeCellId ? ttsStatusKey(activeCellId) : undefined)
  const ttsFailure = ttsStatus.kind === "error" ? categorizeAiError(ttsStatus.message) : null
  /**
   * The heading and the advice, read as one sentence.
   *
   * SOME BODIES ALREADY OPEN WITH THEIR OWN HEADING — the daily-quota one is
   * literally "Daily AI limit reached — resets at midnight UTC…" under the
   * title "Daily AI limit reached" — so joining them unconditionally produces
   * "Daily AI limit reached — Daily AI limit reached — resets at midnight".
   * An equality guard does not catch that; the body merely STARTS with the
   * title. Where it does, the body is already the whole sentence.
   */
  const ttsFailureLine = !ttsFailure
    ? null
    : ttsFailure.body.toLowerCase().startsWith(ttsFailure.title.toLowerCase())
      ? ttsFailure.body
      : `${ttsFailure.title} — ${ttsFailure.body}`
  // Another surface generating for THIS cell counts as busy: two synths for one
  // cell would fight over one status slot, and the row button takes the same
  // position. Our own press is `ttsBusy`, which leads so that a retry reads as
  // in-flight even while the previous failure is still in the store.
  const ttsWorking = ttsBusy || ttsStatus.kind === "loading" || ttsStatus.kind === "synthesizing"
  // Only the local engines report bytes — Inworld (the default) sends no
  // progress at all and Gemini sends one event — so this appears exactly where
  // the wait is long enough to look like a hang.
  const ttsProgressPct =
    ttsStatus.kind === "loading" && ttsStatus.total > 0
      ? Math.round((ttsStatus.loaded / ttsStatus.total) * 100)
      : null
  /**
   * Whether the button WEARS the failure — one flag, read by the glyph, the
   * tone, the label and the line beneath, so those four can never disagree.
   *
   * They did: with each reading `ttsFailure` for itself, pressing retry over a
   * stale error span a spinner underneath the word "failed", announcing the
   * outcome of an attempt that was still running. An in-flight run always
   * outranks the error it is trying to replace.
   */
  const ttsShowFailure = ttsFailure != null && !ttsWorking
  const generateTts = useCallback(async () => {
    if (!online) return // the disabled button + tooltip carry the message
    if (!activeCell || !session || ttsBusy) return
    setTtsBusy(true)
    setTtsDone(false)
    try {
      // Round 8c: the TTS take is born with its permanent name like any take.
      const ok = await generateCellVoice({
        project, cell: activeCell, session, username,
        label: nextTakeLabel(recordingTakes),
        // The WORDS come from the subtitle this line performs, and the VOICE
        // from that subtitle's cast assignment — neither of which the cue
        // carries itself. Both undefined off a cue file, which is the cell's
        // own text and its own assignment, exactly as before.
        text: ttsText,
        voiceCellId: readAloud?.voiceCellId ?? undefined,
        // The voice lands on the track the recorder is pointed at, not always
        // on the default row's generated-voice slot.
        slot: isDefaultTrackSlot(targetSlot) ? undefined : targetSlot,
      })
      if (ok) {
        setTtsDone(true)
        // You asked for this voice — make it the one that sounds. A recorded
        // take holding the recording slot would shadow it, so hand the slot
        // back to the source clip (the "no take" state).
        //
        // THE DEFAULT TRACK ONLY, and this is why added tracks were given ONE
        // slot rather than a pair. The juggle exists because the default row's
        // resolution prefers whatever holds `"recording"`, and it works only
        // because there is a shared source clip to park that slot on. An added
        // track has no such clip — and needs no juggle, because its recorded
        // and generated takes are siblings in one slot, so picking either
        // deselects the other through the per-(cell, slot) rule the server
        // already enforces.
        const recSel = isDefaultTrackSlot(targetSlot) ? audioEntry?.selectedAudioId : null
        if (recSel && audioIdSeededWith(recSel, activeCell.id) && sourceClip) {
          const displaceP = emitCellAudioSelect({
            projectId: project.id, fileId: activeCell.fileId, cellId: activeCell.id,
            audioId: sourceClip.audioId, slot: "recording", author: username,
          })
          injectOptimisticAudioAttachment(activeCell.fileId, activeCell.id, sourceClip, displaceP)
          await displaceP
          notifyAudioAttachmentsChanged(activeCell.fileId)
        }
      }
    } finally {
      setTtsBusy(false)
    }
  }, [online, activeCell, session, ttsBusy, project, username, recordingTakes, audioEntry?.selectedAudioId, sourceClip, targetSlot])

  // Settle on the next line after a brief success indication. The RECORDED path
  // only: this used to be shared with the uploaded one so that keeping a take
  // meant the same thing either way, and AQU-1216 reversed that inheritance —
  // an upload has no performance to end, so it stays put (see
  // `attachPickedFile`). Everything else in the phase machine is still shared.
  //
  // SUB-50: opt-out for repeat takes on one line, and the handle is tracked so
  // closing or navigating inside the 450ms window can't fire a stray jump after
  // the fact. `stayOnThisLine` cancels it outright when the user reaches for
  // Record or Upload inside that window.
  const scheduleAutoAdvance = useCallback(() => {
    if (!autoAdvance) return
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
    advanceTimerRef.current = setTimeout(() => {
      advanceTimerRef.current = null
      const nextIdx = activeIndex + 1
      if (nextIdx < cells.length) {
        onActiveCellChange(cells[nextIdx].id)
      } else {
        onClose()
      }
    }, 450)
  }, [autoAdvance, activeIndex, cells, onActiveCellChange, onClose])

  const save = useCallback(async () => {
    if (recorder.state.kind !== "stopped") return
    // Silent backstop for the Space/Enter path — deliberately NOT the error
    // phase (that replaces the preview UI and its footer has no Save button,
    // stranding a reconnected user). The disabled Save button + the visible
    // preview notice carry the message; the take stays previewable and saves
    // once the connection returns.
    if (!online) return
    if (!session?.jwt || !activeCell) return
    setPhase("uploading")
    setErrorMessage(null)
    try {
      const blob = recorder.state.blob
      const ext = recorder.state.ext
      // The armed recorder keeps ~200ms of the countdown as the take's head so
      // an early entrance — the count-in working — is IN the file. Read here,
      // used after the attach to anchor the take that much before its line.
      const preRollMs = recorder.state.preRollMs ?? 0
      // Belt and braces. The hard stop that ends a take is DERIVED from this
      // same cap (recording-limits.ts), so this should be unreachable — it is
      // here so that a future change to the capture rate or bitrate fails
      // loudly, and recoverably, instead of turning into a rejected PUT after
      // the operator has already given the performance. Thrown, so it lands in
      // the catch below and bounces back to the PREVIEW with the take intact.
      if (blob.size > MAX_AUDIO_UPLOAD_BYTES) {
        throw new Error(
          `This take is ${Math.round(blob.size / (1024 * 1024))} MB, over the ` +
          `${Math.round(MAX_AUDIO_UPLOAD_BYTES / (1024 * 1024))} MB upload limit. ` +
          "Record a shorter take, or switch the format to compressed.",
        )
      }
      // SUB-48: the recorder already TIMED this take — use that, never a probe.
      // Chrome writes no duration header into MediaRecorder webm, so probing
      // the blob raced a timeout and long takes silently attached with no
      // length at all, leaving their chips stuck at section width. The WAV path
      // makes this stronger rather than weaker: its duration is sample-exact
      // (frames ÷ the context's real rate), so a probe there would be strictly
      // worse than the number already in hand. Do not re-add one for either
      // branch.
      const takeDurationMs = Math.round(recorder.state.durationSec * 1000)
      // Round 5: the take is BORN trimmed. The pre-roll and the stop-grace are
      // real audio and stay in the file — the window simply OPENS ON THE CUE'S
      // OWN START and closes just past the end of the performance. That is what
      // keeps a well-placed take from being drawn (and flagged) as though it
      // overlapped its neighbours: both margins used to stick out into the gap
      // between two hand-written cues and collide there. The edge handles walk
      // the margin back whenever a line disagrees.
      //
      // The lane offset is resolved HERE, before the attach, precisely so the
      // head trim can undo exactly the shift that gets stored — including the
      // file-zero clamp. Deriving it from `preRollMs` instead would drift,
      // because the pre-roll ring keeps whole buffers and so hands back rather
      // more than the 200ms it was asked for. See take-margins.ts.
      const laneOffsetMs =
        preRollMs > 0 && activeCell.startTime != null
          ? targetOffsetMsFor(activeCell, activeCell.startTime - preRollMs / 1000)
          : null
      const takeTrimWindow = takeTrims({
        targetOffsetMs: laneOffsetMs ?? undefined,
        tailGraceMs: recorder.state.tailGraceMs,
        durationMs: takeDurationMs,
      })
      const audioId = buildAudioId(activeCell.id)
      // Warm the OPFS byte cache BEFORE upload (FRO-355), keyed exactly as
      // transcribeCell/useCellAudio look bytes up (audioId+ext of the
      // frontier-audio:// URL). Once the attach lands, the take transcribes
      // and plays from local bytes — no network, no JWT — and the post-save
      // auto-transcribe below gets a deterministic cache hit. (If the upload
      // throws, save() aborts before the attach, so the orphaned cache entry
      // is unreachable and simply ages out of the LRU.)
      await audioCachePutBlob(audioId, ext, blob)
      const result = await uploadCellAudio({
        projectId: project.id,
        fileId: activeCell.fileId,
        audioId,
        ext,
        blob,
        getSyncToken: audioSyncTokenFetcherForSession(session),
      })
      // Attach the upload to the cell via the AD-2 audio grammar
      // (cell.audio.attach → cell_audio projection). The event.applied broadcast
      // pokes the per-file audio read so the clip surfaces; poke locally too so
      // it shows even if the WS is momentarily down.
      const savedAudioId = result.audioId
      setTranscribeStatus(savedAudioId, { kind: "idle" })
      markProjectHasAudioDataSoon(project.id)
      // Round 8: takes are BORN with their permanent name — never renumbered.
      const takeLabel = nextTakeLabel(recordingTakes)
      let attachEventId: string
      try {
        attachEventId = await emitCellAudioAttach({
          projectId: project.id,
          fileId: activeCell.fileId,
          cellId: activeCell.id,
          audioId: `${result.audioId}.${result.ext}`,
          url: result.url,
          slot: targetSlot,
          mimeType: blob.type || undefined,
          durationMs: takeDurationMs,
          ...takeTrimWindow,
          label: takeLabel,
          author: username,
        })
      } catch (emitErr) {
        // F8: R2 upload succeeded but event emit failed — delete the orphaned
        // R2 object so it doesn't waste storage. Error is non-fatal for the
        // cleanup itself; we always re-throw the original emit error.
        void deleteCellAudio({
          projectId: project.id,
          fileId: activeCell.fileId,
          audioId: result.audioId,
          ext: result.ext,
          getSyncToken: audioSyncTokenFetcherForSession(session),
        })
        throw emitErr
      }
      // Optimistically surface the clip so the gutter mic flips to a play
      // button immediately. The bus poke below refetches the server projection,
      // but that races the outbox flush + projection and would otherwise leave
      // the icon stale until a manual reload.
      injectOptimisticAudioAttachment(activeCell.fileId, activeCell.id, {
        audioId: `${result.audioId}.${result.ext}`,
        url: result.url,
        slot: targetSlot,
        mimeType: blob.type || null,
        voiceId: null,
        referenceAudioId: null,
        durationMs: takeDurationMs,
        label: takeLabel,
        // The SAME window the attach carried — an optimistic chip drawn at full
        // clip length would flash its margins (and any overlap warning they
        // trip) until the server projection lands and silently corrected it.
        trimStartMs: takeTrimWindow.trimStartMs ?? null,
        trimEndMs: takeTrimWindow.trimEndMs ?? null,
      }, attachEventId)
      notifyAudioAttachmentsChanged(activeCell.fileId)
      // THE PRE-ROLL'S OTHER HALF. Kept head audio that isn't repositioned
      // just plays everything late — the original take-shift bug in a new
      // hat — so the take is anchored preRollMs BEFORE its line: the sample
      // at the mark (the GO instant) lands exactly on the line's start, and
      // an early entrance sounds exactly as early as it was performed.
      //
      // Nothing is DELETED: the anchor and the trim compose. Sample zero sits
      // `preRollMs` early, and the head trim above undoes precisely that, so
      // the take OPENS ON THE LINE'S OWN START — dragging the head handle out
      // walks the pre-roll back into audibility whenever a performance wants it.
      // The offset is the one already resolved above; recomputing it here would
      // let the two drift apart, and the trim's whole job is to be its exact
      // inverse.
      //
      // Deliberately re-derived on every save — a hand-dragged chip position
      // describes the PREVIOUS take, and the new recording was performed
      // against the line's own start. Non-fatal on failure: the take is already
      // attached, and it merely sits `preRollMs` late until someone drags it.
      // (targetOffsetMsFor clamps at file zero, so a line in the first 200ms of
      // the film keeps what runway it has — and the trim inherits the clamp.)
      if (laneOffsetMs != null) {
        try {
          await emitCellLaneRetime({
            projectId: project.id,
            fileId: activeCell.fileId,
            cellId: activeCell.id,
            targetOffsetMs: laneOffsetMs,
            author: username,
          })
        } catch {
          /* anchored at the line start instead — playable, just not early */
        }
      }
      // The take is real now. Tell the workspace, so a line that has only ever
      // held audio gets the target row that makes it countable and validatable.
      onTakeSaved?.(activeCell.id)
      returnToReady(`${takeLabel} saved`)
      // Fire Whisper transcription in the background — user gets karaoke as
      // soon as the model is ready; doesn't block the auto-advance.
      const fullAudioId = `${result.audioId}.${result.ext}`
      void transcribeCell({
        cell: {
          ...activeCell,
          selectedAudioId: fullAudioId,
          attachments: {
            ...activeCell.attachments,
            // SUB-49: hand transcription the REAL attachment. It re-attaches
            // when it finishes and forwards whatever it finds here; a stub of
            // `{url, type}` meant the re-attach carried no duration, which
            // wiped the take's length a minute after saving. Mirrors the seed
            // built by auto-transcribe.ts. (The mime type isn't carried on
            // this shape; the projection's COALESCE protects it instead.)
            [fullAudioId]: { url: result.url, type: "audio", durationMs: takeDurationMs },
          },
        },
        session,
        projectId: project.id,
        language: project.targetLanguage,
        // AQU-646: state the slot rather than letting transcription infer it
        // from the stub above. The stub carries `selectedAudioId` and no slot,
        // so the inference would read every take as "recording" — which was
        // right until a take could belong to a second target track, and is a
        // DATA-MOVER now: the re-attach assigns slot outright and its
        // sibling-deselect would drop that track's real take. This is the
        // caller that knows, so it says.
        slot: targetSlot,
      })
      scheduleAutoAdvance()
    } catch (e) {
      // A network failure that raced the online flag reads as the same
      // offline story, not a raw fetch error.
      setErrorMessage(!navigator.onLine ? offlineMessage : e instanceof Error ? e.message : String(e))
      // The take is still in hand (the recorder holds the stopped blob), so
      // go back to the PREVIEW, not the error phase: error's footer has no
      // Save or Retake, and the preview effect can't re-fire for this blob
      // (consumedBlobRef already equals it) — the take would be stranded
      // despite sitting right there. Preview keeps Save offered, so a flap
      // that struck mid-upload retries with the SAME take after reconnect.
      setPhase(recorder.state.kind === "stopped" ? "preview" : "error")
    }
  }, [recorder.state, online, session, activeCell, project.id, username, recordingTakes, scheduleAutoAdvance, returnToReady])

  // Attach an existing FILE as a take, through this dialog's phase machine.
  //
  // That inheritance is the whole argument for a modal-owned control rather
  // than reusing the cell rail's upload button: the same "Uploading…" stage,
  // the same saved state, the same error surface — and a take LABEL, which the
  // rail cannot supply because it has no takes list. Auto-advance is the one
  // part deliberately NOT inherited; see the tail of this callback (AQU-1216).
  const attachPickedFile = useCallback(async (file: File) => {
    if (!activeCell) return
    // A courtesy check, not the guarantee: `attachAudioFileToCell` validates
    // again and IS the gate. Doing it here as well keeps an obviously-wrong
    // pick from flashing "Uploading…" on its way to being refused.
    const invalid = validateAudioFile(file)
    if (invalid) {
      setErrorMessage(invalid)
      setPhase("error")
      return
    }
    setPhase("uploading")
    setErrorMessage(null)
    // Round 8: takes are BORN with their permanent name. The strip sits ~100px
    // below this button, so an unlabelled "Take" next to "Take 1" reads as a
    // defect. (Not auto-transcribed, deliberately — an uploaded file routinely
    // is not this line; see attach-file.ts.)
    const label = nextTakeLabel(recordingTakes)
    try {
      await attachAudioFileToCell({
        session: session ?? null,
        projectId: project.id,
        fileId: activeCell.fileId,
        cellId: activeCell.id,
        file,
        username,
        label,
        // Sam, 2026-08-24: uploading is the other way audio gets onto an added
        // track, so it follows the recorder's target the same way a take does.
        slot: targetSlot,
      })
      onTakeSaved?.(activeCell.id)
      returnToReady(`${label} added`)
      // AQU-1216: the upload path STOPS here — it does not inherit the recorded
      // take's auto-advance. A performance ends when you save it, so moving on
      // is the next thing you meant; a picked file arrives with no such moment,
      // and jumping half a second later left the operator on a different line
      // with nothing on screen to say where the file went ("I uploaded
      // successfully, but it only showed up in the Takes dropdown"). So: stay,
      // and OPEN the takes list, which is where the new take is circled as the
      // keeper and can be auditioned. In the plain layout that drawer is always
      // rendered, so this is a no-op there and the flag costs nothing.
      setTakesOpen(true)
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e))
      setPhase("error")
    }
    // `targetSlot` is read above, so it is listed — the mic-save callback next
    // door always has. It is NOT load-bearing today and the omission was never
    // a live bug: `recordingTakes` is memoised on `ownSlots`, which is itself
    // memoised on `targetSlot`, so the slot already reached this list
    // transitively and the callback was rebuilt whenever it changed. Named
    // explicitly anyway, because that chain is two hops of coincidence away
    // from someone decoupling the takes list from the track.
  }, [activeCell, session, project.id, username, recordingTakes, targetSlot, onTakeSaved, returnToReady])

  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const onUploadInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset so picking the SAME file again still fires onChange.
    e.target.value = ""
    if (file) void attachPickedFile(file)
  }, [attachPickedFile])

  // A pending advance must never outlive the modal (or a manual jump): the
  // 450ms window was previously untracked, so closing inside it still fired.
  useEffect(
    () => () => {
      if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current)
      advanceTimerRef.current = null
      if (savedNoteTimerRef.current) clearTimeout(savedNoteTimerRef.current)
      savedNoteTimerRef.current = null
    },
    [],
  )

  /**
   * AQU-646: leaving with a take you have not kept (Sam, 2026-08-26).
   *
   * A recorded take sits in `preview` until Save attaches it — nothing is
   * written until then, so every way out of this dialog silently threw it away:
   * the X, clicking outside, and (most quietly of all) Escape, which called
   * RETAKE and scrapped the take without even closing, so you stayed on the
   * screen with no sign anything had gone.
   *
   * All three now come through here. `preview` is the only phase worth asking
   * about: `uploading` is already being kept, and the earlier phases have
   * nothing recorded yet.
   */
  /**
   * What the user asked to do and has not been allowed to yet, because a take
   * is sitting unsaved. Null when nothing is pending.
   *
   * 2026-08-27: this was a bare `confirmCloseOpen` boolean, because closing was
   * the only exit that asked. But the ‹ › buttons — and Alt+Arrow, which shares
   * their handler — are an exit too: `canNav` includes `preview`, and the
   * cell-change effect calls `resetToIdle()`, which drops the pending blob. So
   * the one control an operator presses over and over while working through a
   * file was the one that threw a take away without asking. Holding the INTENT
   * rather than a flag is what lets the same confirmation serve both, which is
   * Sam's ruling: ask, exactly like the X does.
   */
  const [pendingExit, setPendingExit] = useState<PendingExit | null>(null)
  const hasUnsavedTake = phase === "preview"
  const requestClose = useCallback(() => {
    if (hasUnsavedTake) { setPendingExit({ kind: "close" }); return }
    onClose()
  }, [hasUnsavedTake, onClose])
  // Never leave the question hanging over a line it is no longer about. This
  // also clears it after a discard-and-go, which changes the active cell.
  useEffect(() => { setPendingExit(null) }, [activeCellId])

  // Deliberately still true in `preview`: the arrows have to stay pressable in
  // order to ASK. Disabling them there would answer the question by refusing to
  // pose it, and strand someone who wants to move on.
  const canNav = phase === "idle" || phase === "preview" || phase === "error"
  const gotoIndex = useCallback((idx: number) => {
    if (!canNav) return
    if (idx < 0 || idx >= cells.length) return
    if (hasUnsavedTake) { setPendingExit({ kind: "goto", index: idx }); return }
    onActiveCellChange(cells[idx].id)
  }, [canNav, cells, onActiveCellChange, hasUnsavedTake])

  // While the modal is open, claim the audio keyboard shortcuts so the global
  // Space handler doesn't toggle whatever clip the user was just playing.
  useEffect(() => {
    if (!open) return
    const release = pushAudioShortcutOverride()
    return release
  }, [open])

  // Keyboard shortcuts.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      // Typing into an input? let it through.
      const target = e.target as HTMLElement
      if (target && ["INPUT", "TEXTAREA"].includes(target.tagName)) return
      // Another dialog stacked ON TOP of the recorder (the timing-mode
      // heads-up) owns the keyboard while it holds focus — without this,
      // Escape would dismiss it AND close the recorder in one press.
      const dialogOf = target?.closest?.('[data-slot="dialog-content"], [role="dialog"]')
      if (dialogOf && !dialogOf.hasAttribute("data-recorder-dialog")) return

      if (e.key === "Escape") {
        e.preventDefault()
        if (phase === "recording") { stopRecording(); return }
        if (phase === "counting") { countdown.cancel(); setLeadIn(null); setPhase("idle"); return }
        // Escape used to RETAKE here, which threw the take away and left the
        // modal open — the quietest way in the app to lose a recording. It now
        // asks, like every other way out. Retake is still one button away.
        requestClose()
        return
      }
      // SUB-52: modifier check matches the other Space handlers — Cmd/Ctrl/
      // Alt+Space belong to the OS or other shortcuts, not to recording.
      // FORTIFY: Space on a FOCUSED BUTTON activates that button — a keyboard
      // user who tabbed to "Retake" and pressed Space was having the bad take
      // SAVED instead of discarded. The stage-5 controls (the format pill, the
      // upload button, the film's mute toggle) are all <Button>s and so are all
      // covered by it: once the mute toggle has focus, Space unmutes the film
      // instead of starting a take. That is the guard working as designed, not
      // a bug — the focused control is the one that acts. (The hidden file
      // input is caught by the INPUT check at the top of this handler.)
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (target?.tagName === "BUTTON" || target?.getAttribute?.("role") === "button") return
        e.preventDefault()
        if (phase === "idle" || phase === "error") { startFlow(); return }
        if (phase === "recording") { stopRecording(); return }
        if (phase === "preview") { void save(); return }
      }
      // ⌥/Alt + arrow, not bare arrow. The preview phase puts an <audio
      // controls> in this dialog, and a focused media control treats bare
      // arrows as SCRUBBING — so an operator nudging through a take would jump
      // to the next line instead. The modifier keeps the two apart, and it is
      // what the header's ‹ › buttons announce in their tooltips.
      if (e.altKey && e.key === "ArrowRight") { e.preventDefault(); gotoIndex(activeIndex + 1); return }
      if (e.altKey && e.key === "ArrowLeft") { e.preventDefault(); gotoIndex(activeIndex - 1); return }
      if (e.key === "Enter" && phase === "preview") { e.preventDefault(); void save(); return }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, phase, startFlow, stopRecording, countdown, retake, save, requestClose, gotoIndex, activeIndex])

  if (!open || !activeCell) return null

  const displayPhase: Phase = phase
  const elapsedMs = recorder.elapsedMs
  const targetOverrun = targetSec != null && elapsedMs / 1000 > targetSec
  const isNearLimit = recorder.isNearLimit
  // From the countdown onwards there is a take being made or already made, and
  // the capture format can no longer change anything about its bytes.
  const takeInHand = phase === "counting" || phase === "recording" || phase === "preview" || phase === "uploading"

  return (
    <>
    <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose() }}>
      {/* AQU-230: max-h constrains the dialog to the viewport (with 4vh margin)
          so it never clips at 100% zoom on 1280×800 or smaller viewports.
          The dialog is split into a fixed header, a scrollable stage+takes
          middle, and a fixed footer so navigation buttons stay reachable. */}
      {/* finalFocus={false}: closing must NOT return focus to the opener —
          the lane's mic buttons are hover-revealed, so focus would sit on an
          INVISIBLE button where Space re-opens the recorder instead of
          driving the transport. Released focus falls to the page, where
          Space belongs to playback again. */}
      <DialogContent
        ref={dialogSurfaceRef}
        initialFocus={dialogSurfaceRef}
        finalFocus={false}
        data-recorder-dialog=""
        // TWO FOOTPRINTS, ONE PANEL. Expanded is the mock's 16:9 room with the
        // picture down the left at 60%; collapsed is a 400×620 portrait column
        // whose lower half is the takes drawer. The panel itself is the SAME
        // tree in both — only its width and what sits beside it change, which
        // is what stops the two layouts drifting apart.
        //
        // `sm:max-w-*` WITH the variant is mandatory: the dialog primitive's
        // skeleton carries `sm:max-w-lg`, and a bare `max-w-*` cannot replace
        // it under tailwind-merge (different modifier, different group). Every
        // width this dialog asked for before that was understood was 512px.
        className={cn(
          "gap-0 overflow-hidden p-0",
          showFilm
            ? "flex flex-row sm:aspect-[16/9] sm:max-w-5xl"
            : "flex h-[620px] flex-col sm:max-w-[400px]",
        )}
        style={{ maxHeight: "min(92vh, 800px)" }}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {t("audio.recordingModal.dialogTitle", {
            cellLabel: activeCell.cellLabel ?? t("audio.recordingModal.cellFallback", { index: activeIndex + 1 }),
          })}
        </DialogTitle>

        {/* ─── THE PICTURE ──────────────────────────────────────────────────
            Three things live here and nothing else: the film, the collapse
            control, and the mute (inside the surface). Identity and navigation
            deliberately do NOT — they belong to the panel header, which
            survives a collapse that the picture does not, and one nav
            treatment is better than two (Sam, 2026-08-13). */}
        {showFilm && filmUrl && (
          <div className="relative hidden w-[60%] shrink-0 overflow-hidden rounded-l-3xl bg-black sm:block">
            <RecordingVideoSurface
              src={filmUrl}
              startSec={activeCell.startTime ?? null}
              // The picture is already rolling by now — the lead-in below
              // started it at the top of the countdown and brought it to this
              // line's first frame at zero. `running` only keeps it going, and
              // it runs ON past the end of the line so an overrun is visible.
              running={displayPhase === "recording"}
              armNonce={armNonce}
              leadIn={leadIn}
            />
            <AppTooltip content={t("audio.recordingModal.collapseFilmTooltip")}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="rec-collapse-video"
                onClick={() => setRecordingVideoCollapsed(true)}
                aria-label={t("audio.recordingModal.collapseFilmAriaLabel")}
                className="absolute top-3 right-3 z-10 h-7 gap-1.5 rounded-md bg-black/65 px-2.5 text-[11px] text-white/80 backdrop-blur-sm hover:bg-black/80 hover:text-white"
              >
                <Minimize2 className="h-3.5 w-3.5" /> {t("audio.recordingModal.collapseFilmButton")}
              </Button>
            </AppTooltip>
          </div>
        )}

        {/* ─── THE PANEL ────────────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">

          {/* HEADER — identity and navigation only. Two rows on purpose: a long
              label truncates on its own line while the counter and its arrows
              keep a fixed, unwrappable width beneath it. The single-row version
              of this is what shredded into three wrapped columns at 400px. */}
          <div className="shrink-0 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {activeCell.cellLabel ?? t("audio.recordingModal.cellFallback", { index: activeIndex + 1 })}
              </span>
              {/* Only when a film EXISTS but is collapsed — a line without one
                  never offers to show a picture it does not have. */}
              {filmUrl && videoCollapsed && (
                <AppTooltip content={t("audio.recordingModal.expandFilmTooltip")}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="rec-expand-video"
                    onClick={() => setRecordingVideoCollapsed(false)}
                    aria-label={t("audio.recordingModal.expandFilmAriaLabel")}
                    className="h-7 shrink-0 gap-1.5 px-2 text-[11px] text-muted-foreground/70"
                  >
                    <Maximize2 className="h-3.5 w-3.5" /> {t("editor.timeline.videoPaneTitle")}
                  </Button>
                </AppTooltip>
              )}
              <AppTooltip content={t("audio.recordingModal.closeTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={requestClose}
                  aria-label={t("common.close")}
                  className="shrink-0 text-muted-foreground/60"
                >
                  <X />
                </Button>
              </AppTooltip>
            </div>
            {/* The arrows FLANK the counter rather than sitting at the row's
                edges: together they read as one navigation control, and they
                stay put when the counter's width changes between lines. */}
            <div className="mt-1.5 flex items-center gap-0.5">
              <AppTooltip content={t("audio.recordingModal.prevLineTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid="rec-prev"
                  disabled={!canNav || activeIndex <= 0}
                  onClick={() => gotoIndex(activeIndex - 1)}
                  aria-label={t("audio.playbackBar.previousLine")}
                  className="h-6 w-6 shrink-0 text-muted-foreground/70"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </Button>
              </AppTooltip>
              <span
                data-testid="recorder-window"
                className={cn(
                  "min-w-0 truncate px-1 font-mono text-[10px] tabular-nums",
                  // AQU-646: a window this short is very likely a mistake — say
                  // so and let them carry on anyway. Never a block; it stays the
                  // user's call (Sam).
                  targetSec != null && targetSec < MIN_USEFUL_REGION_SEC
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-muted-foreground",
                )}
                title={
                  targetSec != null && targetSec < MIN_USEFUL_REGION_SEC
                    ? t("audio.recordingModal.veryShortWindowTitle")
                    : undefined
                }
              >
                {targetSec == null
                  ? t("audio.recordingModal.lineCounter", {
                      index: activeIndex + 1,
                      total: cells.length,
                    })
                  : targetSec < MIN_USEFUL_REGION_SEC
                    ? t("audio.recordingModal.lineCounterVeryShort", {
                        index: activeIndex + 1,
                        total: cells.length,
                        seconds: targetSec.toFixed(2),
                      })
                    : t("audio.recordingModal.lineCounterWindow", {
                        index: activeIndex + 1,
                        total: cells.length,
                        seconds: targetSec.toFixed(2),
                      })}
              </span>
              <AppTooltip content={t("audio.recordingModal.nextLineTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  data-testid="rec-next"
                  disabled={!canNav || activeIndex >= cells.length - 1}
                  onClick={() => gotoIndex(activeIndex + 1)}
                  aria-label={t("audio.playbackBar.nextLine")}
                  className="h-6 w-6 shrink-0 text-muted-foreground/70"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </AppTooltip>
            </div>
          </div>

          {/* THE LINE — source above, the line to speak below.
              The read-aloud block owns the space of FIVE line boxes (26/33
              expanded, 23/30 collapsed) and a longer line shrinks to fit it
              rather than scrolling — see the fit effect above. The box keeps
              `overflow-y-auto` only as the floor's safety valve: past half size
              the text is allowed to scroll rather than become unreadable. */}
          {/* THE LINE AND THE INSTRUMENTS, in one region that can shrink.
              Deliberately NOT `shrink-0`: on a viewport shorter than the
              dialog's own height the max-height clamp kicks in, and a rigid
              upper region would push the takes drawer to zero and then clip
              itself against `overflow-hidden` — the button you need would be
              the thing that vanished. Shrinkable, it scrolls instead, and the
              read-aloud block inside keeps its own five-line cap regardless. */}
          <div
            className={cn(
              "flex min-h-0 flex-col overflow-y-auto",
              // Expanded it also GROWS, so the spacer below can push the
              // instruments to the bottom of the column.
              showFilm && "flex-1",
            )}
          >
          <div className="shrink-0 px-4 pt-3">
            <div className="text-[10px] font-medium tracking-wide text-muted-foreground/60 uppercase">
              {t("editor.column.source")}
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
              {activeCell.original || <span className="text-muted-foreground/60 italic">{t("audio.recordingModal.emptySource")}</span>}
            </p>
            {/* Who is speaking, and whether the camera is on them — the two
                things a performer settles BEFORE the first word, so they sit
                above the line rather than beside the meter.

                OUTSIDE `readAloudBoxRef` on purpose. That box is a measured
                five-line fit whose font size is binary-searched against
                `readAloudBudget`; anything added inside it silently shrinks
                the performer's type. Sharing the label's row costs the line
                nothing at all. */}
            <div className="mt-3 flex items-baseline gap-2">
              <div className="text-[10px] font-medium tracking-wide text-muted-foreground/60 uppercase">
                {t("audio.recordingModal.readAloudLabel")}
              </div>
              {readAloudCast && (
                <div
                  data-testid="rec-read-aloud-cast"
                  className="ml-auto flex min-w-0 items-baseline gap-1.5 text-right"
                >
                  <span className="truncate text-xs font-semibold">{readAloudCast}</span>
                  {readAloudCamera && (
                    <span
                      data-testid="rec-read-aloud-camera"
                      className={cn(
                        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tracking-wide uppercase",
                        // "On camera" is the one that changes the take — it
                        // means lip-sync — so it is the one that carries
                        // colour. Off camera is the quiet default.
                        readAloud?.cameraState === "on"
                          ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      {readAloudCamera}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div
              ref={readAloudBoxRef}
              className="mt-1 overflow-y-auto"
              style={{
                maxHeight: readAloudBudget,
                scrollbarGutter: "stable",
              }}
            >
              <p
                ref={readAloudRef}
                data-testid="rec-read-aloud"
                className="font-medium tracking-[-0.01em]"
                style={{
                  fontSize: readAloudPx,
                  lineHeight: `${Math.round(readAloudPx * readAloudRatio)}px`,
                }}
              >
                {readAloudText || (
                  <span className="text-base text-muted-foreground/60 italic">{t("audio.recordingModal.notTranslated")}</span>
                )}
              </p>
            </div>
            {/* The cue's own transcript. Only shown when the line above came
                from somewhere else — i.e. one subtitle covers several heard
                lines — because that is the only time the performer has to work
                out which part of it belongs to this take. */}
            {readAloudReference && (
              <p
                data-testid="rec-cue-reference"
                className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground/70"
              >
                <span className="font-medium">{t("audio.recordingModal.cueReferenceLabel")} </span>
                {readAloudReference}
              </p>
            )}
            {/* AQU-646: what a GENERATED voice just did here.
                
                Right beside the transcript above, which appears on exactly this
                condition and for the neighbouring reason — that one tells the
                performer which part of the line is theirs; this one says a
                machine voice makes no such distinction.
                
                AFTER THE PRESS, NOT BEFORE (Sam, 2026-08-27), which reverses
                the original call that it should warn first. The reason the
                first version was wrong: it fires on "this subtitle is shared",
                NOT on "you are about to generate" — so a performer doing mic
                takes got a permanent paragraph about text-to-speech, on roughly
                one line in twelve, for a button they may never press.
                
                Moving it costs less than it looks: generating is cheap and
                undoable, so this never guarded against loss. It corrects a
                mental model, and afterwards it does that better — before, it is
                an abstract caveat; after, it is a to-do that names exactly what
                is still silent.
                
                `ttsDone` is precisely the right signal and already existed: set
                only when a generation SUCCEEDED (a failure leaves its own red
                message and must not be told the others are silent, because
                nothing was voiced), and cleared when the active line changes,
                which is the "until you leave the line" rule. */}
            {ttsSharedWith > 1 && ttsDone && (
              <p
                data-testid="rec-tts-shared-notice"
                className="mt-1.5 text-[11px] leading-snug text-amber-700 dark:text-amber-400"
              >
                {t("audio.recordingModal.ttsSharedNotice", { count: ttsSharedWith })}
              </p>
            )}
          </div>

          {/* Beside a picture the instruments sit at the BOTTOM of the column,
              so the eye runs from the line down to the meter and the button.
              Collapsed there is nothing to push them with — the takes drawer
              below is what absorbs the leftover height. */}
          {showFilm && <div className="min-h-[8px] flex-1" />}

          {/* INSTRUMENTS + ANCHOR — the same skeleton in every phase: what the
              take looks like, then the one button that acts on it, then the
              alternatives to it. Only the middle changes. */}
          <div className="shrink-0 space-y-3 px-4 pt-4 pb-4">
            {/* ── the phase's own instrument ──
                COUNTING and RECORDING share ONE block so the waveform below is
                a SINGLE mounted element across the flip. That is a correctness
                rule, not tidiness: the waveform owns an AudioContext on the
                live mic, and unmount/remount at zero would close and reopen it
                exactly when nothing is allowed to touch the audio device — the
                device restart that ate the first word of a take (2026-08-14).
                Mounted from the countdown's first frame, any renegotiation it
                does cause lands in discarded pre-mark audio; it also puts the
                live meter under the count, which is the honest version of
                "the mic is already hot when GO appears". */}
            {/* Mounted whenever the session HOLDS a stream — not just while
                counting/recording — and merely display-hidden otherwise. The
                meter owns an AudioContext on the live mic, and unmounting it
                between takes closes and reopens that context per take: churn
                the OS answers with an input-gain recovery ramp through the
                next take's head. One mount, one context, whole session. */}
            {/* i18n-exempt "counting"/"recording" are RecorderPhase union tags, not copy */}
            {(displayPhase === "counting" || displayPhase === "recording" || recorder.stream != null) && (
              <div
                className={cn(
                  "space-y-2",
                  displayPhase !== "counting" && displayPhase !== "recording" && "hidden",
                )}
              >
                {displayPhase === "counting" ? (
                  <div className="flex h-[28px] items-center justify-center">
                    <div
                      key={countdown.count}
                      className="text-2xl font-semibold tabular-nums text-foreground/80"
                      style={{ animation: "pop 700ms ease-out" }}
                    >
                      {countdown.count === 0 ? t("audio.recordingModal.countingGo") : countdown.count}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
                    <span className="text-xs font-semibold text-red-500">REC</span>
                    <span className="font-mono text-lg tabular-nums">{formatClock(elapsedMs)}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {t("audio.recordingModal.maxDuration", { minutes: minutesOf(formatLimits.hardStopMs) })}
                    </span>
                  </div>
                )}
                <div className="relative">
                  <AudioWaveform
                    stream={recorder.stream}
                    height={44}
                    // Grey while the countdown runs — the mic is hot, the take
                    // has not begun — and red from zero. Same element, same
                    // audio graph, different ink (Sam, 2026-08-14).
                    tone={displayPhase === "recording" ? "live" : "armed"}
                    className="rounded-md border bg-muted/40"
                  />
                  {/* Zero's visual beat. The count block above flips to REC
                      within a frame of GO, so without this the word GO is
                      gone before it lands — and the silent fourth beat needs
                      its visual (the audible one would print into the take).
                      With the countdown off (AQU-1209) there is no zero to
                      mark: the operator pressed Record and the take began, so
                      GO would be announcing an instant nothing led up to. */}
                  {/* i18n-exempt "recording" is a RecorderPhase union tag, not copy */}
                  {countdownEnabled && displayPhase === "recording" && elapsedMs < 700 && (
                    <div
                      className="pointer-events-none absolute inset-0 flex items-center justify-center text-3xl font-semibold text-foreground/70"
                      style={{ animation: "pop 700ms ease-out" }}
                      aria-hidden
                    >
                      GO
                    </div>
                  )}
                </div>
                {/* i18n-exempt "recording" is a RecorderPhase union tag, not copy */}
                {displayPhase === "recording" && targetSec != null && <DurationBar elapsedMs={elapsedMs} targetSec={targetSec} />}
                {/* i18n-exempt "recording" is a RecorderPhase union tag, not copy */}
                {displayPhase === "recording" && targetOverrun && (
                  <p className="text-xs font-medium text-red-500">{t("audio.recordingModal.overrunNotice")}</p>
                )}
                {/* i18n-exempt "recording" is a RecorderPhase union tag, not copy */}
                {displayPhase === "recording" && isNearLimit && (
                  <p className="text-xs font-medium text-amber-500">
                    {/* Derived from the ACTIVE format's limits: WAV is ~3× the
                        bytes of a compressed take, so its window is much
                        shorter, and both are computed from the upload cap. */}
                    {t("audio.recordingModal.nearLimitNotice", {
                      warnMinutes: minutesOf(formatLimits.warnMs),
                      hardStopMinutes: minutesOf(formatLimits.hardStopMs),
                    })}
                  </p>
                )}
              </div>
            )}

            {/* i18n-exempt "preview" is a RecorderPhase union tag, not copy */}
            {displayPhase === "preview" && previewUrl && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" /> {t("audio.recordingModal.capturedNotice")}
                </div>
                <audio ref={previewAudioRef} src={previewUrl} controls className="h-9 w-full" preload="auto" />
                {targetSec != null && <DurationBar elapsedMs={elapsedMs} targetSec={targetSec} />}
                {!online && (
                  <p data-testid="rec-offline-notice" className="text-xs font-medium text-amber-500">
                    {OFFLINE_MESSAGE}
                  </p>
                )}
                {online && errorMessage != null && errorMessage !== OFFLINE_MESSAGE && (
                  <p data-testid="rec-save-error" className="text-xs font-medium text-destructive">
                    {t("audio.recordingModal.saveFailedNotice", { error: errorMessage })}
                  </p>
                )}
              </div>
            )}

            {/* i18n-exempt "uploading" is a RecorderPhase union tag, not copy */}
            {displayPhase === "uploading" && (
              <div className="flex h-[76px] flex-col items-center justify-center gap-2 text-muted-foreground">
                <Spinner className="size-6" />
                <p className="text-xs">{t("common.uploading")}</p>
              </div>
            )}

            {/* IDLE and ERROR share an instrument: the window, with nothing in
                it yet. No waveform, no mic block, no elapsed readout — the bar
                shows the target notch and the two numbers, and the button below
                is the thing you are meant to be looking at. A take that has just
                been kept lands HERE, not in a state of its own: the note below
                marks it and everything else stays exactly where it was. */}
            {/* i18n-exempt "idle"/"error" are RecorderPhase union tags, not copy */}
            {(displayPhase === "idle" || displayPhase === "error") && (
              <div className="space-y-2">
                {targetSec != null ? (
                  <DurationBar elapsedMs={0} targetSec={targetSec} />
                ) : (
                  <p className="text-xs text-muted-foreground">{t("audio.recordingModal.noTimedWindow")}</p>
                )}
                {/* i18n-exempt "error" is a RecorderPhase union tag, not copy */}
                {displayPhase === "error" && (
                  <p data-testid="rec-error-message" className="text-xs font-medium text-destructive">
                    {errorMessage ?? t("audio.recordingModal.genericError")}
                  </p>
                )}
                {savedNote != null && (
                  <p
                    data-testid="rec-saved-note"
                    className="flex items-center gap-1.5 text-xs font-medium text-emerald-500"
                  >
                    <Check className="h-3.5 w-3.5 shrink-0" /> {savedNote}
                  </p>
                )}
              </div>
            )}

            {/* ── the anchor ── one 52px action, always in the same place, so
                the button never moves between phases. Preview is the single
                exception the design asks for: discarding and keeping are a
                genuine fork, so they sit side by side at equal weight. */}
            {/* i18n-exempt "preview"/"recording"/"counting" are RecorderPhase union tags, not copy */}
            {displayPhase === "preview" ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  data-testid="rec-retake"
                  onClick={retake}
                  className="h-[52px] flex-1 text-sm font-semibold"
                >
                  <RefreshCw className="mr-1.5 h-4 w-4" /> {t("audio.recordingModal.retakeButton")}
                </Button>
                <AppTooltip content={online ? t("audio.recordingModal.saveTooltip") : OFFLINE_MESSAGE}>
                  <span className="inline-flex flex-1">
                    <Button
                      data-testid="rec-save"
                      disabled={!online}
                      onClick={save}
                      className="h-[52px] w-full text-sm font-semibold"
                    >
                      {t("common.save")}
                    </Button>
                  </span>
                </AppTooltip>
              </div>
            ) : displayPhase === "recording" ? (
              <Button
                variant="destructive"
                data-testid="rec-stop"
                onClick={stopRecording}
                className="h-[52px] w-full text-sm font-semibold"
              >
                <Square className="mr-2 h-4 w-4" /> {t("common.stop")} <span className="ml-1.5 opacity-60">· SPACE</span>
              </Button>
            ) : displayPhase === "counting" ? (
              <Button
                variant="outline"
                onClick={() => { countdown.cancel(); setLeadIn(null); setPhase("idle") }}
                className="h-[52px] w-full text-sm font-semibold"
              >
                {t("common.cancel")} <span className="ml-1.5 opacity-60">· ESC</span>
              </Button>
            ) : (
              <AppTooltip content={online ? t("audio.recordingModal.startTooltip") : OFFLINE_MESSAGE}>
                <span className="inline-flex w-full">
                  <Button
                    data-testid="rec-start"
                    disabled={!online || displayPhase === "uploading"}
                    onClick={startFlow}
                    className="h-[52px] w-full text-sm font-semibold"
                  >
                    <Mic className="mr-2 h-4 w-4" /> {t("editor.audio.recordShort")} <span className="ml-1.5 opacity-60">· SPACE</span>
                  </Button>
                </span>
              </AppTooltip>
            )}

            {/* ── the alternatives ── shorter, outlined, quieter than the
                anchor. Hidden from the countdown onwards so the waveform gets
                the room; kept in ERROR, which is exactly where a blocked
                microphone lands and where "let me upload instead" earns its
                place. */}
            {/* i18n-exempt "idle"/"error" are RecorderPhase union tags, not copy */}
            {(displayPhase === "idle" || displayPhase === "error") && (
              // AQU-646 stage 4c: the row and the reason beneath it are one
              // group, so the parent's `space-y-3` separates the GROUP from the
              // anchor above while the explanation stays tucked under the
              // button it belongs to.
              <div className="space-y-1.5">
              <div className="flex gap-2">
                <AppTooltip
                  content={
                    !online
                      ? OFFLINE_MESSAGE
                      : ttsUnlinked
                        ? t("audio.recordingModal.ttsNoLinkedLine")
                        : !ttsText
                          ? t("audio.recordingModal.ttsNeedsTranslation")
                          : ttsShowFailure && ttsFailure
                            ? // The verbatim text, which the line below
                              // deliberately does not show: the sentence there
                              // is for the user, this is for whoever they end
                              // up sending it to.
                              t("audio.recordingModal.ttsFailedTooltip", { error: ttsFailure.raw })
                            : ttsDone
                              ? t("audio.recordingModal.ttsDoneTooltip")
                              : t("audio.recordingModal.ttsTooltip")
                  }
                >
                  <span className="inline-flex min-w-0 flex-1">
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="rec-generate-tts"
                      // A FAILURE NEVER DISABLES THIS. Pressing it again IS the
                      // retry, and the retry is what clears the state — the run
                      // writes `loading` before it does anything else.
                      disabled={!online || !ttsText || ttsWorking}
                      onClick={() => void generateTts()}
                      className={cn(
                        "h-9 w-full text-xs font-normal",
                        // No `outline`+`destructive` variant exists, so the tone
                        // is overridden here; `cn` is tailwind-merge, so these
                        // win over the resting pair rather than fighting it.
                        ttsShowFailure
                          ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
                          : "bg-muted/30 text-muted-foreground",
                      )}
                    >
                      {ttsWorking ? (
                        <Spinner className="mr-1.5 size-3.5" />
                      ) : ttsShowFailure ? (
                        <AlertCircle className="mr-1.5 h-3.5 w-3.5" />
                      ) : (
                        <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      )}
                      {/* TWO FIXED WORDS ON FAILURE (Sam, 2026-08-26), never the
                          reason: this control is about half the panel wide, and a
                          reason cropped to "Gemini API key requ…" is worse than
                          one said in full on the line below. */}
                      <span className="truncate">
                        {ttsWorking
                          ? ttsProgressPct != null
                            ? t("audio.recordingModal.ttsDownloadingPct", { percent: ttsProgressPct })
                            : ttsStatus.kind === "synthesizing"
                              ? t("common.synthesizing")
                              : t("audio.recordingModal.generateButton")
                          : ttsShowFailure
                            ? t("audio.recordingModal.ttsFailedButton")
                            : t("audio.recordingModal.generateButton")}
                      </span>
                    </Button>
                  </span>
                </AppTooltip>
                <input
                  ref={uploadInputRef}
                  type="file"
                  accept={ACCEPT}
                  className="sr-only"
                  onChange={onUploadInputChange}
                  aria-label={t("editor.audio.upload")}
                  // Diverges from the cell rail's copy of this input ON PURPOSE:
                  // inside a focus trap an invisible tab stop is a real
                  // annoyance, and the visible button beside it already carries
                  // the accessible name and the click.
                  tabIndex={-1}
                />
                <AppTooltip content={online ? t("audio.recordingModal.uploadTooltip") : OFFLINE_MESSAGE}>
                  <span className="inline-flex min-w-0 flex-1">
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="rec-upload"
                      disabled={!online}
                      onClick={() => { stayOnThisLine(); uploadInputRef.current?.click() }}
                      className="h-9 w-full bg-muted/30 text-xs font-normal text-muted-foreground"
                    >
                      <Upload className="mr-1.5 h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{t("audio.recordingModal.uploadButton")}</span>
                    </Button>
                  </span>
                </AppTooltip>
              </div>
              {/* THE REASON, WRITTEN OUT (Sam, 2026-08-26). Full panel width,
                  wrapping, no hover required — the button says that it failed
                  and this says what to do about it.

                  `title` is the categorizer's translated heading and `body` its
                  plain-language advice; the `body !== title` guard is for the
                  branches that have no better sentence than the heading itself,
                  where repeating it would read as a stutter. The verbatim
                  server text is NOT here — it is in the button's tooltip, since
                  `voice/tts failed (503): TTS not configured` is for support,
                  not for the person trying to record a line.

                  Same `text-xs font-medium text-destructive` as the recorder's
                  own `rec-error-message` and `rec-save-error` a few elements
                  up, so the panel has one voice for "this went wrong". */}
              {ttsShowFailure && ttsFailureLine && (
                <p data-testid="rec-tts-error" className="text-xs font-medium text-destructive">
                  {ttsFailureLine}
                </p>
              )}
              </div>
            )}
          </div>

          </div>{/* end line + instruments */}

          {/* THE UTILITY STRIP — takes, the format the takes are in, and the
              settings that describe recording. One row, always in the same
              place. Expanded it is a disclosure bar with the list raised over
              the column; collapsed it is the header of a drawer that fills the
              rest of the panel. `relative` so the raised list can anchor to it. */}
          <div className="relative shrink-0 border-t bg-muted/20">
            {/* The raised list, expanded only. `bottom-full` puts it directly
                above this strip; capped so it can never cover the line being
                read, and scrolling inside that cap. */}
            {showFilm && takesOpen && listedTakeCount > 0 && activeCell && (
              <div className="absolute inset-x-0 bottom-full z-20 max-h-[260px] overflow-y-auto border-t bg-popover shadow-[0_-10px_28px_rgba(0,0,0,0.2)]">
                <GroupedTakes
                  groups={takeGroups}
                  project={project}
                  cell={activeCell}
                  entry={audioEntry}
                  sourceClip={sourceClip}
                  username={username}
                  session={session ?? null}
                  onLastTakeRemoved={onLastTakeRemoved}
                />
              </div>
            )}
            <div className="flex items-center gap-2 px-4 py-2">
              {showFilm ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="rec-takes-toggle"
                  aria-expanded={takesOpen}
                  disabled={listedTakeCount === 0}
                  onClick={() => setTakesOpen((v) => !v)}
                  className="h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
                >
                  {t("audio.recordingModal.takesLabel")} <span className="font-mono tabular-nums">{listedTakeCount}</span>
                  <ChevronUp className={cn("h-3.5 w-3.5", takesOpen && "rotate-180")} />
                </Button>
              ) : (
                <span data-testid="rec-takes-count" className="shrink-0 px-1 text-xs font-medium">
                  {t("audio.recordingModal.takesLabel")} <span className="font-mono tabular-nums text-muted-foreground">{listedTakeCount}</span>
                </span>
              )}

              {/* The format lives HERE, not in the header: it describes the
                  bytes of the takes listed under it, and once a take is in hand
                  it is a statement about that take rather than a choice. */}
              <AppTooltip
                content={
                  takeInHand
                    ? t("audio.recordingModal.formatLockedTooltip")
                    : recordingFormat === "wav"
                      ? t("audio.recordingModal.formatWavTooltip")
                      : t("audio.recordingModal.formatCompressedTooltip")
                }
              >
                <span className="ml-auto inline-flex shrink-0">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="rec-format"
                    aria-pressed={recordingFormat === "wav"}
                    aria-label={
                      recordingFormat === "wav"
                        ? t("audio.recordingModal.formatWavAriaLabel")
                        : t("audio.recordingModal.formatCompressedAriaLabel")
                    }
                    disabled={takeInHand}
                    onClick={() => setRecordingFormatPref(recordingFormat === "wav" ? "webm" : "wav")}
                    className="h-7 gap-1 px-2 font-mono text-[10px] tracking-wide text-muted-foreground/70"
                  >
                    {recordingFormat === "wav" ? "WAV" : "COMPRESSED"}
                    {takeInHand && <Lock className="h-3 w-3" />}
                  </Button>
                </span>
              </AppTooltip>

              {/* Auto-advance, the countdown and its beep: consulted rarely,
                  and out of the header entirely so it can be identity and
                  navigation. */}
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      data-testid="rec-settings"
                      aria-label={t("audio.recordingModal.settingsAriaLabel")}
                      className="h-7 w-7 shrink-0 text-muted-foreground/70"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                    </Button>
                  }
                />
                <PopoverContent align="end" side="top" className="w-64 p-1.5">
                  <button
                    type="button"
                    data-testid="rec-auto-advance"
                    aria-pressed={autoAdvance}
                    onClick={() => setRecordingAutoAdvance(!autoAdvance)}
                    className="flex w-full items-start gap-2.5 rounded-md p-2 text-left hover:bg-muted"
                  >
                    <ChevronsRight
                      className={cn("mt-0.5 h-4 w-4 shrink-0", autoAdvance ? "text-foreground" : "text-muted-foreground/50")}
                    />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{t("audio.recordingModal.autoAdvanceTitle")}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">
                        {autoAdvance
                          ? t("audio.recordingModal.autoAdvanceOnDescription")
                          : t("audio.recordingModal.autoAdvanceOffDescription")}
                      </span>
                    </span>
                  </button>
                  {/* AQU-1209. Sits ABOVE the beep because it governs it: with
                      the count off there is nothing left to beep, which is what
                      the disabled state below says. */}
                  <button
                    type="button"
                    data-testid="rec-countdown"
                    aria-pressed={countdownEnabled}
                    onClick={() => setRecordingCountdown(!countdownEnabled)}
                    className="flex w-full items-start gap-2.5 rounded-md p-2 text-left hover:bg-muted"
                  >
                    {countdownEnabled ? (
                      <Timer className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <TimerOff className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{t("audio.recordingModal.countdownTitle")}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">
                        {countdownEnabled
                          ? t("audio.recordingModal.countdownOnDescription")
                          : t("audio.recordingModal.countdownOffDescription")}
                      </span>
                    </span>
                  </button>
                  {/* Not applicable rather than gone: the operator keeps their
                      beep setting, sees why it cannot be reached, and gets it
                      back untouched the moment the count is on again. */}
                  <button
                    type="button"
                    data-testid="rec-beep"
                    aria-pressed={beepEnabled}
                    disabled={!countdownEnabled}
                    onClick={() => setBeepEnabled(!beepEnabled)}
                    className="flex w-full items-start gap-2.5 rounded-md p-2 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                  >
                    {beepEnabled ? (
                      <Volume2 className="mt-0.5 h-4 w-4 shrink-0" />
                    ) : (
                      <VolumeX className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/50" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{t("audio.recordingModal.beepTitle")}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">
                        {!countdownEnabled
                          ? t("audio.recordingModal.beepNotApplicableDescription")
                          : beepEnabled
                            ? t("audio.recordingModal.beepOnDescription")
                            : t("audio.recordingModal.beepOffDescription")}
                      </span>
                    </span>
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* THE DRAWER, collapsed only — takes every pixel the panel has left,
              and is ALWAYS rendered even with nothing in it. A conditional
              drawer left the strip above floating mid-dialog with dead space
              beneath it, and made the whole bottom of the panel jump as takes
              came and went between phases. */}
          {!showFilm && (
            <div className="min-h-0 flex-1 overflow-y-auto bg-muted/20">
              {listedTakeCount > 0 && activeCell ? (
                <GroupedTakes
                  groups={takeGroups}
                  project={project}
                  cell={activeCell}
                  entry={audioEntry}
                  sourceClip={sourceClip}
                  username={username}
                  session={session ?? null}
                  onLastTakeRemoved={onLastTakeRemoved}
                />
              ) : (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground/60">
                  {t("audio.recordingModal.noTakesYet")}
                </p>
              )}
            </div>
          )}
        </div>

        {/* i18n-exempt CSS keyframes for the countdown "pop", not user-visible copy */}
        <style>{`
          @keyframes pop {
            0% { transform: scale(0.6); opacity: 0; }
            30% { transform: scale(1.15); opacity: 1; }
            100% { transform: scale(1); opacity: 1; }
          }
        `}</style>
      </DialogContent>
    </Dialog>
    {/* AQU-646: the guard on leaving with a take you have not kept.
        LAYERED, and that is not the compromise it looks like: this component
        already stacks a dialog (the timing-mode heads-up) and its keyboard
        handler already stands down for one, so the arrangement is proven here
        rather than new. It also works identically whichever way you tried to
        leave — the X, Escape, or clicking outside — where a bubble hung off the
        close button would have no anchor for the other two.

        Deliberately NOT marked `data-recorder-dialog`: that attribute is how
        the recorder's own Escape handler recognises its own dialog, and leaving
        it off is what lets Escape dismiss THIS one without also closing the
        recorder underneath it. */}
    <Dialog open={pendingExit !== null} onOpenChange={(next) => { if (!next) setPendingExit(null) }}>
      <DialogContent className="sm:max-w-[420px]" data-testid="rec-confirm-close">
        <DialogHeader>
          <DialogTitle>{t("audio.recordingModal.unsavedTakeTitle")}</DialogTitle>
          <DialogDescription>{t("audio.recordingModal.unsavedTakeBody")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            data-testid="rec-confirm-discard"
            onClick={() => {
              const exit = pendingExit
              setPendingExit(null)
              // Whichever way out was asked for. The index was in range when it
              // was queued, but the list can move underneath a dialog, so it is
              // read back rather than trusted.
              const next = exit?.kind === "goto" ? cells[exit.index] : null
              if (next) onActiveCellChange(next.id)
              else if (exit?.kind === "close") onClose()
            }}
          >
            {t("audio.recordingModal.discardTake")}
          </Button>
          <Button
            data-testid="rec-confirm-save"
            disabled={!online}
            onClick={() => {
              setPendingExit(null)
              // The recorder's own post-save behaviour takes it from here —
              // settling the line, and advancing or closing as the auto-advance
              // preference says. NOT forced closed on top of that: a save that
              // fails leaves the take previewable with its error, and closing
              // over it would throw away the very thing this asked to keep.
              void save()
            }}
          >
            {t("audio.recordingModal.saveTake")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}

/** Whole minutes, for the near-limit copy. The limits themselves are computed
 *  from the upload cap (recording-limits.ts) and differ per format, so the
 *  sentence that quotes them has to be computed too. */
function minutesOf(ms: number): number {
  return Math.round(ms / 60_000)
}

function formatClock(ms: number): string {
  const totalMs = Math.max(0, Math.round(ms))
  const s = Math.floor(totalMs / 1000)
  const m = Math.floor(s / 60)
  const ss = String(s % 60).padStart(2, "0")
  const tenths = Math.floor((totalMs % 1000) / 100)
  return `${m}:${ss}.${tenths}`
}
