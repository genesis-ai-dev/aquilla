// One row of the Transcribe lens: play and what ASR heard on the left, the
// transcript and the sparkle on the right (spec §2).

import { useEffect, useMemo, useState } from "react"
import { Loader2, Pause, Play, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useCellAudio } from "@/hooks/useCellAudio"
import { useT } from "@/lib/i18n/I18nProvider"
import { keptWindowSec } from "@/lib/audio/kept-window"
import type { CodexCell } from "@/lib/codex-editor/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { TranscriptRow } from "@/lib/transcript-cleanup/rows"
import type { SparkleOutcome } from "@/lib/transcript-cleanup/run"
import { cn } from "@/lib/utils"

export type RowStatus = { kind: "idle" } | { kind: "working" } | SparkleOutcome

const STATUS_KEY = {
  unchanged: "transcribe.status.unchanged",
  "too-different": "transcribe.status.tooDifferent",
  "no-speech": "transcribe.status.noSpeech",
  validated: "transcribe.status.validated",
  allowance: "transcribe.status.allowance",
  failed: "transcribe.status.failed",
} as const

interface Props {
  project: ProjectRecord
  row: TranscriptRow
  label: string
  editable: boolean
  canRun: boolean
  status: RowStatus
  onRun: (forceAsr: boolean) => void
  onSave: (text: string) => void
}

export function TranscribeRow({ project, row, label, editable, canRun, status, onRun, onSave }: Props) {
  const t = useT()
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

  // The draft follows the stored transcript whenever that changes (a save, a
  // cleanup, a refetch) — adjusted during render, not in an effect.
  const [draft, setDraft] = useState(row.transcript)
  const [draftFor, setDraftFor] = useState(row.transcript)
  if (draftFor !== row.transcript) {
    setDraftFor(row.transcript)
    setDraft(row.transcript)
  }
  const commit = () => {
    const next = draft.trim().replace(/\s+/g, " ")
    if (next && next !== row.transcript) onSave(next)
    else setDraft(row.transcript)
  }

  const working = status.kind === "working"
  const statusText = status.kind in STATUS_KEY ? t(STATUS_KEY[status.kind as keyof typeof STATUS_KEY]) : null
  const changes = row.aiCleaned ? row.cell.attachments?.[row.audioId]?.transcriptAi?.changes ?? 0 : 0

  return (
    <div
      className="grid grid-cols-1 gap-3 border-b border-border px-4 py-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]"
      data-testid="transcribe-row"
      data-cell-id={row.cell.id}
    >
      <div className="flex min-w-0 items-start gap-2">
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
          <div className="mt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t("transcribe.heard")}</div>
          <p className="text-sm text-muted-foreground" data-testid="transcribe-heard">
            {row.heard ?? (row.transcript ? "—" : t("transcribe.notTranscribed"))}
          </p>
        </div>
      </div>

      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <textarea
            aria-label={t("transcribe.transcriptLabel")}
            className={cn(
              "w-full resize-none rounded-md border border-input bg-transparent px-2 py-1.5 text-sm",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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
                setDraft(row.transcript)
                e.currentTarget.blur()
              }
            }}
            data-testid="transcribe-transcript"
          />
          <div className="mt-1 flex min-h-4 items-center gap-2 text-xs">
            {row.aiCleaned && (
              <span className="inline-flex items-center gap-1 text-primary" data-testid="transcribe-cleaned">
                <Sparkles className="size-3" aria-hidden />
                {t("transcribe.cleaned", { count: changes })}
              </span>
            )}
            {statusText && <span className="text-muted-foreground" data-testid="transcribe-status">{statusText}</span>}
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
              onClick={(e) => onRun(e.altKey)}
              data-testid="transcribe-run"
            >
              {working ? <Loader2 className="animate-spin" aria-label={t("transcribe.status.working")} /> : <Sparkles />}
            </Button>
          </AppTooltip>
        )}
      </div>
    </div>
  )
}
