// The take that PLAYS for a line, at the top of its Recording tab (Sam,
// 2026-09-29): what it is, how it compares with the text, its shape to play
// and trim, and — only when the words differ — its transcript. The line's
// other takes are listed under it by the tab (TakesStrip, variant "tab").
// Validation is not here: the line's own audio check, just above the expanded
// cell, judges this very take.
//
// Extracted from EditorTable's Recording tab (2026-08-22, review feedback) for
// one reason: a subtitle line's takes do not necessarily live ON that line.
// In the dubbing arrangement a take hangs off the HEARD LINE that performs it —
// a cell in the hidden audio-cue sibling file — so an expanded row may need to
// show several takes owned by several different cells in another file. Hooks
// cannot be called in a loop, so each take needs its own component instance;
// that is what this is.
//
// THE OWNER IS THE WHOLE POINT. Every read and every write here is scoped to
// `owner` — the cell that actually holds the take — never to the row the block
// happens to be rendered in. `useCellAudio` takes an explicit `fileId` (used
// only for the R2 read), and `transcribeCell` / `emitCellAudioAttach` take the
// owner's own `fileId`/`id`, so pointing this at a cue in the sibling file
// lands every effect on that cue. The single deliberate exception is
// `onUseAsCellText`, which fills the ROW's target text — that is the text
// surface the reader is looking at.

import { useCallback, useMemo, useRef, useState } from "react"
import { CopyPlus, FileClock, Mic, Pencil, Sparkles, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { TakeTextVerdict } from "./audio/TakeTextVerdict"
import { transcriptVerdict } from "@/lib/audio/transcript-verdict"
import type { RecordingTextDrift } from "@/lib/audio/text-drift"
import { TakeWaveform } from "./audio/TakeWaveform"
import { TakeTimeReadout } from "./audio/TakeTimeReadout"
import { CellTranscriptPreview } from "./CellTranscriptPreview"
import { CellTranscribeBadge } from "./CellTranscribeBadge"
import { DenoiseButton } from "./audio/DenoiseButton"
import { useCellAudio, type UseCellAudioResult } from "@/hooks/useCellAudio"
import { keptWindowSec, piecesWindowSec, type KeptWindow } from "@/lib/audio/kept-window"
import { takeTrackVars } from "@/lib/timeline/take-colors"
import { persistTakeTrim, trimMs } from "@/lib/audio/persist-trim"
import { useTranscribeStatus } from "@/lib/audio/transcribe-status"
import { transcribeCell } from "@/lib/audio/transcribe"
import { isSourceSegmentSelected } from "@/lib/audio/batch-audio"
import { laneLanguageForTag } from "@/lib/lanes/lane-language"
import { laneLanguage } from "@/lib/lanes/lane-display"
import { saveTranscript } from "@/lib/transcript-cleanup/save"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { tokenizeWords } from "@/lib/audio/timings"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { fmtShortCalendarDate } from "@/lib/format-date"
import { DateTooltip } from "@/components/ui/date-tooltip"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CodexCell, WordTiming } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { AudioValidationControl } from "./cell/AudioValidationControl"
import { useAudioValidation } from "@/hooks/useAudioValidation"
import { hasOwnRecordingLeft, removeTake, removeWholeTake, renameTake, renameWholeTake } from "@/lib/audio/take-actions"
import { takeBaseLabel } from "@/lib/audio/take-groups"
import { pieceGroupOf, type AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { TakesStrip } from "@/components/AudioRecorder/TakesStrip"
import { attachmentOutFrom } from "@/lib/audio/cut-take"
import { GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"
import { formatTakeSeconds, takePlayedMs } from "@/lib/audio/take-length"
import { useInRouterContext, useNavigate } from "react-router-dom"
import { CloneFromTakeButton } from "@/components/cell/CloneFromTakeButton"

export interface CellTakeBlockProps {
  project: ProjectRecord
  /**
   * The cell that HOLDS this recording — the row's own cell for its own audio,
   * or a linked audio cue for a heard line's take. Its `fileId` is where every
   * write goes, so it must be the cue sibling's id for a linked take (cells
   * from `useAudioCueCells` already carry it).
   */
  owner: CellData
  /** Which of the owner's attachments to sound. Defaults to its recorded
   *  selection; the generated-voice block passes its own. */
  audioId?: string | null
  /** Word timings for that attachment, when it has been transcribed. */
  timings?: readonly unknown[] | null
  /**
   * The words this take should say — what its transcript is compared with:
   * the row's text for its own take, the text of every line a heard line
   * performs for that heard line's. Null when nothing can say which words it
   * should say (a heard line saying one part of a split line).
   */
  cellText: string | null
  editable: boolean
  username: string
  session: FrontierSession | null
  /** Open the recorder on this take's owner, recording onto `slot`. */
  onOpenRecording?: (cellId: string, slot?: string) => void
  /** Put the transcript into the ROW's target text (not the owner's). Absent
   *  where the take does not say exactly the row's text (a heard line shared
   *  with other lines, or one part of a split line). */
  onUseAsCellText?: (transcript: string) => void
  /** Flush + revalidate after a write. Given the OWNER's id. */
  onCommitted?: (cellId: string) => void | Promise<void>
  /** A line above the take saying where it lives. Only a heard line's take
   *  needs one — the row's own audio is self-evident. */
  header?: React.ReactNode
  /** Generated voice: no transcribe, no denoise, no correcting — it is not a
   *  performance anybody recorded. */
  readOnlyTranscript?: boolean
  /**
   * Play this recording on the row's existing player. The cell highlight reads
   * that player's clock; a second player here would sound the take without
   * ever moving the highlight. Omit for a linked take the row does not play.
   */
  controller?: UseCellAudioResult
  /** AQU-1462: lane the member is working in. Omitted for the default lane. */
  targetLang?: string
  /** When and by whom the take was made, and whether the text has changed
   *  since — read once by the tab for all of a line's takes. */
  provenance?: RecordingTextDrift | null
  /** The owner's last RECORDING was deleted here — the workspace resets the
   *  target row it justified, as it does for a delete in the recorder. */
  onLastTakeRemoved?: (cellId: string) => void
  /**
   * The file whose timeline this take is on, for its track's colour. The
   * owner's own file, except for a heard line's take: that lives in the
   * hidden audio-cue sibling while its tracks are the subtitle file's.
   */
  trackFileId?: string
  /**
   * The track this take sits on, named before the take's own name — given
   * when the line has takes on more than one track, where every track's first
   * take is a "Take 1" (Sam, 2026-09-30).
   */
  trackName?: string | null
  /**
   * AQU-1767 (Sam, 2026-10-14): the take that plays was SPLIT — its live
   * pieces, in clip order. It shows as one take ("Take 1 · split in 2"): one
   * waveform with the pieces lit and the cuts marked, Transcribe and Remove
   * noise on the whole take, delete removing every piece, the approval
   * covering every piece, and a row per piece under it (play, approve, rename,
   * delete). Absent, or one piece: a take as before.
   */
  pieces?: readonly AudioAttachmentOut[]
  /** The line's take history, already read by the tab — for the piece rows. */
  takesHistory?: ReadonlyMap<string, RecordingTextDrift>
  /**
   * AQU-1758: "Make a character from this voice" — opens the New voice
   * dialog, cloning, seeded with this take's line. Absent hides it.
   */
  onMakeCharacter?: () => void
  /**
   * AQU-1758 / AQU-2212: …in one step — name it, Add to cast — with
   * `onMakeCharacter` as its More options (CloneFromTakeButton).
   */
  onCloneTake?: (name: string) => Promise<void>
  /** The name that clone suggests (who recorded the take). */
  cloneSuggestedName?: string
}

type BadgeProps = React.ComponentProps<typeof CellTranscribeBadge>

/** The transcription badge, plus "Change model" (Preferences → Local models)
 *  when a router is mounted to navigate with. Some isolated renders of this
 *  block have no router; they get the badge without that action. */
function TranscribeBadge({ routed, projectId, ...badge }: BadgeProps & { routed: boolean; projectId: string }) {
  return routed
    ? <RoutedTranscribeBadge projectId={projectId} {...badge} />
    : <CellTranscribeBadge {...badge} />
}

function RoutedTranscribeBadge({ projectId, ...badge }: BadgeProps & { projectId: string }) {
  const navigate = useNavigate()
  return (
    <CellTranscribeBadge
      {...badge}
      onChangeModel={() => navigate(`/preferences/local-models?project=${encodeURIComponent(projectId)}`)}
    />
  )
}

export function CellTakeBlock(props: CellTakeBlockProps) {
  if (props.controller) return <CellTakeBlockView {...props} controller={props.controller} />
  return <CellTakeBlockOwned {...props} />
}

function CellTakeBlockOwned(props: Omit<CellTakeBlockProps, "controller">) {
  const selectedAudioId = props.audioId ?? props.owner.selectedAudioId ?? undefined
  const cellForAudio = useMemo(
    () =>
      ({
        metadata: { attachments: props.owner.attachments, selectedAudioId },
      }) as unknown as CodexCell,
    [props.owner.attachments, selectedAudioId],
  )
  const controller = useCellAudio(props.project, cellForAudio, props.owner.fileId)
  return <CellTakeBlockView {...props} controller={controller} />
}

function CellTakeBlockView({
  project,
  owner,
  audioId,
  timings,
  cellText,
  editable,
  username,
  session,
  onOpenRecording,
  onUseAsCellText,
  onCommitted,
  header,
  readOnlyTranscript = false,
  controller,
  targetLang,
  provenance = null,
  onLastTakeRemoved,
  trackName = null,
  trackFileId,
  pieces,
  takesHistory,
  onMakeCharacter,
  onCloneTake,
  cloneSuggestedName,
}: CellTakeBlockProps & { controller: UseCellAudioResult }) {
  const { t, locale } = useI18n()
  const transcriptPreviewRef = useRef<HTMLDivElement | null>(null)

  const selectedAudioId = audioId ?? owner.selectedAudioId ?? undefined
  const attachment = selectedAudioId ? owner.attachments?.[selectedAudioId] : undefined
  // AQU-490. This block shows ONE take, so the control gets one — but built
  // through the same adapter the gutter uses, so the project's role floor,
  // allowlist and self-validation rule all apply identically here.
  const audioValidation = useAudioValidation({
    project,
    fileId: owner.fileId,
    cellId: owner.id,
    username,
    onCommitted,
    jwt: session?.jwt ?? null,
    ...(targetLang ? { targetLang } : {}),
    surface: "recording-tab",
  })
  const split = pieces && pieces.length > 1 ? pieces : null
  // A split take is approved as a whole from here: one press, every piece.
  const validationTakes = split
    ? split.flatMap((piece) => audioValidation.takeFor(owner, piece.audioId))
    : audioValidation.takeFor(owner, selectedAudioId)

  // AQU-1217: the part of the clip that plays for this line — the take's
  // stored trim, or, for an imported source-audio section, the section itself.
  // TakeWaveform applies it to the player; this block used to play the whole
  // file (an untrimmed take, and on a source section the entire reading).
  const piecesWindow = useMemo(() => (split ? piecesWindowSec(split) : null), [split])
  // A cleaned split take's original, for Revert to paint at once.
  const originalId = split?.[0]?.referenceAudioId ?? null
  const originalAtt = originalId ? owner.attachments?.[originalId] : undefined
  const originalTake = originalId && originalAtt && split
    ? attachmentOutFrom(originalId, originalAtt, originalAtt.slot ?? split[0].slot)
    : null
  const kept: KeptWindow = piecesWindow
    ? { start: piecesWindow.start, end: piecesWindow.end, kind: "trim" }
    : keptWindowSec(owner, selectedAudioId, attachment)
  const isGenerated = Boolean(selectedAudioId && selectedAudioId === owner.selectedGeneratedVoiceAudioId)
  // Trimmed where it is shown (Sam, 2026-09-25): the edit lands on the cell
  // that HOLDS the take — a linked heard-line take writes to its cue.
  const commitTrim = useCallback((start: number | null, end: number | null) => {
    if (!selectedAudioId || !attachment) return
    void persistTakeTrim({
      projectId: project.id,
      fileId: owner.fileId,
      cellId: owner.id,
      audioId: selectedAudioId,
      att: attachment,
      selectedAudioId: owner.selectedAudioId,
      trimStartMs: trimMs(start),
      trimEndMs: trimMs(end),
      ...(targetLang ? { targetLang } : {}),
      author: username,
    })
  }, [selectedAudioId, attachment, project.id, owner.fileId, owner.id, owner.selectedAudioId, username, targetLang])

  const inRouter = useInRouterContext()
  const transcribeStatus = useTranscribeStatus(selectedAudioId)
  const isTranscribing = transcribeStatus.kind === "loading" || transcribeStatus.kind === "transcribing"

  const handleTranscribe = useCallback(async () => {
    if (!selectedAudioId) return
    // The ASR language follows the AUDIO, by provenance: an imported media
    // segment is source speech, every take voices the target text.
    const sourceLane = project.lanes?.find((lane) => lane.role === "source")
    const language = isSourceSegmentSelected(owner)
      ? laneLanguage(sourceLane ?? { role: "source" }, {
          role: "source",
          legacyTag: sourceLane?.legacyTag ?? null,
        })
      : laneLanguageForTag(targetLang ?? "", project.lanes) ?? undefined
    // THIS take, on its own slot: the transcriber reads the cell's selected
    // recording, which for a take on an added track is a different take —
    // that block used to transcribe the default track's recording instead.
    await transcribeCell({
      cell: { ...owner, selectedAudioId },
      slot: attachment?.slot,
      session,
      projectId: project.id,
      language,
      // AQU-1978: the timings are written in this lane, never the `''` one.
      ...(targetLang ? { targetLang } : {}),
      askAgain: true,
      // A split take is transcribed whole (Sam, 2026-10-14).
      ...(split ? { pieces: split } : {}),
    })
    // The transcript rides a queued cell.audio.attach — flush it, then poke the
    // OWNER's file so its attachment read picks the timings up. For a linked
    // take that is the cue sibling, which is exactly the read the row's linked
    // takes are drawn from.
    await onCommitted?.(owner.id)
    notifyAudioAttachmentsChanged(owner.fileId)
  }, [owner, selectedAudioId, attachment?.slot, session, project, targetLang, onCommitted, split])

  // Deletable even when it is the line's only take (Sam, 2026-09-29) — the
  // same removal as the takes lists. Nothing is chosen in its place: the line
  // plays its generated voice if it has one, and otherwise says no take plays.
  const [deleting, setDeleting] = useState(false)
  // Only the player's play/pause state and its pause, not the whole player:
  // the player is a new object on every frame of playback.
  const { isPlaying: takePlaying, pause: pauseTake } = controller
  const handleDelete = useCallback(async () => {
    if (!selectedAudioId || !attachment) return
    setDeleting(true)
    const slot = attachment.slot ?? (selectedAudioId === owner.selectedGeneratedVoiceAudioId ? GENERATED_VOICE_SLOT : RECORDING_SLOT)
    const lane = targetLang ? { targetLang } : {}
    const removal = { projectId: project.id, fileId: owner.fileId, cellId: owner.id, audioId: selectedAudioId, slot, ...lane, author: username, history: { wasSelected: true } }
    // A split take goes whole, every piece in one step (Sam, 2026-10-14).
    const removing = split ? split.map((piece) => ({ audioId: piece.audioId, slot: piece.slot ?? slot })) : null
    const remove = removing
      ? () => removeWholeTake({ ...removal, pieces: removing })
      : () => removeTake(removal)
    if (takePlaying) pauseTake()
    // THE TRY HOLDS THE AWAIT AND NOTHING ELSE, deliberately: the React
    // Compiler cannot compile a try/finally, or a conditional inside a try,
    // and skips the WHOLE component for either — which left this block
    // re-rendering all its tooltips and popovers on every frame of playback
    // (2026-09-30). The catch swallows everything, so the lines after it run
    // whatever happens, as a finally would.
    let removed = false
    try {
      await remove()
      removed = true
    } catch {
      // The remove overlay drops itself and refetches; the take comes back.
    }
    setDeleting(false)
    if (!removed) return
    const gone = new Set(removing?.map((r) => r.audioId) ?? [selectedAudioId])
    const takes = Object.entries(owner.attachments ?? {}).map(([audioId, a]) => ({
      audioId, voiceId: a.voiceId ?? null, isDeleted: a.isDeleted || (gone.has(audioId) && audioId !== selectedAudioId),
    }))
    if (!hasOwnRecordingLeft(takes, selectedAudioId, owner.id)) onLastTakeRemoved?.(owner.id)
  }, [selectedAudioId, attachment, takePlaying, pauseTake, project.id, owner, username, onLastTakeRemoved, targetLang, split])

  // Renameable in place, as every take in the lists is (Sam, 2026-09-29).
  // The new name shows at once, for as long as the take still carries the
  // name it replaced — a rename made elsewhere meanwhile is never hidden.
  const [renaming, setRenaming] = useState(false)
  const [renameDraft, setRenameDraft] = useState("")
  // Escape closes the box, and a closing box loses focus — whose handler
  // would then save what Escape meant to throw away.
  const renameCancelledRef = useRef(false)
  const [renamed, setRenamed] = useState<{ audioId: string; from: string | null; to: string } | null>(null)
  const storedLabel = attachment?.label ?? null
  const shownLabel =
    renamed && renamed.audioId === selectedAudioId && renamed.from === storedLabel ? renamed.to : storedLabel
  const commitRename = useCallback(async () => {
    setRenaming(false)
    if (renameCancelledRef.current) { renameCancelledRef.current = false; return }
    const label = renameDraft.trim()
    // Against the name as SHOWN: an unnamed take shows "Take", and saving
    // that unchanged would turn the placeholder into a real name. A split
    // take is shown, and renamed, by its own name (AQU-1767, Sam 2026-10-15).
    const shownName = (split ? takeBaseLabel(shownLabel) : shownLabel) ?? t("audio.takesStrip.takeFallback")
    if (!selectedAudioId || !label || label === shownName) return
    setRenamed({ audioId: selectedAudioId, from: storedLabel, to: label })
    // Worked out before the try: a conditional inside one makes the React
    // Compiler skip the whole component (see handleDelete).
    const lane = targetLang ? { targetLang } : {}
    const where = { projectId: project.id, fileId: owner.fileId, cellId: owner.id, author: username, ...lane }
    const save = split
      ? () => renameWholeTake({ ...where, pieces: split, name: label })
      : () => renameTake({ ...where, audioId: selectedAudioId, label, labelBefore: storedLabel })
    try {
      await save()
    } catch {
      setRenamed(null)
    }
  }, [renameDraft, selectedAudioId, shownLabel, storedLabel, split, project.id, owner.fileId, owner.id, username, t, targetLang])

  const handleCorrectTranscript = useCallback(
    (corrected: string) => {
      if (!selectedAudioId || !timings || timings.length === 0 || !attachment) return
      // AQU-463 learning, the timing remap and the attach live in
      // saveTranscript, shared with the Transcribe lens.
      saveTranscript({
        projectId: project.id,
        owner,
        audioId: selectedAudioId,
        attachment,
        timings: timings as WordTiming[],
        text: corrected,
        ...(targetLang ? { targetLang } : {}),
        author: username,
      }).catch((err) => {
        console.warn("[transcript] correct emit failed:", err)
      })
    },
    [owner, selectedAudioId, timings, attachment, project.id, username, targetLang],
  )

  const isSection = kept.kind === "section"
  // The words heard against the words written. A source section speaks the
  // SOURCE language, so comparing it with the target text says nothing; its
  // transcript card shows as it always has.
  const verdict = transcriptVerdict({ timings: timings as never, cellText })
  const showVerdict = !isSection && !readOnlyTranscript
  const showTranscript = Boolean(timings && timings.length > 0) && (isSection || verdict.kind !== "match")
  const label = isSection
    ? t("editor.recordingTab.sourceSection")
    : (split ? takeBaseLabel(shownLabel) : shownLabel) ?? t("audio.takesStrip.takeFallback")
  // The length that PLAYS (AQU-1217: a trimmed take shows its trimmed
  // length) — the head said the whole file's while the timer under it said
  // the kept part's.
  const keptMs = takePlayedMs(split ?? (attachment ? [attachment] : []))
  const trackVars = takeTrackVars({
    files: project.files,
    fileId: trackFileId ?? owner.fileId,
    slot: attachment?.slot,
    sourceSection: isSection,
  })
  // New take records onto THIS take's track (a generated voice's is the main
  // track, whose recordings share its row). It opened the recorder on the main
  // track whichever take it sat beside.
  const newTakeSlot = !attachment?.slot || attachment.slot === GENERATED_VOICE_SLOT ? RECORDING_SLOT : attachment.slot

  return (
    <div data-testid="cell-take-block" className="flex flex-col gap-2">
      {header}
      <div data-testid="cell-take-head" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        {trackName && !isSection && (
          <span data-testid="cell-take-track" className="flex items-center gap-1.5 font-medium">
            <span aria-hidden className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: trackVars["--tl-track-hue"] }} />
            {trackName}
            <span aria-hidden className="font-normal text-muted-foreground">·</span>
          </span>
        )}
        {isGenerated && <Sparkles className="h-3 w-3 shrink-0 text-violet-600 dark:text-violet-400" />}
        {renaming ? (
          <input
            autoFocus
            data-testid="cell-take-rename"
            aria-label={t("audio.takesStrip.renameTooltip")}
            value={renameDraft}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); void commitRename() }
              else if (e.key === "Escape") { e.preventDefault(); renameCancelledRef.current = true; setRenaming(false) }
            }}
            className="w-40 min-w-0 rounded border border-border bg-background px-1 py-0.5 text-xs font-medium"
          />
        ) : (
          <span data-testid="cell-take-label" className="font-medium">{label}</span>
        )}
        {split && (
          <span data-testid="cell-take-split" className="text-muted-foreground">
            · {t("editor.recordingTab.splitInto", { count: split.length })}
          </span>
        )}
        {!isSection && keptMs != null && (
          <span data-testid="cell-take-length" className="tabular-nums text-muted-foreground">{formatTakeSeconds(keptMs)}s</span>
        )}
        {provenance && (
          <span
            data-testid="cell-take-recorded"
            className="inline-flex min-w-0 items-center text-[11px] text-muted-foreground"
          >
            <DateTooltip
              value={provenance.recordedAt}
              label={t(isGenerated ? "audio.takesStrip.generatedLabel" : "audio.takesStrip.recordedLabel")}
            >
              {t("audio.takesStrip.recordedByBadge", {
                date: fmtShortCalendarDate(provenance.recordedAt, undefined, locale),
                author: provenance.recordedBy,
              })}
            </DateTooltip>
          </span>
        )}
        {/* Not when its transcript matches the line as it reads now: the
            recording says the current text, however the text got there
            (Sam, 2026-10-15 — using a transcript AS the text flagged its own
            take). */}
        {!isGenerated && provenance?.drifted && !(showVerdict && verdict.kind === "match") && (
          <span
            title={t("audio.takesStrip.textDriftTooltip", {
              date: new Date(provenance.recordedAt).toLocaleDateString(),
              text: provenance.textAtRecording ?? "",
            })}
            className="flex items-center gap-0.5 rounded px-1 text-[10px] text-amber-700 dark:text-amber-400"
          >
            <FileClock className="h-3 w-3" /> {t("audio.takesStrip.textDriftBadge")}
          </span>
        )}
        {showVerdict && (
          <TakeTextVerdict
            verdict={verdict}
            onTranscribe={editable ? handleTranscribe : undefined}
            transcribeDisabled={isTranscribing}
            testId="cell-take-verdict"
          />
        )}
        {/* A split take is renamed whole, here; its pieces follow, numbered. */}
        {!isSection && selectedAudioId && !renaming && (
          <AppTooltip content={t("audio.takesStrip.renameTooltip")}>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="cell-take-rename-button"
              aria-label={t("audio.takesStrip.renameTooltip")}
              disabled={!editable}
              onClick={() => { renameCancelledRef.current = false; setRenameDraft(label); setRenaming(true) }}
              className="rounded-md text-muted-foreground/40 hover:bg-background hover:text-foreground"
            >
              <Pencil className="h-3 w-3" />
            </Button>
          </AppTooltip>
        )}
        {!readOnlyTranscript && (
          // Model download %, failures (click to expand, with Retry) and a
          // success flash — the only place a transcription reports itself.
          <TranscribeBadge
            routed={inRouter}
            projectId={project.id}
            audioId={selectedAudioId}
            hasTimings={(timings?.length ?? 0) > 0}
            onJumpToTranscript={() => transcriptPreviewRef.current?.scrollIntoView({ block: "nearest" })}
            onRetry={handleTranscribe}
          />
        )}
        {/* Its validation, in its own line (Sam, 2026-09-29), beside what
            else is said about the take — and the vote (Sam, 2026-09-30).
            This is the take that PLAYS, heard right here, so it can be
            validated here as from the line's audio check; the takes listed
            under it show theirs read-only. */}
        {validationTakes.length > 0 && (
          <span data-testid="cell-take-validation" className="flex items-center">
            <AudioValidationControl
              cellRef={owner.context?.trim() || owner.id}
              takes={validationTakes}
              currentUsername={username}
              validationRequirement={audioValidation.validationRequirement}
              canValidate={audioValidation.canValidate}
              onValidationChange={audioValidation.onValidationChange}
              variant="inline"
            />
          </span>
        )}
        <span className="ms-auto flex items-center gap-1.5">
          {!readOnlyTranscript && !isSection && selectedAudioId && attachment && (
            <DenoiseButton
              projectId={project.id}
              fileId={owner.fileId}
              cellId={owner.id}
              // A split take reads as cleaned by its group: the first piece of
              // a cleaned take may have been deleted since.
              selectedAudioId={split ? pieceGroupOf(split[0], split[0].audioId) : selectedAudioId}
              pieces={split ?? undefined}
              originalTake={originalTake}
              selectedUrl={attachment.url}
              referenceAudioId={attachment.referenceAudioId ?? null}
              originalUrl={
                attachment.referenceAudioId
                  ? owner.attachments?.[attachment.referenceAudioId]?.url ?? null
                  : null
              }
              originalDurationMs={
                attachment.referenceAudioId
                  ? owner.attachments?.[attachment.referenceAudioId]?.durationMs ?? null
                  : null
              }
              author={username}
              session={session}
              editable={editable}
              targetLang={targetLang}
            />
          )}
          {/* AQU-1758: the Audio view's voice card turned a take into a
              character; this take does now (the timeline's take menu too),
              in one step where it can (AQU-2212), the dialog under More
              options. */}
          {!isSection && selectedAudioId && attachment && onMakeCharacter && onCloneTake && editable && (
            <CloneFromTakeButton
              suggestedName={cloneSuggestedName}
              onClone={onCloneTake}
              onMoreOptions={onMakeCharacter}
            />
          )}
          {!isSection && selectedAudioId && attachment && onMakeCharacter && !(onCloneTake && editable) && (
            <AppTooltip content={t("editor.timeline.takeMenuMakeCharacter")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="cell-take-make-character"
                aria-label={t("editor.timeline.takeMenuMakeCharacter")}
                disabled={!editable}
                onClick={onMakeCharacter}
                className="rounded-md text-muted-foreground/60 hover:bg-background hover:text-foreground"
              >
                <CopyPlus className="h-3.5 w-3.5" />
              </Button>
            </AppTooltip>
          )}
          {/* The one way into the recorder from here: it records, uploads
              and generates, and switches takes too. */}
          <AppTooltip content={t("editor.recordingTab.newTakeTooltip")}>
            <Button
              type="button"
              size="xs"
              variant="outline"
              data-testid="cell-take-new"
              onClick={() => onOpenRecording?.(owner.id, newTakeSlot)}
              disabled={!editable || !onOpenRecording}
            >
              <Mic className="h-3 w-3" />
              {t("editor.recordingTab.newTake")}
            </Button>
          </AppTooltip>
          {!isSection && selectedAudioId && attachment && (
            <AppTooltip content={t("audio.takesStrip.deleteTakeTooltip")}>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-testid="cell-take-delete"
                aria-label={t("audio.takesStrip.deleteTakeTooltip")}
                onClick={() => void handleDelete()}
                disabled={!editable || deleting}
                className="rounded-md text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AppTooltip>
          )}
        </span>
      </div>
      {/* The take, drawn as its timeline chip (AQU-1217). Play from its
          corner; trim right here. No mic on it: New take, above, is the way
          into the recorder. */}
      <TakeWaveform
        controller={controller}
        audioId={selectedAudioId}
        kept={kept}
        height={56}
        // In its track's colour (Sam, 2026-09-26): a source section in the
        // source row's lighter blue, a take in its own track's.
        kind={isGenerated || isSection ? "generated" : "take"}
        trackVars={trackVars}
        strategy={project.audioMediaStrategy ?? "lazy"}
        {...(piecesWindow ? { pieces: piecesWindow } : {})}
        trimEditable={editable && !split}
        onCommitTrim={commitTrim}
        testId="cell-take-waveform"
      >
        {/* The running time, as on the Audio view card (Sam, 2026-09-29). */}
        <span className="pointer-events-none absolute bottom-1 left-2 z-10 flex items-center gap-1">
          <TakeTimeReadout
            currentTime={controller.currentTime}
            duration={controller.duration}
            kept={kept}
            testId="cell-take-time"
          />
        </span>
      </TakeWaveform>
      {split && (
        // A row per piece (Sam, 2026-10-14): play it, approve it, rename it,
        // delete it.
        <TakesStrip
          variant="pieces"
          projectId={project.id}
          project={project}
          fileId={owner.fileId}
          trackFileId={trackFileId ?? owner.fileId}
          cellId={owner.id}
          takes={[...split]}
          selectedAudioId={selectedAudioId ?? null}
          author={username}
          session={session}
          targetLang={targetLang}
          history={takesHistory}
          onLastTakeRemoved={onLastTakeRemoved}
          readOnly={!editable}
        />
      )}
      {showTranscript && timings && (
        <CellTranscriptPreview
          ref={readOnlyTranscript ? undefined : transcriptPreviewRef}
          timings={timings as never}
          cellText={cellText ?? ""}
          cellId={owner.id}
          alignedToCellText={cellText != null && tokenizeWords(cellText).length === timings.length}
          editable={editable}
          {...(readOnlyTranscript
            ? {}
            : { onRetranscribe: handleTranscribe, onCorrectTranscript: handleCorrectTranscript })}
          onUseAsCellText={onUseAsCellText}
        />
      )}
    </div>
  )
}
