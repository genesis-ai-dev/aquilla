// Banner that surfaces batch transcribe-all / synth-all / measure / change-voice
// progress as a bottom-right toast. Subscribes to the batch-audio progress
// store; the toast is absent when idle.

import { X } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useProgressToast } from "@/components/batch/progress-toast"
import { getBatchProgress, useBatchProgress } from "@/lib/audio/batch-progress"

export function AudioBulkProgressBanner() {
  const progress = useBatchProgress()
  useProgressToast({
    id: progress ? `audio-batch:${progress.kind}` : "audio-batch",
    active: progress != null,
    type: "loading",
    body: progress ? <AudioBatchStatus /> : null,
    onClose: closeAudioBatchToast,
  })
  return null
}

function closeAudioBatchToast() {
  const progress = getBatchProgress()
  if (!progress || progress.cancelled) return
  const { kind } = progress
  if (kind === "changeVoice") {
    void import("@/lib/audio/change-voice-batch").then((m) => m.cancelBatchChangeVoice())
    return
  }
  void import("@/lib/audio/batch-audio").then((m) => {
    if (kind === "transcribe") m.cancelBatchTranscribe()
    else if (kind === "synth") m.cancelBatchSynth()
    else m.cancelBatchMeasure()
  })
}

function AudioBatchStatus() {
  const t = useT()
  const format = useFormat()
  const progress = useBatchProgress()
  if (!progress) return null

  const { kind, total, done, cancelled, waitingUntil } = progress
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const label =
    kind === "transcribe"
      ? t("common.transcribing")
      : kind === "synth"
        ? t("common.synthesizing")
        : kind === "changeVoice"
          ? t("audio.bulkProgress.changingVoices")
          : t("common.measuringLengths")
  // AQU-2093: the batch drivers load on demand. A running batch has already
  // loaded its own, so this resolves straight away.
  const handleCancel = () => {
    if (kind === "changeVoice") {
      void import("@/lib/audio/change-voice-batch").then((m) => m.cancelBatchChangeVoice())
      return
    }
    void import("@/lib/audio/batch-audio").then((m) => {
      if (kind === "transcribe") m.cancelBatchTranscribe()
      else if (kind === "synth") m.cancelBatchSynth()
      else m.cancelBatchMeasure()
    })
  }

  return (
    <div className="flex items-center gap-2 text-sm" data-testid="audio-batch-status">
      <span className="font-medium">{label}</span>
      <div className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
      {/* AQU-1681: the hosted limit paused the batch; it carries on by itself. */}
      {waitingUntil !== undefined && !cancelled && (
        <span className="text-muted-foreground" data-testid="bulk-progress-waiting">
          {t("audio.bulkProgress.waitingForLimit", { time: format.time(waitingUntil) })}
        </span>
      )}
      {!cancelled && (
        <AppTooltip content={t("audio.bulkProgress.cancelTooltip")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleCancel}
            aria-label={t("audio.bulkProgress.cancelTooltip")}
            className="ms-1 text-muted-foreground"
          >
            <X />
          </Button>
        </AppTooltip>
      )}
      {cancelled && (
        <span className="text-muted-foreground">{t("common.cancelling")}</span>
      )}
    </div>
  )
}
