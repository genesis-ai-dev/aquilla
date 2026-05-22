// Shows what Whisper heard for the cell's selected recording, plus a
// one-click action to use it as the cell's text when the transcript differs
// from what the user typed. Renders under the waveform when timings exist;
// gives the otherwise-invisible transcription work an obvious payoff.

import { forwardRef, useMemo } from "react"
import { Sparkles, AlertTriangle, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import type { WordTiming } from "@/lib/codex-editor/types"

interface Props {
  timings: WordTiming[] | undefined
  cellText: string
  cellId: string
  /** True when alignment used cell-text offsets (i.e. Whisper words match the
   *  cell's word count). When false, the karaoke decoration won't paint and
   *  this preview is the user's only signal that transcription happened. */
  alignedToCellText: boolean
  editable: boolean
  onRetranscribe?: () => void
}

function transcriptOf(timings: WordTiming[]): string {
  return timings.map((t) => t.word).join(" ")
}

function looselyEquals(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ")
  return norm(a) === norm(b)
}

export const CellTranscriptPreview = forwardRef<HTMLDivElement, Props>(function CellTranscriptPreview({
  timings, cellText, cellId: _cellId, alignedToCellText, editable: _editable, onRetranscribe,
}: Props, ref) {
  const transcript = useMemo(() => (timings ? transcriptOf(timings) : ""), [timings])
  if (!timings || timings.length === 0) return null

  const matches = looselyEquals(transcript, cellText)
  const cellHasText = cellText.trim().length > 0
  // Stale = a timing references a char offset past the current cell text. The
  // cell was edited (probably shortened) after transcription, so the karaoke
  // decoration would either no-op or paint the wrong word. Re-transcribe.
  const lastTiming = timings[timings.length - 1]
  const isStale = alignedToCellText && lastTiming.end > cellText.length

  // Phase 2c-gamma: "Use as cell text" wrote into the per-file Y.Doc.
  // The button still renders but is disabled until the cell-text-from-
  // transcript writeback returns via the target.cell.commit grammar.

  const tone = isStale
    ? "border-amber-500/40 bg-amber-500/5"
    : matches
      ? "border-emerald-500/30 bg-emerald-500/5"
      : alignedToCellText
        ? "border-muted-foreground/20 bg-muted/20"
        : "border-amber-500/40 bg-amber-500/5"

  const Icon = isStale ? AlertTriangle : Sparkles
  const iconTone = isStale || !matches
    ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400"

  const headline = isStale
    ? `Cell text was edited — karaoke timings are out of date`
    : matches
      ? `Whisper heard the cell exactly · ${timings.length} word${timings.length === 1 ? "" : "s"}`
      : alignedToCellText
        ? `Whisper transcript · ${timings.length} word${timings.length === 1 ? "" : "s"}`
        : `Transcript doesn't match cell text · ${timings.length} word${timings.length === 1 ? "" : "s"}`

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={cn(
        "mt-1.5 rounded border px-2.5 py-1.5 text-xs scroll-mt-16 outline-none",
        "focus:ring-2 focus:ring-primary/40",
        tone,
      )}
    >
      <div className="flex items-start gap-1.5 leading-snug">
        <Icon className={cn("mt-0.5 h-3 w-3 shrink-0", iconTone)} />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
            {headline}
          </div>
          <div className="mt-0.5 italic text-foreground/80 break-words">
            "{transcript}"
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {isStale && _editable && onRetranscribe && (
              <button
                type="button"
                onClick={onRetranscribe}
                className="inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary transition-colors hover:bg-primary/20"
                title="Run Whisper again with the current cell text"
              >
                <RefreshCw className="h-2.5 w-2.5" />
                Re-transcribe
              </button>
            )}
            {!matches && !isStale && _editable && cellHasText && (
              <span
                className="text-[10px] text-muted-foreground"
                title="Replacing cell text from a transcript is disabled in this build"
              >
                Transcript-to-cell write disabled in this build
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})
