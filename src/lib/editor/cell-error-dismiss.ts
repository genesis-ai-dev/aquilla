// AQU-913: decide whether a row-level blur should dismiss the cell's visible AI
// error messages (the inline AI-draft error under the target editor, and the
// back-translation error in the expanded panel).
//
// Before this, the ONLY thing that cleared a cell's error was starting a new
// draft attempt on that same cell — so a failure stuck to the row forever, and
// the per-cell `completing: "error"` status stayed set alongside it.
//
// The rule is "focus left the cell": moving to another cell, tabbing away, or
// clicking dead space on the page dismisses the error. Staying anywhere inside
// the row keeps it. The wrinkle is the error's OWN info popover — it renders
// through a portal at the document root, so `row.contains(next)` is false even
// though the user is plainly still reading this cell's error. Opening it must
// not count as leaving, hence the popover-portal exemption below.

/** Popup surfaces that are logically part of the row even though the portal
 *  puts their DOM outside it. `data-slot="popover-content"` is stamped by
 *  `components/ui/popover.tsx` on every popover popup, which is what
 *  `CellAiStatusPopover` (the error's info button) renders into. */
const PORTALED_ROW_SURFACE = '[data-slot="popover-content"]'

/**
 * True when a blur-capture on the row should clear this cell's error state.
 *
 * @param row  the row element (`rowRef.current`) — null when the row has
 *             already unmounted, in which case there is nothing to dismiss.
 * @param next the `relatedTarget` of the focus event: the node about to
 *             receive focus, or null when focus went nowhere focusable
 *             (a click on dead space) — which counts as leaving the cell.
 */
export function shouldDismissCellErrorsOnBlur(
  row: Element | null,
  next: Node | null,
): boolean {
  if (!row) return false
  if (!next) return true
  // Focus stayed inside the row itself — typing in the editor, using the rail.
  if (row.contains(next)) return false
  // Focus went into a portaled popup belonging to this row's own affordances
  // (notably the error's info popover). Still "within the cell" for our
  // purposes; the popup closing returns focus to its in-row trigger.
  return !closestElement(next)?.closest(PORTALED_ROW_SURFACE)
}

/** `closest` lives on Element, but `relatedTarget` is typed as a Node — a text
 *  node can never receive focus in practice, but narrowing keeps this total. */
function closestElement(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}
