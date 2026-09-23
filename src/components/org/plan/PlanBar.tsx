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
import { AppTooltip } from "@/components/ui/tooltip"
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

export function PlanBar({ label, outer, inner, tone, aria, tips }: {
  /** Omitted where the caller supplies its own leading gutter (a chapter number). */
  label?: string
  /** Percentage 0–100 of the containing measure. */
  outer: number
  /** Percentage 0–100 of the contained one; never drawn wider than `outer`. */
  inner: number
  tone: PlanBarTone
  aria: string
  /**
   * AQU-1278, round 7 (Sam, 2026-09-17): what each percentage STANDS FOR, as
   * a sentence — "1,530 of 1,533 validated" — shown on hover and read by a
   * screen reader in its place. Percentages stay in print everywhere, and the
   * count with its "of" lives here, one hover away, because on a dubbing
   * project the audio bar's total is the cue sheet's and not the file's, and
   * printing that on every bar was more than the panel could carry.
   */
  tips?: { outer: string; inner: string }
}) {
  const hue = HUE[tone]
  const validated = Math.max(0, Math.min(inner, outer))
  const done = Math.max(0, outer - validated)
  return (
    // No `title`: the bar used to repeat its two percentages in a sentence on
    // hover, and the numbers now say more than that sentence did.
    <span className="flex items-center gap-2" aria-label={aria}>
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
          is finished. A flex box rather than right-aligned text so the
          `Readout` inside can pin its divider to the slot's centre. */}
      <span className="flex w-[72px] shrink-0 items-center text-[11px] tabular-nums text-muted-foreground">
        <Readout left={`${outer}%`} right={`${inner}%`} leftTip={tips?.outer} rightTip={tips?.inner} />
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
 * siblings (translated beside validated, recorded beside validated), so they
 * get a divider that only ever means "and": a thin vertical rule.
 *
 * PERCENTAGES EVERYWHERE, since 2026-09-17. A person's and a chapter's bars
 * used to read in cells — "940 | 938" — on the argument that two cells left
 * is a fact a manager can act on where "99% | 99%" rounds it away. Sam chose
 * consistency instead: every bar reads the same way, and the count with its
 * total is what the hover says.
 *
 * THE RULE SITS AT THE SLOT'S CENTRE ON EVERY ROW, not wherever the text
 * happens to end. Each number gets half the slot — the left one flush against
 * the rule, the right one starting after it — so a column of bars shows one
 * straight line of dividers down the board, and "100%" beside "0%" lines up
 * with "98%" beside "96%" (Sam, 2026-09-17). Drawn as an element rather than
 * a "|" glyph so it can be taller than the digits and still centred on them;
 * the glyph survives for copy and screen readers, hidden from sight.
 */
function Readout({ left, right, leftTip, rightTip }: {
  left: ReactNode
  right: ReactNode
  /** What the left figure stands for, in full; makes it a hover target. */
  leftTip?: string
  /** What the right figure stands for, in full; makes it a hover target. */
  rightTip?: string
}) {
  return (
    <span className="flex w-full items-center">
      <span className="flex-1 text-end">
        <ReadoutFigure tip={leftTip}>{left}</ReadoutFigure>
        <span className="sr-only">{" | "}</span>
      </span>
      <PlanRule className="mx-[4px]" />
      <span className="flex-1 text-start">
        <ReadoutFigure tip={rightTip}>{right}</ReadoutFigure>
      </span>
    </span>
  )
}

/**
 * The board's one divider between two things on a line: a thin vertical rule
 * in the surrounding text's colour, taller than the digits it sits between.
 * Born as the readout's "and" between translated and validated; the in-order
 * row's count line uses the same rule between the cell count and the status
 * ("120 cells | ● Nearly complete") because a middle dot there sat beside the
 * status's own dot and read as two dots (Sam, 2026-09-17). Decorative only:
 * hidden from assistive tech, so a caller that needs a spoken separator adds
 * its own sr-only text.
 */
export function PlanRule({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`h-[18px] w-px shrink-0 bg-current opacity-30 ${className}`} />
}

/**
 * One figure of a readout: a hover target that says what the figure stands
 * for. Without a `tip` it is the bare figure.
 *
 * NOT A TAB STOP (Sam, 2026-09-17). It carried `tabIndex={0}` so a keyboard
 * could reach the tooltip, and the cost was out of all proportion: four of
 * these per row, and on a real board they were 64 of 101 stops — nearly two
 * thirds of the tab order spent on figures that DO nothing when focused, with
 * a 66-book project putting some 260 of them between a reader and the next
 * control. The ACCESSIBLE NAME stays: the sentence is still this element's
 * name in the tree, so a screen reader reading the row still meets it, and
 * the bar's own `aria-label` announces both percentages besides. Only the
 * stop is gone.
 */
function ReadoutFigure({ tip, children }: { tip?: string; children: ReactNode }) {
  if (!tip) return <>{children}</>
  return (
    <AppTooltip content={tip}>
      <span
        aria-label={tip}
        data-testid="plan-readout-figure"
        className="cursor-default rounded-sm underline-offset-[3px] decoration-dotted hover:underline"
      >
        {children}
      </span>
    </AppTooltip>
  )
}
