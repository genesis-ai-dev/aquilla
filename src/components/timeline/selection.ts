// AQU-928: the timeline's SECTION SELECTION — one primary chip plus any
// number of extra chips picked with a modifier.
//
// Selection used to be a single `selectedId`, which made "transcribe the
// source for these sections" impossible to express: the only per-section
// transcribe lived inside one clip's detail pane, so the visible choice was
// all-or-nothing. The primary stays exactly what it was — the chip the strip
// describes, the media cursor points at, and playback starts from — and the
// extras ride alongside it purely as a batch scope.
//
// Kept as pure functions (no React) so the modifier rules are unit-testable
// without a timeline: TimelineEditor holds the two pieces of state and defers
// every decision about them to `applySelect`.

/** Which modifier the user held while clicking a chip. */
export interface SelectMods {
  /** ⌘/Ctrl-click — add this section to the selection, or drop it if it's
   *  already in. */
  toggle?: boolean
  /** Shift-click — extend the selection from the primary chip to this one. */
  range?: boolean
}

export interface TimelineSelection {
  /** The "current" chip: drives the chip strip, media cursor, and playback. */
  primaryId: string | null
  /** Sections selected in addition to the primary. Never contains the
   *  primary, and never contains duplicates. */
  extraIds: readonly string[]
}

export const EMPTY_SELECTION: TimelineSelection = { primaryId: null, extraIds: [] }

/** The modifiers of a pointer/mouse event, or undefined for a plain click.
 *  `undefined` (rather than an all-false object) is what tells the card that
 *  this was a plain click and may therefore also seek playback. */
export function readSelectMods(
  e: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey">,
): SelectMods | undefined {
  // Shift wins when both are held: a range is the more specific intent, and
  // ⌘+Shift-click on a range would otherwise be ambiguous.
  if (e.shiftKey) return { range: true }
  if (e.metaKey || e.ctrlKey) return { toggle: true }
  return undefined
}

/**
 * Fold a chip click into the selection.
 *
 * - plain click → that section alone becomes the selection;
 * - toggle → add/remove the section, leaving the primary where it is (removing
 *   the primary promotes the next selected section, so the chip strip never
 *   blanks out while other sections stay selected);
 * - range → every section from the primary to this one, primary unchanged.
 *
 * `orderedIds` is the file's cell order (the same order the text table shows),
 * which is what a range means to the user. Ids it doesn't know about fall back
 * to toggle rather than silently selecting nothing.
 */
export function applySelect(
  current: TimelineSelection,
  cellId: string,
  mods: SelectMods | undefined,
  orderedIds: readonly string[],
): TimelineSelection {
  if (mods?.range) {
    if (current.primaryId == null) return { primaryId: cellId, extraIds: [] }
    const anchor = orderedIds.indexOf(current.primaryId)
    const target = orderedIds.indexOf(cellId)
    if (anchor < 0 || target < 0) return applySelect(current, cellId, { toggle: true }, orderedIds)
    const lo = Math.min(anchor, target)
    const hi = Math.max(anchor, target)
    return {
      primaryId: current.primaryId,
      extraIds: orderedIds.slice(lo, hi + 1).filter((id) => id !== current.primaryId),
    }
  }

  if (mods?.toggle) {
    const withoutId = current.extraIds.filter((id) => id !== cellId)
    if (cellId === current.primaryId) {
      const [next, ...rest] = withoutId
      return next ? { primaryId: next, extraIds: rest } : EMPTY_SELECTION
    }
    // Was an extra → the click removes it.
    if (withoutId.length !== current.extraIds.length) {
      return { primaryId: current.primaryId, extraIds: withoutId }
    }
    // Nothing selected yet: the first ⌘-click behaves like a plain one.
    if (current.primaryId == null) return { primaryId: cellId, extraIds: [] }
    return { primaryId: current.primaryId, extraIds: [...current.extraIds, cellId] }
  }

  return { primaryId: cellId, extraIds: [] }
}

/**
 * The selected section ids in file order.
 *
 * Deliberately STRICT about `orderedIds`: an id the file no longer contains
 * (the user switched files, or a section was deleted while selected) drops out
 * here rather than lingering in a batch scope the user can no longer see.
 */
export function selectedIdsInOrder(
  selection: TimelineSelection,
  orderedIds: readonly string[],
): string[] {
  const chosen = new Set<string>(selection.extraIds)
  if (selection.primaryId) chosen.add(selection.primaryId)
  if (chosen.size === 0) return []
  return orderedIds.filter((id) => chosen.has(id))
}
