// AQU-1134: the stacking contract for the two floating controls that share the
// source cell's top-right corner.
//
// Both are absolutely positioned children of the same `relative` source column
// (see EditorTable's `data-editor-cell-surface="source"` div), so they overlap:
//
//   - the SOURCE SELECTION RAIL (view term / ask AI / add to terminology),
//     which pops up over the corner when source text is selected, and
//   - the SOURCE CELL MENU trigger (edit source text / timestamps / insert /
//     remove — the control that replaced the bare edit pencil in AQU-1068).
//
// The rail is transient and is the thing the user just summoned by selecting
// text, so it MUST paint in front of the menu trigger. The menu trigger is
// always-present chrome and yields to it.
//
// Why this lives in one module instead of two Tailwind classes: the reported
// bug was not a wrong z-index, it was EQUAL ones. The rail and the pencil were
// both `z-10`, so neither won on z-index and the painting order fell through to
// DOM order — the menu renders after the rail, so the menu covered it. Two
// magic numbers in two files (SourceSelectionToolbar.tsx and EditorTable.tsx)
// tied together only by a code comment is exactly how they drifted into a tie
// the first time. Naming the layers once, with a test that asserts the
// ordering, is the regression guard.
//
// The class strings are written out in full so Tailwind's source scanner sees
// them; keep them literal (never build them by interpolation).

/** Paint order within the source cell's corner. Higher paints in front. */
export const SOURCE_CELL_LAYERS = {
  /** Always-present chrome: the source cell's menu trigger. */
  cellMenu: 10,
  /** Transient, user-summoned: the term action rail. Must sit above the menu. */
  selectionRail: 20,
} as const

/** Tailwind class for the source cell menu trigger's layer. */
export const SOURCE_CELL_MENU_Z = "z-10"

/** Tailwind class for the source selection rail's layer. */
export const SOURCE_SELECTION_RAIL_Z = "z-20"

/** The `z-N` class for a layer, so a test can tie the classes to the numbers. */
export function zClassForLayer(layer: number): string {
  return `z-${layer}`
}
