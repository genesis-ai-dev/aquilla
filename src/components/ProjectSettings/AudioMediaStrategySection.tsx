// Lets the user pick how the project fetches audio bytes from the storage
// backend. Mirrors the desktop codex-editor's media strategies — useful when
// projects have hundreds of recordings and you want to control bandwidth /
// offline review.

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import {
  AUDIO_MEDIA_STRATEGY_LABELS, type AudioMediaStrategy,
} from "@/lib/parsers/types"
import { useT } from "@/lib/i18n/I18nProvider"
import { InfoTip } from "@/components/ui/info-tip"

interface Props {
  value: AudioMediaStrategy
  onChange: (next: AudioMediaStrategy) => void
}

const ORDER: AudioMediaStrategy[] = ["lazy", "eager", "stream", "manual"]

export function AudioMediaStrategySection({ value, onChange }: Props) {
  const t = useT()
  return (
    <Card>
      <CardHeader>
        {/* Sam, Oct 28: the card says only the four names; what each does,
            and what the card is for, sit behind the one (i). */}
        <CardTitle className="flex items-center gap-1">
          {t("projectSettings.audioMedia.title")}
          <InfoTip label={t("projectSettings.audioMedia.infoAria")} testId="settings-audio-media-info">
            <span className="flex flex-col gap-1.5">
              <span>{t("projectSettings.audioMedia.description")}</span>
              {ORDER.map((id) => (
                <span key={id}>
                  <span className="font-medium">{t(AUDIO_MEDIA_STRATEGY_LABELS[id].nameKey)}:</span>{" "}
                  {t(AUDIO_MEDIA_STRATEGY_LABELS[id].descriptionKey)}
                </span>
              ))}
            </span>
          </InfoTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          {ORDER.map((id) => {
            const label = AUDIO_MEDIA_STRATEGY_LABELS[id]
            const selected = value === id
            return (
              <button
                key={id}
                type="button"
                onClick={() => onChange(id)}
                className={cn(
                  "flex flex-col items-start gap-1 rounded-md border p-3 text-start text-sm transition-colors",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background hover:bg-muted/40",
                )}
                aria-pressed={selected}
              >
                <span className="font-medium">{t(label.nameKey)}</span>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
