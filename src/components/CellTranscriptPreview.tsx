// Shows what Whisper heard for the cell's selected recording, plus one-click
// actions to re-run transcription or adopt the transcript as the cell's text
// when it differs from what the user typed. Renders under the waveform when
// timings exist; gives the otherwise-invisible transcription work an obvious
// payoff.

import { forwardRef, useMemo } from "react"
import { Sparkles, AlertTriangle, RefreshCw, CornerDownLeft } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
  /** Commit the transcript as the cell's target text. Receives the plain
   *  transcript string. Surfaced when the transcript differs from the cell. */
  onUseAsCellText?: (transcript: string) => void
}

function transcriptOf(timings: WordTiming[]): string {
  return timings.map((t) => t.word).join(" ")
}

function looselyEquals(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").trim().replace(/\s+/g, " ")
  return norm(a) === norm(b)
}

export const CellTranscriptPreview = forwardRef<HTMLDivElement, Props>(function CellTranscriptPreview({
  timings, cellText, cellId: _cellId, alignedToCellText, editable, onRetranscribe, onUseAsCellText,
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

  const wordCount = `${timings.length} word${timings.length === 1 ? "" : "s"}`

  const tone = isStale || (!matches && !alignedToCellText)
    ? "border-amber-500/40"
    : matches
      ? "border-emerald-500/30"
      : "border-border"

  const Icon = isStale ? AlertTriangle : Sparkles
  const iconTone = isStale || !matches
    ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400"

  const headline = isStale
    ? "Cell text was edited — word timings are out of date"
    : matches
      ? "Whisper heard the cell exactly"
      : alignedToCellText
        ? "Whisper transcript"
        : "Transcript doesn't match cell text"

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={cn(
        "mt-1.5 rounded-lg border bg-card px-3 py-2 text-xs scroll-mt-16 outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        tone,
      )}
    >
      <div className="flex items-start gap-2 leading-snug">
        <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", iconTone)} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-medium text-foreground">{headline}</span>
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
              {wordCount}
            </Badge>
          </div>
          <p className="break-words italic text-muted-foreground">"{transcript}"</p>
          {editable && (
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              {isStale && onRetranscribe && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={onRetranscribe}
                  title="Run Whisper again with the current cell text"
                >
                  <RefreshCw /> Re-transcribe
                </Button>
              )}
              {!matches && !isStale && onUseAsCellText && (
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onUseAsCellText(transcript)}
                  title={cellHasText
                    ? "Replace this cell's text with the transcript"
                    : "Set this cell's text from the transcript"}
                >
                  <CornerDownLeft /> {cellHasText ? "Use as cell text" : "Fill cell from transcript"}
                </Button>
              )}
              {!matches && !isStale && onRetranscribe && (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={onRetranscribe}
                  title="Run Whisper again"
                  className="text-muted-foreground"
                >
                  <RefreshCw /> Re-transcribe
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
})
