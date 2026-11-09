// The editor's one grid template, shared by the column headers, the paragraph
// bar and every row so they can never disagree (they used to be written out
// separately in each place).
//
// [gutter] [source] [Bible columns…] [target]
//
// The gutter is 84px, or 132px with the character gutter (stacked media
// lens). AQU-1101: text tracks are `minmax(0,1fr)`, never a bare `1fr`, so an
// unbreakable token cannot widen its own track and slide the columns out of
// line. With Bible columns the md+ template is variable-length, so it travels
// as a CSS custom property set once on the table (editorGridStyle) and every
// grid reads it through the same class. Phones keep the two-track grid.

import type { CSSProperties } from "react"

export type EditorGridCols =
  | "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)]"
  | "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[132px_minmax(0,1fr)_minmax(0,1fr)]"
  | "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[var(--editor-grid-cols)]"

export type EditorHeaderGridCols =
  | "md:grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)]"
  | "md:grid-cols-[132px_minmax(0,1fr)_minmax(0,1fr)]"
  | "md:grid-cols-[var(--editor-grid-cols)]"

export function editorGutterPx(castGutter: boolean): number {
  return castGutter ? 132 : 84
}

/** The rows' (and paragraph bar's) template. */
export function editorGridCols(castGutter: boolean, bibleColumns: number): EditorGridCols {
  if (bibleColumns > 0) return "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[var(--editor-grid-cols)]"
  return castGutter
    ? "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[132px_minmax(0,1fr)_minmax(0,1fr)]"
    : "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)]"
}

/** The column headers' md+ template (their phone layout is their own). */
export function editorHeaderGridCols(castGutter: boolean, bibleColumns: number): EditorHeaderGridCols {
  if (bibleColumns > 0) return "md:grid-cols-[var(--editor-grid-cols)]"
  return castGutter
    ? "md:grid-cols-[132px_minmax(0,1fr)_minmax(0,1fr)]"
    : "md:grid-cols-[84px_minmax(0,1fr)_minmax(0,1fr)]"
}

/** Set on the table root: the variable-length template the classes above read. */
export function editorGridStyle(castGutter: boolean, bibleColumns: number): CSSProperties | undefined {
  if (bibleColumns <= 0) return undefined
  const tracks = Array.from({ length: bibleColumns + 2 }, () => "minmax(0,1fr)").join(" ")
  return { "--editor-grid-cols": `${editorGutterPx(castGutter)}px ${tracks}` } as CSSProperties
}
