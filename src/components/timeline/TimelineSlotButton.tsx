// The hover button that offers to fill an empty slot: the pencil in Subtitles
// ("write a line here"), the mic in Target audio ("record here"), and round 8's
// pair in the text table's row strip. (AQU-646)
//
// INVISIBLE until hover. A faint-at-rest version was tried on 2026-08-11 and
// Sam changed his mind back the same day: repeated down a long file even a bare
// icon is noise, and the row already tells you it can be interacted with.
//
// That experiment also broke browser-verify-sub50-52, which asserts this button
// is invisible at rest on the EMPTY-TARGET slot — a shipped surface this
// component reached once it was shared. Lesson worth keeping: when a change
// widens to a control another workflow already uses, run that workflow's pass
// too, not only the new one.
//
// Extracted because several slots use it across three surfaces and the state
// classes are fiddly enough to drift. The PARENT supplies the hover group: wrap
// the slot in `group/slot`.

import type { ReactNode } from "react"

export const SLOT_GROUP = "group/slot"

export function TimelineSlotButton({
  testId,
  label,
  onClick,
  children,
}: {
  testId: string
  /** Tooltip and accessible name — the same sentence. */
  label: string
  onClick(): void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      data-testid={testId}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={[
        "flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground opacity-0 transition-all",
        // The circle is hover-only — on the slot, or on the button itself, or
        // when reached by keyboard.
        "group-hover/slot:bg-background group-hover/slot:opacity-100 group-hover/slot:shadow-sm group-hover/slot:ring-1 group-hover/slot:ring-border",
        "hover:text-foreground",
        "focus-visible:bg-background focus-visible:opacity-100 focus-visible:shadow-sm focus-visible:ring-1 focus-visible:ring-border",
      ].join(" ")}
    >
      {children}
    </button>
  )
}
