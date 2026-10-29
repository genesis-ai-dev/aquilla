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
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"

interface Props {
  value: AudioMediaStrategy
  onChange: (next: AudioMediaStrategy) => void
}

const ORDER: AudioMediaStrategy[] = ["lazy", "eager", "stream", "manual"]

export function AudioMediaStrategySection({ value, onChange }: Props) {
  const t = useT()
  const [infoOpen, toggleInfo] = useInfoOpen()
  return (
    <Card>
      <CardHeader>
        {/* Sam, Oct 28: the card's (i) opens what the card is for beneath the
            title and more on each choice inside each choice, and closes them
            again. Oct 29: each choice also says one short phrase, always. */}
        <CardTitle className="flex items-center gap-1">
          {t("projectSettings.audioMedia.title")}
          <InfoToggle
            open={infoOpen}
            onToggle={toggleInfo}
            label={t("projectSettings.audioMedia.infoAria")}
            controls={["settings-audio-media-explanation", ...ORDER.map((id) => `settings-audio-media-${id}-explanation`)].join(" ")}
            testId="settings-audio-media-info"
          />
        </CardTitle>
        <InfoReveal open={infoOpen} id="settings-audio-media-explanation">
          <span className="block text-sm text-muted-foreground">{t("projectSettings.audioMedia.info")}</span>
        </InfoReveal>
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
                  "flex flex-col items-start rounded-md border p-3 text-start text-sm transition-colors",
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border bg-background hover:bg-muted/40",
                )}
                aria-pressed={selected}
              >
                <span className="font-medium">{t(label.nameKey)}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t(label.summaryKey)}</span>
                <InfoReveal open={infoOpen} id={`settings-audio-media-${id}-explanation`}>
                  <span className="block text-xs text-muted-foreground">{t(label.infoKey)}</span>
                </InfoReveal>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
