// The shared cell-card className, used by both the translation editor
// (EditorTable) and the Voice Studio cell list so the two modes render the
// same neumorphic card. Kept in a plain .ts module (no component exports) so
// React Fast Refresh stays happy.

import { cn } from "@/lib/utils"

export interface CellCardStateClasses {
  /** Carved-in well (expanded / active). */
  inset?: boolean
  /** Lifted off the surface (e.g. currently playing). */
  raised?: boolean
  /** Pressed-in with a gold ring (multi-selected). */
  selected?: boolean
  /** Soft blue ring (open comments). */
  comments?: boolean
  /** Gold ring + inset (active cue / current line). */
  active?: boolean
  /** Pulsing primary ring (work in progress for this cell). */
  busy?: boolean
  /** Destructive ring (errored). */
  error?: boolean
  /** Drop-target highlight. */
  dropTarget?: boolean
}

/**
 * The shared cell-card className. `neu-flat rounded-2xl` is the base surface;
 * the booleans layer the same shadow/ring states the editor uses so a Voice
 * Studio row is visually indistinguishable from a translate row.
 */
export function cellCardClassName(states: CellCardStateClasses = {}): string {
  return cn(
    "group neu-flat relative rounded-2xl transition-shadow duration-200 ease-out hover:shadow-neu",
    states.inset && "shadow-neu-inset",
    states.raised && "shadow-neu",
    states.selected && "shadow-neu-pressed ring-1 ring-primary/40 ring-inset",
    states.comments && "ring-1 ring-blue-400/50 ring-inset",
    states.active && "shadow-neu-inset ring-1 ring-primary/40 ring-inset",
    states.busy && "shadow-neu-inset ring-2 ring-primary/50 ring-inset animate-pulse",
    states.error && "shadow-neu-inset ring-2 ring-destructive/50 ring-inset",
    states.dropTarget && "shadow-neu-inset ring-2 ring-primary/60 ring-inset",
  )
}
