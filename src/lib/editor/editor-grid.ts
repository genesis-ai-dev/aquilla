// The editor's one grid template, shared by the column headers, the paragraph
// bar and every row so they can never disagree (they used to be written out
// separately in each place).
//
// [gutter] [source] [Bible columns…] [target] [back-translation]
//
// The gutter is 84px, or 132px with the character gutter (stacked media
// lens). AQU-1101: text tracks are `minmax(0,1fr)`, never a bare `1fr`, so an
// unbreakable token cannot widen its own track and slide the columns out of
// line. With Bible columns the md+ template is variable-length, so it travels
// as a CSS custom property set once on the table (editorGridStyle) and every
// grid reads it through the same class. Phones keep the two-track grid.
//
// `extraTracks` is every text track beyond Source and Target: the Bible
// columns, plus one when the Back-translation column is open. The
// back-translation track is always the LAST one, after Target.
//
// AQU-2678: Target reads the draggable split (editor-split.ts) as
// `--editor-tgt-fr`, and Source and each Bible column read `--editor-rest-fr`;
// both fall back to 1fr (today's equal tracks) when none is set. The
// Back-translation track stays 1fr.

import type { CSSProperties } from "react"

const REST_TRACK = "minmax(0,var(--editor-rest-fr,1fr))"
const TARGET_TRACK = "minmax(0,var(--editor-tgt-fr,1fr))"

export type EditorGridCols =
  | "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[84px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
  | "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[132px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
  | "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[var(--editor-grid-cols)]"

export type EditorHeaderGridCols =
  | "md:grid-cols-[84px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
  | "md:grid-cols-[132px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
  | "md:grid-cols-[var(--editor-grid-cols)]"

export function editorGutterPx(castGutter: boolean): number {
  return castGutter ? 132 : 84
}

/** The rows' (and paragraph bar's) template. */
export function editorGridCols(castGutter: boolean, extraTracks: number): EditorGridCols {
  if (extraTracks > 0) return "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[var(--editor-grid-cols)]"
  return castGutter
    ? "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[132px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
    : "grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[84px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
}

/** The column headers' md+ template (their phone layout is their own). */
export function editorHeaderGridCols(castGutter: boolean, extraTracks: number): EditorHeaderGridCols {
  if (extraTracks > 0) return "md:grid-cols-[var(--editor-grid-cols)]"
  return castGutter
    ? "md:grid-cols-[132px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
    : "md:grid-cols-[84px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
}

/**
 * Set on the table root: the variable-length template the classes above read.
 *
 * With the Back-translation column open (`trailingColumn`) it also carries
 * `--editor-rail-end`: how far the row's action rail sits from the row's end.
 * The rail belongs to the Target column — it holds the row's draft, record and
 * expand controls — and is anchored to the row's end edge, which is Target's
 * edge only while Target is the last track. With one more track after it, the
 * rail moves in by that track's width plus the gap, so it stays over Target.
 */
export function editorGridStyle(castGutter: boolean, extraTracks: number, trailingColumn: boolean | number = false): CSSProperties | undefined {
  if (extraTracks <= 0) return undefined
  const count = extraTracks + 2
  const targetIndex = count - 1 - (trailingColumn ? 1 : 0)
  const tracks = Array.from({ length: count }, (_, index) => {
    if (index < targetIndex) return REST_TRACK
    if (index === targetIndex) return TARGET_TRACK
    return "minmax(0,1fr)"
  }).join(" ")
  const style: Record<string, string> = { "--editor-grid-cols": `${editorGutterPx(castGutter)}px ${tracks}` }
  const trailingTracks = typeof trailingColumn === "number" ? Math.max(0, trailingColumn) : trailingColumn ? 1 : 0
  if (trailingTracks > 0) {
    // The rail is an absolutely positioned grid child starting at the Source
    // track (`col-start-2`), so its containing block — what 100% means here —
    // runs from the Source track's start to the row's padding edge: the
    // `count` text tracks, the 8px gaps between them, and the row's 16px end
    // padding. One track is therefore (100% - 16px - gaps) / count, and the
    // rail ends flush with Target's end edge: the row's padding (16px), the
    // trailing track(s) (Back-translation and/or trailing extension columns),
    // and the 8px gap before each one.
    const trackExpr = `(100% - ${16 + 8 * (count - 1)}px) / ${count}`
    const widthExpr = trailingTracks === 1 ? trackExpr : `${trailingTracks} * (${trackExpr})`
    style["--editor-rail-end"] = `calc(${widthExpr} + ${16 + 8 * trailingTracks}px)`
  }
  return style as CSSProperties
}
