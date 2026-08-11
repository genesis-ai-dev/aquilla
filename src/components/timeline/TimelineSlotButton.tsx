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

import type { ReactNode } from "react"

export function TimelineSlotButton({
  testId,
  label,
  hot,
  onClick,
  children,
}: {
  testId: string
  /** Tooltip and accessible name — the same sentence. */
  label: string
  /** The lane says the pointer is on this slot. See the header for why the
   *  browser is not asked. */
  hot: boolean
  onClick(): void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      data-hot={hot ? "true" : undefined}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={[
        "flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all",
        // The circle arrives with the pointer, not before.
        hot ? "bg-background opacity-100 shadow-sm ring-1 ring-border" : "",
        "hover:text-foreground",
        "focus-visible:bg-background focus-visible:opacity-100 focus-visible:shadow-sm focus-visible:ring-1 focus-visible:ring-border",
      ].join(" ")}
    >
      {children}
    </button>
  )
}
