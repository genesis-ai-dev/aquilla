// AQU-1092…1098: one lane of progress as a SEGMENTED bar in one hue.
//
// Two figures share a single track: the outer measure (translated, recorded)
// and the inner one it contains (validated). Validated is a subset of
// translated, so the track reads left to right as three exclusive states —
// validated, done but not yet validated, nothing yet — in one hue at two
// strengths. That is the timeline's own palette rule (Sam, 2026-08-27): one
// solid hue per thing, drawn at alphas over whatever is behind it, SAME ALPHAS
// IN BOTH THEMES, so every shade follows the theme instead of being redefined
// for it. See `track-colors.ts`, whose hues and rungs this reuses.
//
// The hues are the timeline's Azure and Cyan rather than the Progress card's
// amber and emerald, on purpose. Amber is Due soon and emerald is Done on this
// board, and a bar in either would read as a status it does not have. Blue is
// In progress, which is the one status a progress bar can agree with. Sam is
// raising the card's palette separately.
//
// The two fills never overlap. Drawn as two adjacent segments so each rung is
// exactly its alpha; stacked, the inner would composite to a third value that
// belongs to no ladder.

import { hexToRgba, parseTrackHue } from "@/lib/timeline/track-colors"

export type PlanBarTone = "text" | "audio"

/** The timeline's own hues, looked up by preset id so a retune there lands here. */
const HUE: Record<PlanBarTone, string> = {
  text: parseTrackHue("azure"),
  audio: parseTrackHue("cyan"),
}

/**
 * The chip ladder's two fill rungs, with the bar's own meanings: a third says
 * done, two thirds says verified. Named here rather than imported from the
 * chips, because "generated" and "translated" are different claims that
 * happen to share a strength.
 */
const ALPHA = { done: 0.33, validated: 0.67 } as const

export function PlanBar({ label, outer, inner, tone, aria }: {
  /** Omitted where the caller supplies its own leading gutter (a chapter number). */
  label?: string
  /** Percentage 0–100 of the containing measure. */
  outer: number
  /** Percentage 0–100 of the contained one; never drawn wider than `outer`. */
  inner: number
  tone: PlanBarTone
  aria: string
}) {
  const hue = HUE[tone]
  const validated = Math.max(0, Math.min(inner, outer))
  const done = Math.max(0, outer - validated)
  return (
    <span className="flex items-center gap-2" aria-label={aria} title={aria}>
      {label != null && (
        <span className="w-6 shrink-0 text-[9.5px] font-semibold tracking-wider text-muted-foreground">
          {label}
        </span>
      )}
      {/* Same track as the Progress card's bars: 8px, fully rounded, muted. */}
      <span className="relative h-2 min-w-[52px] flex-1 overflow-hidden rounded-full bg-muted">
        {validated > 0 && (
          <span
            data-plan-fill="validated"
            className={`absolute inset-y-0 start-0 ${done === 0 ? "rounded-e-full" : ""}`}
            style={{ width: `${validated}%`, backgroundColor: hexToRgba(hue, ALPHA.validated) }}
          />
        )}
        {done > 0 && (
          <span
            data-plan-fill="done"
            className="absolute inset-y-0 rounded-e-full"
            style={{
              insetInlineStart: `${validated}%`,
              width: `${done}%`,
              backgroundColor: hexToRgba(hue, ALPHA.done),
            }}
          />
        )}
      </span>
      <span className="w-[60px] shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
        {outer}
        <span className="px-px opacity-40">/</span>
        {inner}%
      </span>
    </span>
  )
}
