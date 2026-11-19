// The button that offers to fill an empty slot on a track: the pencil in
// Subtitles ("write a line here") and the mic in Target audio ("record here").
// (AQU-646)
//
// INVISIBLE until the pointer is on its slot. A faint-at-rest version was tried
// on 2026-08-11 and Sam changed his mind back the same day: repeated down a long
// track even a bare icon is noise.
//
// ROUND 9 — WHY THIS IS NOT CSS `:hover` ANY MORE.
// Sam hit six mic buttons lit at once at 0.2× zoom with the pointer on none of
// them. The reveal used `group-hover/slot`, and WebKit does not re-evaluate
// `:hover` when content moves UNDER a stationary pointer — so every slot the
// pointer had passed over while the track scrolled or zoomed stayed lit until
// the mouse happened to cross it again. The lane now owns the answer to "which
// slot is the pointer on", as a single piece of state, which makes
// six-lit-at-once structurally impossible rather than merely unlikely. Keyboard
// reach stays on CSS (`focus-visible`), where no such staleness exists.
//
// The `group/slot` class the wrappers used to carry is gone with it — nothing
// keys off it any more, and a class that looks load-bearing but is not is worse
// than no class. The lane's `useHotSlot` (slot-hover.ts) is the whole mechanism.

import type { MouseEvent, ReactNode } from "react"

import { AppTooltip } from "@/components/ui/tooltip"
import { SLOT_BUTTON_MAX_PX } from "@/lib/timeline/row-metrics"

export function TimelineSlotButton({
  testId,
  label,
  hot,
  sizePx = SLOT_BUTTON_MAX_PX,
  pressed,
  busy = false,
  onClick,
  children,
}: {
  testId: string
  /** Tooltip and accessible name — the same sentence. */
  label: string
  /** The lane says the pointer is on this slot. See the header for why the
   *  browser is not asked. */
  hot: boolean
  /** The button's side, from `slotButtonPx` — the lane knows how tall its
   *  rows are and how wide this slot is, and this button does not. Defaults to
   *  the size it was hard-coded to before the vertical zoom existed. */
  sizePx?: number
  /** AQU-2663: a toggle's state (Make speech's "this line is picked"). Absent:
   *  not a toggle, no `aria-pressed`. */
  pressed?: boolean
  /** AQU-2663: its work is running. `aria-disabled` and the click is ignored,
   *  NOT native `disabled`: AppTooltip turns a disabled child into its "why is
   *  this unavailable" note. The caller swaps the glyph and the label. */
  busy?: boolean
  /** Handed the click, for callers that read Shift/Ctrl/⌘. */
  onClick(e: MouseEvent<HTMLButtonElement>): void
  children: ReactNode
}) {
  return (
    <AppTooltip content={label}>
      <button
        type="button"
        aria-label={label}
        data-testid={testId}
        data-hot={hot ? "true" : undefined}
        data-busy={busy ? "true" : undefined}
        aria-pressed={pressed}
        aria-disabled={busy ? true : undefined}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (busy) return
          onClick(e)
        }}
        style={{ width: `${sizePx}px`, height: `${sizePx}px` }}
        className={[
          "flex shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0",
          // The button arrives with the pointer, not before. No fade: the
          // slot is already under the pointer, so a transition only lags it.
          hot ? "bg-background opacity-100 shadow-sm ring-1 ring-border" : "",
          "hover:text-foreground aria-disabled:cursor-progress",
          // AQU-2663: a toggle's ON state (a line picked for Make speech) is
          // seen, not only announced. Inert on buttons that pass no `pressed`.
          "aria-pressed:text-primary aria-pressed:ring-primary/50",
          "focus-visible:bg-background focus-visible:opacity-100 focus-visible:shadow-sm focus-visible:ring-1 focus-visible:ring-border",
        ].join(" ")}
      >
        {children}
      </button>
    </AppTooltip>
  )
}
