// AQU-1068: who is offered the add/remove controls, and on which files.
//
// Pulled out of ProjectWorkspace because it is the rule deciding who sees a
// DESTRUCTIVE affordance, and that component has no test harness — the rest of
// its gating is verified in a browser, which is the wrong instrument for a
// truth table. The workspace keeps the wiring; this keeps the reasoning.
//
// Two questions, deliberately separate:
//   canEditCells  — MAY this person restructure this project at all?
//   cellInsertMode — and does THIS FILE take a cell, and where?
//
// The tier answers the first and only the first. The file's own nature answers
// the second: a text file takes a cell anywhere, a subtitle file only in a gap
// wide enough to hold one, and some files take none at all. That split is what
// keeps the setting readable — a project admin is never asked about timings.

import { ROLE } from "@/lib/frontier/roles"

export interface CellEditingSubject {
  /** The tier's role level, or null when the project has not opted in. */
  floor: number | null
  /** The viewer's level on this project, null when they have none. */
  roleLevel: number | null
  /** The static floor still applies underneath the tier — a viewer is refused
   *  at the most permissive tier. Pass `canPerform("source.cell.create", …)`. */
  staticFloorPasses: boolean
  /**
   * True when this project's source is not its own to restructure: a live
   * source link mirrors it from upstream, and a DCS pin has a repair path that
   * treats local source divergence as damage and overwrites it. Either way a
   * cell added or removed here would be silently undone. Loading counts as
   * mirrored — default-locked can never let a doomed edit through.
   */
  sourceIsMirrored: boolean
}

export function canEditCells(s: CellEditingSubject): boolean {
  if (s.floor == null) return false
  if (s.sourceIsMirrored) return false
  if (!s.staticFloorPasses) return false
  return (s.roleLevel ?? 0) >= s.floor
}

/**
 * ...and the second gate, on removal only. An IMPORTED cell is the client's own
 * work, so taking one back needs MAINTAINER whatever tier is configured; below
 * that rank a person only ever removes a line somebody added by hand here.
 * Mirrors the clause authorize.ts applies per event.
 */
export function canRemoveImportedCells(s: CellEditingSubject): boolean {
  return canEditCells(s) && (s.roleLevel ?? 0) >= ROLE.MAINTAINER
}

export interface CellEditingFile {
  /** Present when footage is attached — the file is on a clock. */
  hasMedia: boolean
  /** The media lens derives timed rows for this file. */
  isTimed: boolean
  /** Cells that ARE audio clips (medium 'media'), not text with audio beside it. */
  hasChunkedAudioCells: boolean
  fileType?: string | null
}

export type CellInsertMode =
  /** Anywhere between rows — an ordinary text file. */
  | "anywhere"
  /** Only into a silence wide enough to hold a line — a subtitle file. */
  | "gaps"
  /** Not offered on this file at all. */
  | "none"

export function cellInsertMode(file: CellEditingFile): CellInsertMode {
  // A chunked-audio file is excluded from both paths: an inserted row there
  // would be an audio cell with no audio, which is its own ticket.
  if (file.hasChunkedAudioCells) return "none"
  // IDML is excluded from this slice and says so on the row. Its cells carry a
  // packaged layout the editor renders read-only, and export patches
  // translations back into the original package — so a removed cell's text
  // still ships unless export learns about deletions, and removing one slice
  // of a split unit makes export throw (both AQU-803 findings).
  if (file.fileType === "idml") return "none"
  if (file.hasMedia && file.isTimed) return "gaps"
  if (file.hasMedia || file.isTimed) return "none"
  return "anywhere"
}
