// AQU-928: the media view's section-scoped transcribe control.
// AQU-646 stage 3e: …no longer a row of its own.
//
// Before this existed, transcribing "just this section" meant knowing that a
// Transcribe button appears inside one clip's expanded audio panel in the table
// below — so the only discoverable action was the bulk "transcribe everything".
// The fix was a full-width bar under the lanes that was always on screen and
// stated three things plainly: how many sections are selected, that transcribing
// runs on exactly those, and how to select more than one.
//
// ALWAYS ON SCREEN IS WHAT SAM OBJECTED TO (2026-08-25): "a whole separate
// vertical section of the screen dedicated to one little button and a line of
// text that could be a tooltip." With nothing selected the bar spent a full row
// saying "No section selected" beside a greyed-out button, permanently, in a
// view where vertical space is the thing the tracks are competing for.
//
// So this is a group of controls that lives INSIDE the "Source text" header,
// beside the label, and appears only once there is a selection to act on. The
// empty state is gone entirely — the caller does not render this without one.
//
// THAT PLACEMENT IS NOT ARBITRARY, and Sam's reasoning is the part to keep:
// these controls act on CELLS, and the timing readout on the row below acts on
// CHIPS. The cell-shaped thing goes in the cell table's header; the numbers stay
// with the timeline that measures them.
//
// It renders no timeline geometry and owns no selection state — TimelineEditor
// passes the counts and the two callbacks, and decides whether to render it.

import { Sparkles } from "lucide-react"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"

export interface TranscribeSelectionControlsProps {
  /** Sections currently selected on the lanes (primary + modifier-picked).
   *  Always at least 1 — the caller withholds this whole group otherwise. */
  selectedCount: number
  /** How many of those actually carry audio to run ASR over. Fewer than
   *  `selectedCount` when the user included sections with no recording. */
  eligibleCount: number
  /**
   * AQU-646 stage 3g: how many RECORDINGS those sections amount to.
   *
   * One heard line can perform several subtitles — 22.7% of them do — so three
   * eligible sections can be one recording, and the run transcribes it once.
   * Equal to `eligibleCount` in every ordinary arrangement.
   */
  recordingCount: number
  /** Another audio batch (transcribe-all, synth-all, measure) is running. The
   *  batch progress store is a single slot, so a second run would fight it. */
  busy: boolean
  onTranscribe(): void
  onClear(): void
}

export function TranscribeSelectionControls({
  selectedCount,
  eligibleCount,
  recordingCount,
  busy,
  onTranscribe,
  onClear,
}: TranscribeSelectionControlsProps) {
  const t = useT()
  const disabled = busy || eligibleCount === 0
  // One reason per disabled state, most specific first — a button that just
  // greys out teaches nothing about how to un-grey it. There is no
  // "nothing selected" reason any more: this does not render in that state.
  // AQU-646 stage 3g: the sections and the recordings can be different numbers,
  // and when they are, that IS the notice — said in the labels already on
  // screen rather than in a strip added to a row that was just decluttered.
  const collapsed = recordingCount > 0 && recordingCount < eligibleCount
  const tooltip = busy
    ? t("editor.timeline.transcribeSelectionBusyTooltip")
    : eligibleCount === 0
      ? t("editor.timeline.transcribeSelectionNoAudioTooltip")
      : collapsed
        ? t("editor.timeline.transcribeSelectionSharedTooltip", { count: recordingCount })
        : t("editor.timeline.transcribeSelectionTooltip")

  return (
    <div
      data-testid="tl-transcribe-controls"
      className="flex min-w-0 items-center gap-2 text-xs"
    >
      {/* THE MULTI-SELECT GESTURE IS A TOOLTIP NOW, not a line of text on the
          far right (Sam: "just put that as like a tooltip or something it's just
          stupid"). It hangs off the COUNT rather than off the button because
          "how do I select more?" is a question you have while reading how many
          you have selected.

          `tabIndex` because it is a span: the text it replaces was readable by
          everyone, so a pointer-only affordance would be a real regression
          rather than a tidy-up. A focusable label is the cost of that. */}
      <AppTooltip content={t("editor.timeline.transcribeSelectionHint")}>
        <span
          data-testid="tl-transcribe-count"
          tabIndex={0}
          className="shrink-0 rounded-sm text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          {t("editor.timeline.transcribeSelectionCount", { count: selectedCount })}
          {collapsed && (
            <span data-testid="tl-transcribe-recordings">
              {" · "}
              {t("editor.timeline.transcribeSelectionRecordings", { count: recordingCount })}
            </span>
          )}
        </span>
      </AppTooltip>
      <AppTooltip content={tooltip}>
        <button
          type="button"
          data-testid="tl-transcribe-selection"
          disabled={disabled}
          onClick={onTranscribe}
          className={cn(
            // h-7 matches the segment navigator's buttons at the other end of
            // this row, so the header's controls sit on one line.
            "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2 font-medium text-foreground/80",
            "hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <Sparkles className="h-3.5 w-3.5" />
          {/* THE COUNT ON THE BUTTON IS THE WORK, not the selection. Three
              sections performed by one heard line run ONE transcription, and a
              button promising three would be over-promising in the direction
              that matters. */}
          {recordingCount > 1
            ? t("editor.timeline.transcribeSelectionActionMany", { count: recordingCount })
            : t("editor.timeline.transcribeSelectionActionOne")}
        </button>
      </AppTooltip>
      <button
        type="button"
        data-testid="tl-transcribe-clear"
        onClick={onClear}
        className="h-7 shrink-0 rounded-md px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        {t("editor.timeline.transcribeSelectionClear")}
      </button>
    </div>
  )
}
