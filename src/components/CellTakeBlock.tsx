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
import { FileClock, Mic, Pencil, Sparkles, Trash2 } from "lucide-react"

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
import { keptWindowSec } from "@/lib/audio/kept-window"
import { takeTrackVars } from "@/lib/timeline/take-colors"
import { persistTakeTrim, trimMs } from "@/lib/audio/persist-trim"
import { useTranscribeStatus } from "@/lib/audio/transcribe-status"
import { transcribeCell } from "@/lib/audio/transcribe"
import { isSourceSegmentSelected } from "@/lib/audio/batch-audio"
import { remapTranscriptTimings } from "@/lib/audio/correct-transcript"
import { learnFromTranscriptCorrection } from "@/lib/store/transcript-corrections-store"
import { emitCellAudioAttach } from "@/lib/sync/events-emit"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { tokenizeWords } from "@/lib/audio/timings"
import { useT } from "@/lib/i18n/I18nProvider"
import type { CellData } from "@/hooks/useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { FrontierSession } from "@/lib/frontier/types"
import { AudioValidationControl } from "./cell/AudioValidationControl"
import { useAudioValidation } from "@/hooks/useAudioValidation"
import { hasOwnRecordingLeft, removeTake, renameTake } from "@/lib/audio/take-actions"
import { GENERATED_VOICE_SLOT, RECORDING_SLOT } from "@/lib/timeline/track-slots"
import { effectiveAttachmentDurationMs } from "@/lib/timeline/lane-timing"

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
}: CellTakeBlockProps & { controller: UseCellAudioResult }) {
  const t = useT()
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
  })
  const validationTakes = audioValidation.takeFor(owner, selectedAudioId)

  // AQU-1217: the part of the clip that plays for this line — the take's
  // stored trim, or, for an imported source-audio section, the section itself.
  // TakeWaveform applies it to the player; this block used to play the whole
  // file (an untrimmed take, and on a source section the entire reading).
  const kept = keptWindowSec(owner, selectedAudioId, attachment)
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

  const transcribeStatus = useTranscribeStatus(selectedAudioId)
  const isTranscribing = transcribeStatus.kind === "loading" || transcribeStatus.kind === "transcribing"

  const handleTranscribe = useCallback(async () => {
    if (!selectedAudioId) return
    // The ASR language follows the AUDIO, by provenance: an imported media
    // segment is source speech, every take voices the target text.
    const language = isSourceSegmentSelected(owner) ? project.sourceLanguage : project.targetLanguage
    // THIS take, on its own slot: the transcriber reads the cell's selected
    // recording, which for a take on an added track is a different take —
    // that block used to transcribe the default track's recording instead.
    await transcribeCell({
      cell: { ...owner, selectedAudioId },
      slot: attachment?.slot,
      session,
      projectId: project.id,
      language,
      askAgain: true,
    })
    // The transcript rides a queued cell.audio.attach — flush it, then poke the
    // OWNER's file so its attachment read picks the timings up. For a linked
    // take that is the cue sibling, which is exactly the read the row's linked
    // takes are drawn from.
    await onCommitted?.(owner.id)
    notifyAudioAttachmentsChanged(owner.fileId)
  }, [owner, selectedAudioId, attachment?.slot, session, project.id, project.sourceLanguage, project.targetLanguage, onCommitted])

  // Deletable even when it is the line's only take (Sam, 2026-09-29) — the
  // same removal as the takes lists. Nothing is chosen in its place: the line
  // plays its generated voice if it has one, and otherwise says no take plays.
  const [deleting, setDeleting] = useState(false)
  const handleDelete = useCallback(async () => {
    if (!selectedAudioId || !attachment) return
    setDeleting(true)
    try {
      if (controller.isPlaying) controller.pause()
      await removeTake({
        projectId: project.id,
        fileId: owner.fileId,
        cellId: owner.id,
        audioId: selectedAudioId,
        slot: attachment.slot ?? (selectedAudioId === owner.selectedGeneratedVoiceAudioId ? GENERATED_VOICE_SLOT : RECORDING_SLOT),
        ...(targetLang ? { targetLang } : {}),
        author: username,
      })
      const takes = Object.entries(owner.attachments ?? {}).map(([audioId, a]) => ({
        audioId, voiceId: a.voiceId ?? null, isDeleted: a.isDeleted,
      }))
      if (!hasOwnRecordingLeft(takes, selectedAudioId, owner.id)) onLastTakeRemoved?.(owner.id)
    } catch {
      // The remove overlay drops itself and refetches; the take comes back.
    } finally {
      setDeleting(false)
    }
  }, [selectedAudioId, attachment, controller, project.id, owner, username, onLastTakeRemoved, targetLang])

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
    // that unchanged would turn the placeholder into a real name.
    if (!selectedAudioId || !label || label === (shownLabel ?? t("audio.takesStrip.takeFallback"))) return
    setRenamed({ audioId: selectedAudioId, from: storedLabel, to: label })
    try {
      await renameTake({
        projectId: project.id, fileId: owner.fileId, cellId: owner.id, audioId: selectedAudioId, label, author: username,
        ...(targetLang ? { targetLang } : {}),
      })
    } catch {
      setRenamed(null)
    }
  }, [renameDraft, selectedAudioId, shownLabel, storedLabel, project.id, owner.fileId, owner.id, username, t, targetLang])

  const handleCorrectTranscript = useCallback(
    (corrected: string) => {
      if (!selectedAudioId || !timings || timings.length === 0) return
      const nextTimings = remapTranscriptTimings(timings as never, corrected)
      if (nextTimings.length === 0) return
      if (!attachment?.url) return

      // AQU-463: the same edit that fixes THIS transcript teaches the project
      // how ASR gets that word wrong, so the next transcription arrives already
      // fixed. Learning is best-effort and deliberately non-blocking — the
      // user's correction is committed below whatever happens here.
      try {
        const before = (timings as ReadonlyArray<{ word: string }>).map((t) => t.word).join(" ")
        learnFromTranscriptCorrection(project.id, before, corrected)
      } catch (err) {
        console.warn("[transcript] learning from correction failed:", err)
      }
      void emitCellAudioAttach({
        projectId: project.id,
        fileId: owner.fileId,
        cellId: owner.id,
        audioId: selectedAudioId,
        url: attachment.url,
        // AQU-646: the clip's own slot, inferred only when it is absent (a
        // hand-built stub). This attach assigns `slot` outright and deselects
        // the clip's siblings in that slot, so guessing it moves the take.
        slot: attachment.slot ?? (selectedAudioId === owner.selectedGeneratedVoiceAudioId ? "generatedVoice" : "recording"),
        timings: nextTimings,
        ...(attachment.durationMs != null ? { durationMs: attachment.durationMs } : {}),
        ...(attachment.voiceId ? { voiceId: attachment.voiceId } : {}),
        ...(attachment.referenceAudioId ? { referenceAudioId: attachment.referenceAudioId } : {}),
        ...(isSourceSegmentSelected(owner) ? { transcription: corrected } : {}),
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
    : shownLabel ?? t("audio.takesStrip.takeFallback")
  // The length that PLAYS (AQU-1217: a trimmed take shows its trimmed
  // length) — the head said the whole file's while the timer under it said
  // the kept part's.
  const keptMs = effectiveAttachmentDurationMs(attachment)
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
        {!isSection && keptMs != null && (
          <span data-testid="cell-take-length" className="tabular-nums text-muted-foreground">{(keptMs / 1000).toFixed(1)}s</span>
        )}
        {provenance && (
          <span
            data-testid="cell-take-recorded"
            title={t(isGenerated ? "audio.takesStrip.generatedByTooltip" : "audio.takesStrip.recordedByTooltip", {
              datetime: new Date(provenance.recordedAt).toLocaleString(),
              author: provenance.recordedBy,
            })}
            className="text-[11px] text-muted-foreground"
          >
            {t("audio.takesStrip.recordedByBadge", {
              date: new Date(provenance.recordedAt).toLocaleDateString(),
              author: provenance.recordedBy,
            })}
          </span>
        )}
        {!isGenerated && provenance?.drifted && (
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
          <CellTranscribeBadge
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
              selectedAudioId={selectedAudioId}
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
        trimEditable={editable}
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
