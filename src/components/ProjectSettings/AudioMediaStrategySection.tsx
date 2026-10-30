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
import { SaveStatus } from "@/lib/settings/save-status"

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
        <CardTitle className="flex items-center justify-between gap-4">
          {t("projectSettings.audioMedia.title")}
          <SaveStatus id="audioMediaStrategy" className="font-normal" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t("projectSettings.audioMedia.description")}
        </p>
        {/* AQU-2259: it depends on this device's connection, so it stays here. */}
        <p className="text-xs text-muted-foreground">{t("projectSettings.deviceOnly")}</p>
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
                <span className="text-xs text-muted-foreground">{t(label.descriptionKey)}</span>
              </button>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
