// Banner that surfaces batch transcribe-all / synth-all progress.
// Subscribes to the batch-audio progress store; renders nothing when idle.

import { X } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import {
  useBatchProgress,
  cancelBatchTranscribe,
  cancelBatchSynth,
} from "@/lib/audio/batch-audio"

export function AudioBulkProgressBanner() {
  const t = useT()
  const progress = useBatchProgress()
  if (!progress) return null

  const { kind, total, done, cancelled } = progress
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const label = kind === "transcribe" ? t("audio.bulkProgress.transcribing") : t("audio.bulkProgress.synthesizing")
  const handleCancel = () => {
    if (kind === "transcribe") cancelBatchTranscribe()
    else cancelBatchSynth()
  }

  return (
    <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
      <span className="font-medium">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular-nums text-muted-foreground">
        {done}/{total}
      </span>
      {!cancelled && (
        <AppTooltip content={t("audio.bulkProgress.cancelTooltip")}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleCancel}
            aria-label={t("audio.bulkProgress.cancelTooltip")}
            className="ml-1 text-muted-foreground"
          >
            <X />
          </Button>
        </AppTooltip>
      )}
      {cancelled && (
        <span className="text-muted-foreground">{t("audio.bulkProgress.cancelling")}</span>
      )}
    </div>
  )
}
