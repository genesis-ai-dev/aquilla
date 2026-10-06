// Bible data (AQU-1687, AQU-1689): the bar above the editor's list while a
// Bible data filter narrows it, with the way back to every line. Two kinds:
// "Show every line by …" (Voices) and "Show cells that mention …" (Who's Who).

import { Button } from "@/components/ui/button"
import { useT } from "@/lib/i18n/I18nProvider"
import { useFormat } from "@/lib/i18n/format"
import type { BibleFilterView } from "./useBibleData"

interface VoiceFilterBannerProps {
  filter: BibleFilterView
  onClear: () => void
}

export function VoiceFilterBanner({ filter, onClear }: VoiceFilterBannerProps) {
  const t = useT()
  const fmt = useFormat()
  const summary =
    filter.kind === "speaker"
      ? t("bibleData.voices.filter.summary", {
          count: filter.count,
          speaker: fmt.isolate(filter.name ?? t("bibleData.voices.unknownSpeaker")),
        })
      : t("bibleData.whosWho.filter.summary", {
          count: filter.count,
          name: fmt.isolate(filter.name ?? t("bibleData.whosWho.unknownParticipant")),
        })
  return (
    <div
      role="status"
      data-testid="voice-filter-banner"
      data-filter-kind={filter.kind}
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-4 py-1 text-xs text-muted-foreground"
    >
      <span dir="auto" className="min-w-0 truncate">
        {summary}
      </span>
      <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 text-xs" onClick={onClear}>
        {t("bibleData.voices.filter.clear")}
      </Button>
    </div>
  )
}
