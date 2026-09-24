// One recording, with everything you can do to it: play it, see its shape,
// read its transcript, re-record it, transcribe it, clean it up.
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

import { useCallback, useMemo, useRef } from "react"
import { Mic } from "lucide-react"

import { Button } from "@/components/ui/button"
import { CellAudioButton } from "./CellAudioButton"
import { CellWaveform } from "./CellWaveform"
import { CellTranscriptPreview } from "./CellTranscriptPreview"
import { CellTranscribeBadge } from "./CellTranscribeBadge"
import { DenoiseButton } from "./audio/DenoiseButton"
import { useCellAudio } from "@/hooks/useCellAudio"
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
  /** The row's target text — what the transcript is compared against. */
  cellText: string
  editable: boolean
  username: string
  session: FrontierSession | null
  /** Open the recorder on this take's owner. */
  onOpenRecording?: (cellId: string) => void
  /** Put the transcript into the ROW's target text (not the owner's). */
  onUseAsCellText: (transcript: string) => void
  /** Flush + revalidate after a write. Given the OWNER's id. */
  onCommitted?: (cellId: string) => void | Promise<void>
  /** A line above the controls saying which recording this is. Only linked
   *  takes need one — the row's own audio is self-evident. */
  header?: React.ReactNode
  /** Label for the re-record button; the generated-voice case says "Record
   *  over" instead. */
  recordLabel?: string
  /** Generated voice: no transcribe, no denoise, no correcting — it is not a
   *  performance anybody recorded. */
  readOnlyTranscript?: boolean
}

export function CellTakeBlock({
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
  recordLabel,
  readOnlyTranscript = false,
}: CellTakeBlockProps) {
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
  })
  const validationTakes = audioValidation.takeFor(owner, selectedAudioId)

  // The same synthetic-cell shape EditorTable already uses (and
  // CombinedBoundaryEditor / CellVoicePanel before it): useCellAudio reads only
  // these two fields, and takes the file to fetch from as its third argument.
  const cellForAudio = useMemo(
    () =>
      ({
        metadata: { attachments: owner.attachments, selectedAudioId },
      }) as unknown as CodexCell,
    [owner.attachments, selectedAudioId],
  )
  const controller = useCellAudio(project, cellForAudio, owner.fileId)

  const transcribeStatus = useTranscribeStatus(selectedAudioId)
  const isTranscribing = transcribeStatus.kind === "loading" || transcribeStatus.kind === "transcribing"

  const handleTranscribe = useCallback(async () => {
    if (!selectedAudioId) return
    // The ASR language follows the AUDIO, by provenance: an imported media
    // segment is source speech, every take voices the target text.
    const language = isSourceSegmentSelected(owner) ? project.sourceLanguage : project.targetLanguage
    await transcribeCell({ cell: owner, session, projectId: project.id, language })
    // The transcript rides a queued cell.audio.attach — flush it, then poke the
    // OWNER's file so its attachment read picks the timings up. For a linked
    // take that is the cue sibling, which is exactly the read the row's linked
    // takes are drawn from.
    await onCommitted?.(owner.id)
    notifyAudioAttachmentsChanged(owner.fileId)
  }, [owner, selectedAudioId, session, project.id, project.sourceLanguage, project.targetLanguage, onCommitted])

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
        author: username,
      }).catch((err) => {
        console.warn("[transcript] correct emit failed:", err)
      })
    },
    [owner, selectedAudioId, timings, attachment, project.id, username],
  )

  return (
    <div className="flex flex-col gap-3">
      {header}
      <div className="flex items-center gap-2">
        <CellAudioButton controller={controller} />
        <div className="flex-1">
          <CellWaveform
            controller={controller}
            height={36}
            strategy={project.audioMediaStrategy ?? "lazy"}
          />
        </div>
      </div>
      {timings && timings.length > 0 && (
        <CellTranscriptPreview
          ref={readOnlyTranscript ? undefined : transcriptPreviewRef}
          timings={timings as never}
          cellText={cellText}
          cellId={owner.id}
          alignedToCellText={tokenizeWords(cellText).length === timings.length}
          editable={editable}
          {...(readOnlyTranscript
            ? {}
            : { onRetranscribe: handleTranscribe, onCorrectTranscript: handleCorrectTranscript })}
          onUseAsCellText={onUseAsCellText}
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {validationTakes.length > 0 && (
          <AudioValidationControl
            cellRef={owner.context?.trim() || owner.id}
            takes={validationTakes}
            currentUsername={username}
            validationRequirement={audioValidation.validationRequirement}
            canValidate={audioValidation.canValidate}
            onValidationChange={audioValidation.onValidationChange}
            variant="inline"
          />
        )}
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => onOpenRecording?.(owner.id)}
          disabled={!editable || !onOpenRecording}
        >
          <Mic className="h-3 w-3" />
          {recordLabel ?? t("editor.audio.reRecordShort")}
        </Button>
        {!readOnlyTranscript && (
          <>
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={handleTranscribe}
              disabled={!editable || isTranscribing}
            >
              {isTranscribing ? t("common.transcribing") : t("editor.cell.transcribeShort")}
            </Button>
            {/* Surfaces model-download %, failures (click-to-expand with
                Retry), and a success flash. */}
            <CellTranscribeBadge
              audioId={selectedAudioId}
              hasTimings={(timings?.length ?? 0) > 0}
              onJumpToTranscript={() => transcriptPreviewRef.current?.scrollIntoView({ block: "nearest" })}
              onRetry={handleTranscribe}
            />
            {selectedAudioId && attachment && (
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
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}
