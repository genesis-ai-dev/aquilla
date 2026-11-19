// One row of the Transcribe lens: a select box, play and what speech
// recognition heard on the left, the transcript and the sparkle on the right.
//
// The left side is also where the row shows its work. What was heard is typed
// out the moment it arrives. A cleanup is drawn over it as a diff — what was
// taken out struck through, what was put in beside it — and while the cleanup
// is still being written the diff covers only as much of the heard text as the
// reply has reached (transcript-cleanup/diff.ts). Editing the transcript by
// hand redraws the same diff, so a correction is seen against the machine's
// text as it is typed.
//
// Clearing happens on the LEFT: what ASR heard is what the transcript is built
// on, so clearing it clears both. Emptying the transcript on the right goes
// back to what ASR heard — an empty transcript over a heard text is not a state
// the row can hold.
//
// AQU-2654 (docs/decisions/0013): a row renders for its own changes only. It is
// memoized, its props keep their identity unless its own line changed (the
// handlers are the list's, told which line by its cell id), and what it is
// doing right now — the step it is on, the reply being written — it reads from
// its own entry in the row store rather than from the list's state.

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { Eraser, Loader2, Pause, Play, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { AppTooltip } from "@/components/ui/tooltip"
import { NoteOnClick } from "@/components/ui/info-note"
import { LoadingCursor } from "@/components/ui/loading-cursor"
import { useCellAudio } from "@/hooks/useCellAudio"
import { useT } from "@/lib/i18n/I18nProvider"
import { keptWindowSec } from "@/lib/audio/kept-window"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import { countChangedWords } from "@/lib/transcript-cleanup/prompt"
import type { TranscriptRow } from "@/lib/transcript-cleanup/rows"
import { cn } from "@/lib/utils"
import { TranscriptDiff, TypedText } from "./TranscriptDiff"
import { useRowLive, type RowLive, type RowLiveStore } from "./row-live-store"

export type { RowLive, RowStatus } from "./row-live-store"

/** A row has caught up once its own data shows what the run produced. */
function caughtUp(row: TranscriptRow, live: RowLive): boolean {
  return (live.heard === undefined || row.heard === live.heard)
    && (live.transcript === undefined || row.transcript === live.transcript)
    && (live.aiCleaned === undefined || row.aiCleaned === live.aiCleaned)
}

const STATUS_KEY = {
  unchanged: "transcribe.status.unchanged",
  unlearned: "transcribe.status.unlearned",
  "too-different": "transcribe.status.tooDifferent",
  "no-speech": "transcribe.status.noSpeech",
  validated: "transcribe.status.validated",
  allowance: "transcribe.status.allowance",
} as const

const FAILED_KEY = {
  asr: "transcribe.status.failedAsr",
  cleanup: "transcribe.status.failedCleanup",
  save: "transcribe.status.failedSave",
} as const

interface Props {
  project: ProjectRecord
  row: TranscriptRow
  label: string
  editable: boolean
  canRun: boolean
  /** Where the row's status and the text a run has in hand are kept. */
  store: RowLiveStore
  /** The speech model is still waking up: a row waiting on it says so. */
  modelWaking?: boolean
  selected: boolean
  // The handlers are the same functions for every row and every render; each
  // is told which line by its cell id.
  /** `range`: the Shift key was held, to select every row since the last pick. */
  onToggleSelect: (cellId: string, range: boolean) => void
  onRun: (cellId: string, forceAsr: boolean) => void
  onSave: (cellId: string, text: string) => void
  /** The transcript was emptied: go back to what ASR heard. */
  onRevert: (cellId: string) => void
  /** Clear what ASR heard and the transcript built on it. */
  onClear: (cellId: string) => void
}

const TRANSCRIPT_BOX = "w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"

export const TranscribeRow = memo(function TranscribeRow({
  project, row, label, editable, canRun, store, modelWaking = false, selected, onToggleSelect, onRun, onSave, onRevert, onClear,
}: Props) {
  const t = useT()
  const cellId = row.cell.id
  const shown = useRowLive(store, cellId)
  const status = shown.status
  // What a run produced is shown only until the row's own data has it.
  const live = shown.live && !caughtUp(row, shown.live) ? shown.live : undefined
  const attachment = row.cell.attachments?.[row.audioId]
  const cellForAudio = useMemo(
    () => ({ metadata: { attachments: row.cell.attachments, selectedAudioId: row.audioId } }) as unknown as CodexCell,
    [row.cell.attachments, row.audioId],
  )
  // Only whether it plays matters here, never the playhead.
  const audio = useCellAudio(project, cellForAudio, row.cell.fileId, { timeKey: () => 0 })
  const kept = keptWindowSec(row.cell, row.audioId, attachment)
  const { setTrim } = audio
  useEffect(() => {
    setTrim(kept.start, kept.end)
  }, [setTrim, kept.start, kept.end])

  const progress = status.kind === "working" ? status.progress : null
  const working = progress !== null
  // What the run has in hand wins over the row until the row catches up.
  // `live.heard` may be null (a clear), so only an absent one falls back.
  const heard = progress && progress.stage !== "listening"
    ? progress.heard ?? row.heard
    : live?.heard !== undefined ? live.heard : row.heard
  const transcript = (progress?.stage === "heard" ? progress.transcript : live?.transcript) ?? row.transcript
  // Typed out only when it has just arrived: a row that already had its text
  // when the view opened is not replayed. "Just arrived" is what a run in this
  // view reported hearing — remembered here, because the row's own data now
  // has the words in the same breath (the write hands them to the file's audio
  // read as it is queued), where it used to trail by a flush and a read.
  const [arrived, setArrived] = useState<string | null>(null)
  const reported = progress?.stage === "heard" ? progress.heard : null
  if (reported !== null && reported !== arrived) setArrived(reported)
  const justHeard = heard !== null && (heard !== row.heard || heard === arrived)

  // The draft follows the transcript whenever that changes (a save, a cleanup,
  // a refetch) — adjusted during render, not in an effect.
  const [draft, setDraft] = useState(transcript)
  const [draftFor, setDraftFor] = useState(transcript)
  if (draftFor !== transcript) {
    setDraftFor(transcript)
    setDraft(transcript)
  }
  // Escape blurs before its setDraft has rendered, so the blur's commit would
  // still see the edited draft. This marks that blur as a cancel.
  const cancelled = useRef(false)
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    const next = draft.trim().replace(/\s+/g, " ")
    if (!next && heard) {
      // Back to the stored text now; a revert that changes it re-renders anyway.
      setDraft(transcript)
      onRevert(cellId)
    }
    else if (next && next !== transcript) onSave(cellId, next)
    else setDraft(transcript)
  }

  const cleaning = progress?.stage === "cleaning" ? progress : null
  const statusText = status.kind === "failed"
    ? t(FAILED_KEY[status.step])
    : status.kind in STATUS_KEY ? t(STATUS_KEY[status.kind as keyof typeof STATUS_KEY]) : null
  const statusDetail = status.kind === "failed" ? status.detail : undefined
  const stageText = !progress ? null
    : progress.stage === "cleaning" ? t("transcribe.stage.cleaning")
      : progress.stage === "listening" ? t(modelWaking ? "transcribe.stage.waking" : "transcribe.stage.listening")
        : null
  const canClear = editable && !working && !row.validated && Boolean(heard || transcript)
  // Counted from what is on the row, so the number and the marks never disagree.
  // A word-level comparison of the two texts: redone when one of them changes,
  // not on every render of the row.
  const changes = useMemo(() => (heard && draft ? countChangedWords(heard, draft) : 0), [heard, draft])
  const aiCleaned = live?.aiCleaned ?? row.aiCleaned

  return (
    <div
      className="grid grid-cols-1 gap-3 border-b border-border px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
      data-testid="transcribe-row"
      data-cell-id={row.cell.id}
      aria-busy={working}
    >
      <div className="flex min-w-0 items-start gap-2">
        {canRun && (
          <Checkbox
            className="mt-2"
            checked={selected}
            aria-label={t("transcribe.select", { line: label })}
            onClick={(e) => {
              // The click, not onCheckedChange: only the click knows about Shift.
              e.preventDefault()
              onToggleSelect(cellId, e.shiftKey)
            }}
            data-testid="transcribe-select"
          />
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={audio.isPlaying ? t("transcribe.pause") : t("transcribe.play")}
          onClick={() => (audio.isPlaying ? audio.pause() : void audio.play())}
        >
          {audio.isPlaying ? <Pause /> : <Play />}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">{label}</div>
          <p
            className="mt-0.5 text-sm leading-relaxed text-muted-foreground"
            aria-label={t("transcribe.heard")}
            data-testid="transcribe-heard"
            data-heard={heard ?? ""}
          >
            {heard === null ? (
              // Nothing heard yet. While the row listens, a cursor holds the
              // place the words will be typed into, in place of a skeleton.
              progress?.stage === "listening"
                ? <LoadingCursor plain data-testid="transcribe-cursor" />
                : transcript ? "—" : t("transcribe.notTranscribed")
            ) : cleaning ? (
              <TranscriptDiff heard={heard} written={cleaning.text} writing />
            ) : justHeard && draft === transcript && changes === 0 ? (
              <TypedText text={heard} />
            ) : (
              <TranscriptDiff heard={heard} written={draft || heard} />
            )}
          </p>
        </div>
        {canClear && (
          <AppTooltip content={t("transcribe.clear")}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("transcribe.clear")}
              onClick={() => onClear(cellId)}
              data-testid="transcribe-clear"
            >
              <Eraser />
            </Button>
          </AppTooltip>
        )}
      </div>

      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          {cleaning ? (
            // The cleanup as the model writes it. A textarea cannot hold a
            // cursor that is not the person's own, so this stands in for it.
            <div
              className={cn(TRANSCRIPT_BOX, "min-h-[3.25rem] whitespace-pre-wrap break-words")}
              aria-label={t("transcribe.transcriptLabel")}
              aria-live="off"
              data-testid="transcribe-writing"
            >
              {cleaning.text}
              <LoadingCursor plain className="ms-px" />
            </div>
          ) : (
            <textarea
              aria-label={t("transcribe.transcriptLabel")}
              className={cn(
                TRANSCRIPT_BOX,
                "resize-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              rows={Math.max(2, Math.ceil(draft.length / 60))}
              value={draft}
              readOnly={!editable || working}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault()
                  e.currentTarget.blur()
                } else if (e.key === "Escape") {
                  cancelled.current = true
                  setDraft(transcript)
                  e.currentTarget.blur()
                }
              }}
              data-testid="transcribe-transcript"
            />
          )}
          <div className="mt-1 flex min-h-4 items-center gap-2 text-xs">
            {stageText && (
              <span className="inline-flex items-center gap-1 text-muted-foreground" role="status" data-testid="transcribe-stage">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {stageText}
              </span>
            )}
            {!working && aiCleaned && (
              <span className="inline-flex items-center gap-1 text-primary" data-testid="transcribe-cleaned">
                <Sparkles className="size-3" aria-hidden />
                {t("transcribe.cleaned", { count: changes })}
              </span>
            )}
            {!working && !aiCleaned && changes > 0 && (
              <span className="text-muted-foreground" data-testid="transcribe-edited">
                {t("transcribe.edited", { count: changes })}
              </span>
            )}
            {/* A failure's detail opens on a click of its words, never a
                hover (AQU-2260). */}
            {statusText && (
              <NoteOnClick note={statusDetail}>
                <span
                  className={cn(status.kind === "failed" ? "text-destructive" : "text-muted-foreground")}
                  data-testid="transcribe-status"
                >
                  {statusText}
                </span>
              </NoteOnClick>
            )}
          </div>
        </div>
        {canRun && (
          <AppTooltip content={t("transcribe.run")}>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("transcribe.run")}
              disabled={working || row.validated}
              onClick={(e) => onRun(cellId, e.altKey)}
              data-testid="transcribe-run"
            >
              {working ? <Loader2 className="animate-spin" aria-label={t("transcribe.status.working")} /> : <Sparkles />}
            </Button>
          </AppTooltip>
        )}
      </div>
    </div>
  )
})
