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

import type { ReactNode } from "react"
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

export function PlanBar({ label, outer, inner, tone, aria, readout }: {
  /** Omitted where the caller supplies its own leading gutter (a chapter number). */
  label?: string
  /** Percentage 0–100 of the containing measure. */
  outer: number
  /** Percentage 0–100 of the contained one; never drawn wider than `outer`. */
  inner: number
  tone: PlanBarTone
  aria: string
  /**
   * AQU-1278: what to print in the readout slot, instead of "outer% | inner%".
   *
   * A unit reads in PERCENTAGES and a person or a chapter reads in CELLS. At
   * those grains "940 | 938" is a fact a manager can act on — two cells left —
   * where "99% | 99%" is those two cells rounded out of existence. The slot
   * keeps its fixed width either way, so a column of bars stays aligned
   * whichever kind of number is in it. Build it with `Readout` so the two
   * numbers are separated the same way everywhere.
   */
  readout?: ReactNode
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
      {/* 72px, not 60: "100% | 100%" is the widest this reads and it has to
          fit without wrapping, or the row grows a line on the very unit that
          is finished. */}
      <span className="w-[72px] shrink-0 text-end text-[11px] tabular-nums text-muted-foreground">
        {readout ?? <Readout left={`${outer}%`} right={`${inner}%`} />}
      </span>
    </span>
  )
}


/**
 * Two numbers in a bar's readout slot, separated the one way this board does it.
 *
 * A BAR, NOT A SLASH. The readout used to be "100/99%", and Sam read it the
 * way anyone would — "100 out of 99 percent", which is nonsense — because a
 * slash means division everywhere else a number appears. The two figures are
 * siblings (translated beside validated, recorded beside signed off), so they
 * get a divider that only ever means "and": a thin vertical bar. The same
 * element serves percentages on a unit and counts on a person or a chapter,
 * so the three never drift into three notations.
 */
export function Readout({ left, right }: { left: ReactNode; right: ReactNode }) {
  return (
    <>
      {left}
      {/* Real spaces, not padding: copied or read aloud this is "940 | 938",
          which is what Sam wrote, and a test can say the same. */}
      <span className="opacity-40">{" | "}</span>
      {right}
    </>
  )
}
