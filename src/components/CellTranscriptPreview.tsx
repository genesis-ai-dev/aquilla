// Shows what the recording sounds like for this cell — the transcript is the
// hero, not the controls. Three calm states: a quiet "matches" reassurance, a
// neutral "sounds a little different" with a one-tap way to adopt what was
// heard, and an amber "you edited after recording" nudge. No tool names, no
// word-count chips, no jargon: just the spoken words and one obvious next step.

import { forwardRef, useMemo } from "react"
import { AudioLines, AlertTriangle, RefreshCw, CornerDownLeft, Check } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { WordTiming } from "@/lib/codex-editor/types"

interface Props {
  timings: WordTiming[] | undefined
  cellText: string
  cellId: string
  /** True when alignment used cell-text offsets (i.e. heard words match the
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

  // Stale needs a fix (amber). Match is a quiet, hands-off reassurance
  // (emerald). Differs is neutral — the transcript is the point, so let it
  // breathe and offer to adopt it.
  const state: "stale" | "match" | "differs" = isStale ? "stale" : matches ? "match" : "differs"

  const surface = {
    stale: "bg-amber-500/[0.07]",
    match: "bg-emerald-500/[0.06]",
    differs: "bg-muted/60",
  }[state]

  const accent = {
    stale: "bg-amber-500/70",
    match: "bg-emerald-500/55",
    differs: "bg-primary/45",
  }[state]

  const Icon = state === "stale" ? AlertTriangle : state === "match" ? Check : AudioLines
  const iconTone = {
    stale: "text-amber-600 dark:text-amber-400",
    match: "text-emerald-600 dark:text-emerald-400",
    differs: "text-muted-foreground",
  }[state]

  const headline = state === "stale"
    ? "You changed the text after recording"
    : state === "match"
      ? "Your recording matches your text"
      : cellHasText
        ? "Your recording sounds a little different"
        : "Here's what your recording says"

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={cn(
        "relative mt-2 overflow-hidden rounded-xl py-2.5 pr-3 pl-4 text-xs scroll-mt-16 outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        surface,
      )}
    >
      {/* Soft tone bar instead of a hard bordered box. */}
      <span aria-hidden className={cn("absolute inset-y-0 left-0 w-[3px] rounded-md", accent)} />

      <div className="flex items-center gap-1.5">
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconTone)} />
        <span className="text-[11px] font-medium text-foreground">{headline}</span>
      </div>

      {/* The heard words — the reason this panel exists. Foreground and roomy
          when there's something to act on; whisper-quiet when it already
          matches (nothing to do, so don't shout it). */}
      <p
        className={cn(
          "mt-1.5 break-words leading-relaxed",
          state === "match"
            ? "text-[12px] text-foreground/55"
            : "text-[13px] text-foreground/90",
        )}
      >
        <span aria-hidden className="select-none pr-0.5 text-foreground/25">&ldquo;</span>
        {transcript}
        <span aria-hidden className="select-none pl-0.5 text-foreground/25">&rdquo;</span>
      </p>

      {editable && state !== "match" && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {state === "stale" && onRetranscribe && (
            <AppTooltip content="Listen to the recording again and refresh the transcript">
              <Button
                size="xs"
                variant="outline"
                onClick={onRetranscribe}
              >
                <RefreshCw /> Transcribe again
              </Button>
            </AppTooltip>
          )}
          {state === "differs" && onUseAsCellText && (
            <AppTooltip content={cellHasText
              ? "Replace your text with what the recording says"
              : "Fill in your text from the recording"}>
              <Button
                size="xs"
                variant="outline"
                onClick={() => onUseAsCellText(transcript)}
              >
                <CornerDownLeft /> {cellHasText ? "Use what was heard" : "Use as the text"}
              </Button>
            </AppTooltip>
          )}
          {state === "differs" && onRetranscribe && (
            <AppTooltip content="Listen to the recording again and refresh the transcript">
              <Button
                size="xs"
                variant="ghost"
                onClick={onRetranscribe}
                className="text-muted-foreground"
              >
                <RefreshCw /> Transcribe again
              </Button>
            </AppTooltip>
          )}
        </div>
      )}
    </div>
  )
})
