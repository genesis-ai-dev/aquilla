// Row geometry for the timeline's vertical zoom: how tall a track row is, how
// much air sits above and below its chips, and where each piece of chip
// furniture stops fitting. (AQU-646 stage 3)
//
// Deliberately NOT in scale.ts, whose header declares it pure time<->pixel math
// and which has no business owning Tailwind class strings. The two modules are
// siblings, not layers: scale.ts answers "how wide is a second", this one
// answers "how tall is a track".

/** The compact band Sam asked for: a coloured stripe with no words in it. */
export const ROW_H_MIN = 24
/** Today's row, to the pixel — 10 pad + 46 chip + 10 pad. Anyone who never
 *  touches the new control must land here and see no change at all. */
export const ROW_H_DEFAULT = 66
export const ROW_H_MAX = 160

/** Today's `top-2.5`. */
export const CHIP_PAD_MAX = 10
/** Below this the air between two lanes stops reading as a gap and the rows
 *  start to look like one striped block; at the compact end the chip is
 *  supposed to nearly fill its row, but it must still not touch the border-b. */
export const CHIP_PAD_MIN = 3

/**
 * The air above (and below) a chip in a row this tall.
 *
 * A straight ramp between the two anchors, the same shape as `chipRadiusPx` and
 * for the same reason: the row height is driven by a stepper the user can hold
 * down, so a threshold anywhere in here would make every chip jump. Constant
 * padding was the first idea and it is wrong at both ends — 10px of air out of a
 * 24px row leaves a 4px sliver, and 10px out of 160 leaves the tall rows looking
 * under-padded next to their own chips.
 *
 * PINNED at the default: `chipPadPx(ROW_H_DEFAULT) === 10`, exactly, because
 * this number and `chipHeightPx` between them have to reproduce the shipped
 * 10-46-10 row to the pixel. See row-metrics.test.ts.
 *
 * Integral, like everything else here — a fractional pad puts the chip on a
 * half pixel and blurs its top border.
 */
export function chipPadPx(rowH: number): number {
  if (!Number.isFinite(rowH)) return CHIP_PAD_MAX
  if (rowH >= ROW_H_DEFAULT) return CHIP_PAD_MAX
  if (rowH <= ROW_H_MIN) return CHIP_PAD_MIN
  const t = (rowH - ROW_H_MIN) / (ROW_H_DEFAULT - ROW_H_MIN)
  return Math.round(CHIP_PAD_MIN + (CHIP_PAD_MAX - CHIP_PAD_MIN) * t)
}

/**
 * The chip height that fills a row this tall. `chipHeightPx(ROW_H_DEFAULT)` is
 * 46 — the value hard-coded at five chip sites before this module existed.
 *
 * Floored at 1px rather than 0: a zero-height chip is invisible, and an
 * invisible chip on a timeline reads as lost data rather than as a zoom level.
 * A non-finite row height falls back to the shipped row for the same reason
 * `chipRadiusPx` answers 0 for one — never a NaN in a style attribute.
 */
export function chipHeightPx(rowH: number): number {
  if (!Number.isFinite(rowH)) return ROW_H_DEFAULT - 2 * CHIP_PAD_MAX
  return Math.max(1, Math.round(rowH) - 2 * chipPadPx(rowH))
}

/**
 * The stored/stepped row height, made safe to render.
 *
 * INTEGERS ARE MANDATORY, which is what the `Math.round` is for and why it is
 * not merely tidiness: every lane and every gutter label draws a 1px `border-b`,
 * and a row on a half pixel makes the browser blend that border across two
 * device pixels — four fuzzy grey lines stacked down the timeline. The same
 * applies to the chips, which is why `chipPadPx` rounds too.
 */
export function clampRowHeight(n: number): number {
  if (!Number.isFinite(n)) return ROW_H_DEFAULT
  return Math.round(Math.min(ROW_H_MAX, Math.max(ROW_H_MIN, n)))
}

// The degradation gates. These mirror the WIDTH gates that already live in
// TimelineCard (MIN_CARD_TEXT_PX, MIN_CARD_GRIP_PX, ...) — same idea on the
// other axis: a chip drops what no longer fits instead of clipping it. They sit
// here rather than beside their width counterparts because the height they are
// compared against is produced here, and because three different components
// (TimelineCard, TargetAudioLane, the slot buttons) test against the same
// numbers.

/** Below this the second line — timecode/meta — has nowhere to go. */
export const MIN_CHIP_META_H_PX = 30
/** Below this the label goes too and the chip is a bare coloured band. This is
 *  the promise "compact band" makes: `chipHeightPx(ROW_H_MIN)` is under it. */
export const MIN_CHIP_LABEL_H_PX = 22
/** Below this the remove button is taller than the chip that owns it. */
export const MIN_CHIP_REMOVE_H_PX = 26
/** Below this the resize grips are a target smaller than the pointer. */
export const MIN_CHIP_GRIP_H_PX = 18
/** Below this the `h-7` hover circle would spill out of its row and be clicked
 *  through the neighbouring lane. */
export const MIN_SLOT_BUTTON_H_PX = 28

// The GUTTER's gates. Stage 3 taught the chips to shed furniture as their rows
// shrank and left the labels beside them rendering at full size into a clip —
// so at the compact end the names printed over each other and the mute buttons
// straddled two rows (Sam, screenshot, 2026-08-13). These are compared against
// the ROW height, not the chip height: a label fills its row rather than
// floating inside it with padding, so there is no chip box to measure.

/** Below this the sublabel ("original speech", "takes · generated") goes. Two
 *  stacked lines need about 30px of type — a 12px name over a 10px sub with a
 *  2px gap — and a row that gives them 34 has them touching its borders top and
 *  bottom. The sub is the first thing to drop because it is the only decorative
 *  line in the row: it names what the track already says it is. */
export const MIN_LABEL_SUB_H_PX = 40

/** Below this the speaker button renders compact. At full size it is a 24px box
 *  (4px padding, a 14px glyph, 1px border each side), which in a 28px row
 *  leaves 2px of air and in a 24px row leaves none at all — that is the button
 *  straddling its neighbours in Sam's screenshot. It SHRINKS rather than
 *  disappearing: muting a track is the one thing you reach for while zoomed
 *  out to see many of them at once. */
export const MIN_SPEAKER_FULL_H_PX = 34

// The row/chip box classes, in one place, so the 10-46-10 numbers are not
// re-typed at nine sites (four row containers, five chip boxes).
//
// THE FALLBACKS ARE LOAD-BEARING. The custom properties are set on the
// `tl-editor` root, but a TimelineCard rendered on its own — which is exactly
// what TimelineCard.test.tsx and the lane tests do — has no such ancestor and
// would resolve `var(--tl-chip-h)` to nothing. With the fallbacks it resolves to
// today's 46px, so the whole swap needs no setup change in any existing test.

export const TL_ROW_H_CLASS = "h-[var(--tl-row-h,66px)]"
export const TL_CHIP_BOX_CLASS = "top-[var(--tl-chip-top,10px)] h-[var(--tl-chip-h,46px)]"
