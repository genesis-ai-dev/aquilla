// The hover button that offers to fill an empty slot on a track: the pencil in
// Subtitles ("write a line here"), the mic in Target audio ("record here").
// (AQU-646)
//
// Faint bare icon at rest, so you can see the offer without hunting for it;
// the circle only arrives under the pointer (Sam, 2026-08-11). At rest the
// chrome would be three rings of noise repeated down a long file — the icon
// alone is enough to say "something can go here".
//
// Extracted because three slots use it across two lanes and the state classes
// are fiddly enough to drift. The PARENT supplies the hover group: wrap the
// slot in `group/slot`.

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
        "flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground opacity-30 transition-all",
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
