// Voices (AQU-1687): the bar above the editor's list while "Show every line
// by …" filters it, with the way back to every line.

import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { BibleVoicesFilter } from "./useBibleVoices"

interface VoiceFilterBannerProps {
  filter: BibleVoicesFilter
  onClear: () => void
}

export function VoiceFilterBanner({ filter, onClear }: VoiceFilterBannerProps) {
  const t = useT()
  const fmt = useFormat()
  const speaker = filter.label?.label ?? t("bibleData.voices.unknownSpeaker")
  return (
    <div
      role="status"
      data-testid="voice-filter-banner"
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-1 text-xs text-muted-foreground"
    >
      <span dir="auto" className="min-w-0 truncate">
        {t("bibleData.voices.filter.summary", { count: filter.count, speaker: fmt.isolate(speaker) })}
      </span>
      <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={onClear}>
        {t("bibleData.voices.filter.clear")}
      </Button>
    </div>
  )
}
