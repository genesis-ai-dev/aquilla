// AQU-928: the media view's section-scoped transcribe control.
//
// Before this row existed, transcribing "just this section" meant knowing that
// a Transcribe button appears inside one clip's expanded audio panel in the
// table below — so the only discoverable action was the bulk "transcribe
// everything". This bar sits under the lanes, always visible in the media
// lens, and states three things plainly: how many sections are selected, that
// transcribing runs on exactly those, and how to select more than one.
//
// It renders no timeline geometry and owns no selection state — TimelineEditor
// passes the counts and the two callbacks.

import { Sparkles } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

export interface TimelineTranscribeBarProps {
  /** Sections currently selected on the lanes (primary + modifier-picked). */
  selectedCount: number
  /** How many of those actually carry audio to run ASR over. Fewer than
   *  `selectedCount` when the user included sections with no recording. */
  eligibleCount: number
  /** Another audio batch (transcribe-all, synth-all, measure) is running. The
   *  batch progress store is a single slot, so a second run would fight it. */
  busy: boolean
  onTranscribe(): void
  onClear(): void
}

export function TimelineTranscribeBar({
  selectedCount,
  eligibleCount,
  busy,
  onTranscribe,
  onClear,
}: TimelineTranscribeBarProps) {
  const t = useT()
  const disabled = busy || eligibleCount === 0
  // One reason per disabled state, most specific first — a button that just
  // greys out teaches nothing about how to un-grey it.
  const tooltip = busy
    ? t("editor.timeline.transcribeSelectionBusyTooltip")
    : selectedCount === 0
      ? t("editor.timeline.transcribeSelectionEmptyTooltip")
      : eligibleCount === 0
        ? t("editor.timeline.transcribeSelectionNoAudioTooltip")
        : t("editor.timeline.transcribeSelectionTooltip")

  return (
    <div
      data-testid="tl-transcribe-bar"
      className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/10 px-4 py-1.5 text-xs"
    >
      <span data-testid="tl-transcribe-count" className="text-muted-foreground">
        {selectedCount === 0
          ? t("editor.timeline.transcribeSelectionEmpty")
          : t("editor.timeline.transcribeSelectionCount", { count: selectedCount })}
      </span>
      <AppTooltip content={tooltip}>
        <button
          type="button"
          data-testid="tl-transcribe-selection"
          disabled={disabled}
          onClick={onTranscribe}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1 font-medium text-foreground/80",
            "hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {eligibleCount > 1
            ? t("editor.timeline.transcribeSelectionActionMany", { count: eligibleCount })
            : t("editor.timeline.transcribeSelectionActionOne")}
        </button>
      </AppTooltip>
      {selectedCount > 0 && (
        <button
          type="button"
          data-testid="tl-transcribe-clear"
          onClick={onClear}
          className="rounded-md px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {t("editor.timeline.transcribeSelectionClear")}
        </button>
      )}
      {/* The multi-select gesture, spelled out rather than left to be guessed —
          this bar is the only place it's documented in the UI. */}
      <span className="ms-auto text-[11px] text-muted-foreground">
        {t("editor.timeline.transcribeSelectionHint")}
      </span>
    </div>
  )
}
