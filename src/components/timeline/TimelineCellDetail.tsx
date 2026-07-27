// Bottom detail pane for the selected timeline clip. Source (read, plus a play
// control when the clip's source is audio) and an editable target that reaches
// parity with the main cell editor by mounting the SHARED `TranslatedEditor`
// rather than a stripped-down textarea (AQU-659). Reusing the editor gives the
// media pane rich text, footnotes, terminology chips, and violation blots for
// free, and its commits persist identically to the main table.
//
// AQU-646 round 3: the target card carries the text view's cell actions
// (AI translate, regenerate, record/upload audio, play generated voice,
// footnote, comments, history) via the optional `detailActions` bundle — when
// absent the pane renders exactly as before (read-only surfaces, tests).

import { useRef, useState } from "react"
import {
  History as HistoryIcon,
  Loader2,
  MessageCircle,
  Mic,
  NotebookPen,
  RefreshCw,
  Sparkles,
  VolumeX,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { fmtClock } from "./format"
import { TimelineSourceAudio } from "./TimelineSourceAudio"
import { useTranscribeStatus } from "@/lib/audio/transcribe-status"
import { GenerateOverwriteDialog } from "@/components/GenerateOverwriteDialog"
import { AddFootnoteDialog } from "@/components/footnotes/AddFootnoteDialog"
import { CellTtsButton } from "@/components/CellTtsButton"
import { CellAudioUploadButton } from "@/components/CellAudioUploadButton"
import { ChevronsUpDown } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { VoiceAvatar } from "@/components/voice/VoiceAvatar"
import { VoicePickerContent } from "@/components/voice/VoiceCombobox"
import { getVoiceLibrary, resolveCastVoice } from "@/lib/audio/voices"
import { TranslatedEditor, type TranslatedEditorHandle } from "@/components/TranslatedEditor"
import { MISSING_AUDIO_MESSAGE } from "@/lib/audio/play-queue"
import { createUsfmFootnoteMarker } from "@/lib/footnotes/insert"
import { defaultFootnoteRef } from "@/lib/footnotes/refs"
import { effectiveSourceText } from "@/lib/cell-text"
import { getSkipReplaceConfirm, setSkipReplaceConfirm } from "@/lib/store/replace-confirm-pref"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import type { Concept } from "@/lib/terminology/types"
import type { RuleInfraction } from "@/lib/parsers/types"
import type { ProjectRecord } from "@/lib/parsers/types"

/** The text view's cell-action bundle, drilled from ProjectWorkspace as one
 *  object (the EditorActionsContext exists for row-memo stability across
 *  hundreds of rows — this pane is one component, plain props are simpler). */
export interface TimelineDetailActions {
  // AI completion (mirrors the text rail's gates)
  isCompletionConfigured: boolean
  isCompletionAvailable: boolean
  isAnonymous: boolean
  /** cellId → "searching" | "generating" | "error" */
  completing: Map<string, string>
  /** cellId → streaming draft text */
  previews: Map<string, string>
  /** cellId → last error message (e.g. the SUB-28 "transcribe first" guidance). */
  errors?: Map<string, string>
  onCompleteSingle(cell: CellData, opts?: { regenerate?: boolean }): Promise<unknown>
  onAiSetupNeeded(): void
  // Workspace drawers/modal (same handlers the text rail reaches via context)
  onOpenComments(cellId: string): void
  onOpenHistory(cellId: string): void
  onOpenRecording(cellId: string): void
  openCommentCounts?: Map<string, number>
  // Context CellTtsButton / CellAudioUploadButton need beyond the cell
  projectId: string
  sourceLanguage?: string
  targetLanguage?: string
  projectTtsSettings?: ProjectTtsSettings
  username: string
  /** Round 8 (per Sam): the voice/character picker under the SOURCE card.
   *  Pure assignment — never auto-synthesizes. */
  onAssignVoice?(cell: CellData, voiceId: string, opts?: { applyToSpeaker?: boolean }): void
}

export interface TimelineCellDetailProps {
  cell: CellData | null
  editable: boolean
  /** Emits a target commit. `valueHtml` carries the rich-text form so media
   *  edits persist identically to the main table (footnotes, marks, blots). */
  onCommitTarget(cellId: string, value: string, valueHtml?: string): void
  /** AQU-646: transcribe this clip's audio into source text (media segments).
   *  When absent the Transcribe affordance is hidden (read-only surfaces). */
  onTranscribe?(cell: CellData): void
  /** AQU-646 round 3: when absent, no action row renders (back-compat). */
  detailActions?: TimelineDetailActions
  /** Needed to resolve/stream the clip's source audio. When absent (focused
   *  unit tests), the source-audio control is simply not mounted. */
  project?: ProjectRecord
  /** Active managed terminology concepts — drives the in-editor term chips. */
  terminologyConcepts?: Concept[]
  /** Rule infractions for the selected cell — drives the violation blots. */
  infractions?: RuleInfraction[]
  /** The selected clip's stored recording is permanently gone (404). Shows a
   *  calm, non-retryable badge — matches the transport/waveform copy so the
   *  three surfaces agree. */
  audioMissing?: boolean
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground/80">
      {children}
    </span>
  )
}

function ActionIconButton({
  label,
  onClick,
  disabled,
  active,
  testId,
  children,
}: {
  label: string
  onClick(): void
  disabled?: boolean
  active?: boolean
  testId: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60",
        active ? "text-sky-600 dark:text-sky-400" : "text-foreground/80",
      )}
    >
      {children}
    </button>
  )
}

export function TimelineCellDetail({
  cell,
  editable,
  onCommitTarget,
  onTranscribe,
  detailActions,
  project,
  terminologyConcepts,
  infractions,
  audioMissing,
}: TimelineCellDetailProps) {
  const [footnoteOpen, setFootnoteOpen] = useState(false)
  const [overwriteOpen, setOverwriteOpen] = useState(false)
  // Round 8: the source card's voice picker (popover + apply-to-speaker).
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [applyToSpeaker, setApplyToSpeaker] = useState(false)
  /** The shared editor owns the target's content; footnote insertion goes
   *  through it so the marker lands at the caret with rich-text intact. */
  const editorRef = useRef<TranslatedEditorHandle | null>(null)
  const transcribeStatus = useTranscribeStatus(cell?.selectedAudioId)
  if (!cell) {
    return (
      <div
        data-testid="tl-detail-empty"
        className="flex items-center justify-center border-t border-border bg-muted/20 px-4 py-6 text-sm text-muted-foreground"
      >
        Select a clip to see and edit its details.
      </div>
    )
  }

  const isDialogue = (cell.medium ?? "text") === "media"
  // Round 8: which voice/character reads this line (picker under the source).
  const sourceVoice =
    isDialogue && detailActions?.onAssignVoice
      ? resolveCastVoice(detailActions.projectTtsSettings, cell.id, cell.ttsSettings?.voiceId)
      : null
  const start = cell.startTime ?? 0
  const end = cell.endTime ?? start
  const castName =
    cell.metadata && typeof cell.metadata.cast_name === "string"
      ? (cell.metadata.cast_name as string)
      : null

  // ── Action-row derivations (mirror the text rail's gates) ─────────────────
  const selectedAttachment = cell.selectedAudioId ? cell.attachments?.[cell.selectedAudioId] : undefined
  const hasAudio = Boolean(selectedAttachment && !selectedAttachment.isDeleted)
  const hasSourceAudio = Boolean(project && hasAudio)
  // NOTE (merge, 2026-07-27): dev's AQU-659 still gated mic/upload behind
  // "this section has no recorded take yet". Round 5 (SUB-33) deliberately
  // removed that gate — the buttons must STAY so you can re-record, and the
  // takes strip manages versions. Round 5 is the later decision and its tests
  // assert it, so the gate is not reinstated here.
  const completingState = detailActions?.completing.get(cell.id)
  const busy = completingState === "searching" || completingState === "generating"
  const preview = detailActions?.previews.get(cell.id)
  const isValidated = cell.status === "validated"
  const openComments = detailActions?.openCommentCounts?.get(cell.id) ?? 0
  const hasTranslated = (cell.translated ?? "").trim() !== ""

  const startCompletion = () => {
    const actions = detailActions
    if (!actions) return
    if (!actions.isCompletionConfigured) {
      actions.onAiSetupNeeded()
      return
    }
    if (hasTranslated) {
      // Same confirm policy as the text rail: validated cells always confirm;
      // non-validated respect the AQU-591 "don't ask again" opt-out.
      if (!isValidated && getSkipReplaceConfirm()) {
        void actions.onCompleteSingle(cell)
      } else {
        setOverwriteOpen(true)
      }
      return
    }
    void actions.onCompleteSingle(cell)
  }

  return (
    <div data-testid="tl-detail" className="border-t border-border bg-muted/20 px-4 py-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Pill>
          <b className="font-semibold text-foreground">{isDialogue ? "Dialogue" : "Subtitle"}</b>
        </Pill>
        <Pill>
          <span className="font-mono tabular-nums">
            {fmtClock(start, true)}–{fmtClock(end, true)}
          </span>
        </Pill>
        {castName && (
          <Pill>
            Speaker <b className="font-semibold text-foreground">{castName}</b>
          </Pill>
        )}
        {isDialogue && cell.cameraState && (
          <Pill>
            Camera <b className="font-semibold text-foreground">{cell.cameraState}</b>
          </Pill>
        )}
      </div>
      {audioMissing && (
        <div
          data-testid="tl-detail-audio-missing"
          role="status"
          className="mb-2.5 flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground"
        >
          <VolumeX className="h-3.5 w-3.5 shrink-0" />
          <span>{MISSING_AUDIO_MESSAGE}</span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              Source{isDialogue ? " · dialogue" : ""}
            </span>
            {/* AQU-646: transcribe the clip's audio into source text right
                where the clip is being worked on. Media segments only. */}
            {onTranscribe && isDialogue && cell.selectedAudioId && (
              <button
                type="button"
                data-testid="tl-detail-transcribe"
                onClick={() => onTranscribe(cell)}
                disabled={
                  !editable ||
                  transcribeStatus.kind === "loading" ||
                  transcribeStatus.kind === "transcribing"
                }
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-foreground/80 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {transcribeStatus.kind === "loading" || transcribeStatus.kind === "transcribing" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" /> Transcribing…
                  </>
                ) : (
                  <>
                    <Mic className="h-3 w-3" /> {cell.transcription ? "Re-transcribe" : "Transcribe"}
                  </>
                )}
              </button>
            )}
          </div>
          <div data-testid="tl-detail-source" className="text-sm leading-snug text-foreground">
            {cell.transcription || cell.original || "—"}
          </div>
          {/* AQU-659: the source clip's own player, right under its text. */}
          {hasSourceAudio && project && <TimelineSourceAudio project={project} cell={cell} />}
          {/* Round 8 (per Sam): the voice/character picker lives HERE — under
              the source, bottom-left — not on the timeline chips. */}
          {isDialogue && detailActions?.onAssignVoice && sourceVoice && (
            <div className="mt-2 flex items-center justify-start">
              <Popover open={voiceOpen} onOpenChange={setVoiceOpen}>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      data-testid="tl-detail-voice"
                      title={castName ? `${castName} — voiced by ${sourceVoice.name}` : `Voiced by ${sourceVoice.name}`}
                      aria-label={`Voice: ${sourceVoice.name}. Choose a voice`}
                      className="flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-background px-1.5 py-1 text-[11px] font-medium text-foreground/80 hover:bg-muted"
                    >
                      <VoiceAvatar voice={sourceVoice} size={16} />
                      <span className="max-w-[18ch] truncate">{castName ? `${castName} · ${sourceVoice.name}` : sourceVoice.name}</span>
                      <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    </button>
                  }
                />
                <PopoverContent align="start" side="top" className="w-60 p-2">
                  <VoicePickerContent
                    voices={getVoiceLibrary(detailActions.projectTtsSettings)}
                    activeId={sourceVoice.id}
                    onPick={(voiceId) => {
                      detailActions.onAssignVoice?.(cell, voiceId, { applyToSpeaker })
                      setVoiceOpen(false)
                    }}
                    footer={
                      castName ? (
                        <label className="mt-1.5 flex cursor-pointer items-center gap-2 border-t border-border pt-1.5 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            data-testid="tl-detail-voice-all"
                            checked={applyToSpeaker}
                            onChange={(e) => setApplyToSpeaker(e.target.checked)}
                          />
                          Apply to all «{castName}» lines
                        </label>
                      ) : undefined
                    }
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
        <div className="rounded-lg border border-border bg-card p-2.5">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              Target
            </span>
            {detailActions && (
              <div data-testid="tl-detail-actions" className="flex items-center gap-1">
                {editable && (
                  <ActionIconButton
                    label={
                      completingState === "error"
                        ? detailActions.errors?.get(cell.id) ?? "Generation failed — try again"
                        : "Translate with AI"
                    }
                    testId="tl-detail-ai"
                    onClick={startCompletion}
                    disabled={detailActions.isAnonymous || !detailActions.isCompletionAvailable || busy}
                    active={completingState === "error"}
                  >
                    <Sparkles
                      className={cn("h-3 w-3", completingState === "error" && "text-amber-600 dark:text-amber-400")}
                    />
                  </ActionIconButton>
                )}
                {editable && !detailActions.isAnonymous && !isValidated && hasTranslated && (
                  <ActionIconButton
                    label="Regenerate translation"
                    testId="tl-detail-regenerate"
                    onClick={() => void detailActions.onCompleteSingle(cell, { regenerate: true })}
                    disabled={!detailActions.isCompletionAvailable || busy}
                  >
                    <RefreshCw className="h-3 w-3" />
                  </ActionIconButton>
                )}
                {/* Round 5: mic/upload stay visible with a take present — the
                    takes strip manages versions; a vanishing mic read as a bug. */}
                {editable && (
                  <ActionIconButton
                    label="Record audio"
                    testId="tl-detail-record"
                    onClick={() => detailActions.onOpenRecording(cell.id)}
                  >
                    <Mic className="h-3 w-3" />
                  </ActionIconButton>
                )}
                {editable && (
                  <CellAudioUploadButton
                    projectId={detailActions.projectId}
                    fileId={cell.fileId}
                    cellId={cell.id}
                    username={detailActions.username}
                    disabled={!editable}
                  />
                )}
                {/* Round 5: no playOnly — generating here durably attaches the
                    voice (it appears on the Target-audio track); untranslated
                    cells render the button disabled with the reason. */}
                <CellTtsButton
                  cellId={cell.id}
                  text={cell.translated}
                  original={effectiveSourceText(cell)}
                  context={cell.context}
                  cellLabel={cell.cellLabel}
                  sourceLanguage={detailActions.sourceLanguage}
                  targetLanguage={detailActions.targetLanguage}
                  projectTtsSettings={detailActions.projectTtsSettings}
                  cellTtsSettings={cell.ttsSettings}
                  generatedVoiceAudioId={cell.selectedGeneratedVoiceAudioId}
                  attachments={cell.attachments}
                  projectId={detailActions.projectId}
                  fileId={cell.fileId}
                  disabled={!editable}
                />
                {editable && (
                  <ActionIconButton
                    label="Add footnote"
                    testId="tl-detail-footnote"
                    onClick={() => setFootnoteOpen(true)}
                  >
                    <NotebookPen className="h-3 w-3" />
                  </ActionIconButton>
                )}
                <ActionIconButton
                  label={openComments > 0 ? `Comments (${openComments} open)` : "Add comment"}
                  testId="tl-detail-comments"
                  onClick={() => detailActions.onOpenComments(cell.id)}
                  active={openComments > 0}
                >
                  <MessageCircle className="h-3 w-3" />
                </ActionIconButton>
                <ActionIconButton
                  label="Edit history"
                  testId="tl-detail-history"
                  onClick={() => detailActions.onOpenHistory(cell.id)}
                >
                  <HistoryIcon className="h-3 w-3" />
                </ActionIconButton>
              </div>
            )}
          </div>
          {busy && (
            <div
              data-testid="tl-detail-generating"
              className="mb-1 flex items-center gap-1.5 text-[11px] text-muted-foreground"
            >
              <Loader2 className="h-3 w-3 animate-spin" />
              {completingState === "searching" ? "Finding examples…" : "Generating…"}
            </div>
          )}
          {/* Streaming preview — the chunk-by-chunk draft renders beside the
              editor (same pattern as the text view's overlay); the editor
              re-hydrates from the committed cell when the stream lands. */}
          {busy && preview != null && preview !== "" && (
            <div
              data-testid="tl-detail-preview"
              className="mb-1 rounded-md border border-dashed border-border bg-muted/30 px-2 py-1 text-sm text-muted-foreground"
            >
              {preview}
            </div>
          )}
          <div
            data-testid="tl-detail-target"
            className={cn(
              "rounded-md border border-border bg-background px-2 py-1 text-sm focus-within:ring-2 focus-within:ring-sky-500/40",
              !editable && "opacity-60",
            )}
          >
            <TranslatedEditor
              ref={editorRef}
              cellId={cell.id}
              initialPlain={cell.translated ?? ""}
              initialHtml={cell.translatedHtml}
              editable={editable}
              compactHeight
              placeholder={editable ? "Translation…" : ""}
              ariaLabel="Clip translation"
              terminologyConcepts={terminologyConcepts}
              infractions={infractions}
              onCommit={(snapshot) => {
                if (editable) onCommitTarget(cell.id, snapshot.value, snapshot.valueHtml)
              }}
            />
          </div>
        </div>
      </div>
      {detailActions && (
        <>
          <GenerateOverwriteDialog
            open={overwriteOpen}
            isValidated={isValidated}
            onConfirm={(dontAskAgain) => {
              setOverwriteOpen(false)
              if (dontAskAgain) setSkipReplaceConfirm(true)
              void detailActions.onCompleteSingle(cell)
            }}
            onCancel={() => setOverwriteOpen(false)}
          />
          <AddFootnoteDialog
            open={footnoteOpen}
            defaults={{ caller: "+", ref: defaultFootnoteRef(cell), text: "", markerStyle: "numbered" }}
            onOpenChange={setFootnoteOpen}
            onAdd={(value) => {
              // Insert at the editor's caret (rich text intact) — its commit
              // pipeline persists the change. If the editor isn't ready,
              // append to the committed text, same as the text view's fallback.
              const marker = createUsfmFootnoteMarker(value)
              if (!editorRef.current?.insertFootnoteMarker(marker)) {
                onCommitTarget(cell.id, `${cell.translated ?? ""}${marker}`)
              }
              setFootnoteOpen(false)
            }}
          />
        </>
      )}
    </div>
  )
}
