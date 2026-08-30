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
import type { OrderedBy } from "@/lib/parsers/types"

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
  /**
   * The file's own order — `fileOrderedBy(file)`, i.e. `files.meta.orderedBy`
   * with `'sequence'` as the absent default. THIS is the timedness signal, and
   * it is a property of the FILE: `orderedByForFileType` writes `'time'` for
   * vtt/srt/sbv and for media imports, `'sequence'` for every text and document
   * type.
   *
   * Round 1 asked `legacyCellsNeeded` instead, which is not about the file at
   * all — it means "is some media panel open right now". A Chosen subtitle file
   * therefore read as untimed in the text lens (inserts anywhere, no gaps) and
   * lost its controls entirely in the media lens. One flag, both symptoms.
   */
  orderedBy: OrderedBy
  /** `cellStore.hasMediaCells()` — a cell that IS audio. Lens-independent by
   *  construction; see the accessor's note for why that matters. */
  hasMediaCells: boolean
  fileType?: string | null
}

export type CellInsertMode =
  /** Anywhere between rows — an ordinary text file. */
  | "anywhere"
  /** Only into a silence wide enough to hold a line — a file on a clock. */
  | "gaps"
  /** Not offered on this file at all. */
  | "none"

/**
 * WHERE can a cell go in this file? The tier answers WHO; this answers where,
 * and the two are independent.
 *
 * NOTE WHAT IS ABSENT: the timing MODE (Free vs Original, resolveFileTimingMode)
 * and whether footage happens to be linked. Neither belongs here.
 *
 *  - MODE governs the derived TARGET timeline, never placement. Free timing lays
 *    takes end to end on their own clock (buildProgramme), but the SOURCE side's
 *    clock does not stop being real because of it — and placement follows the
 *    source, always. That is also what makes a Free -> Original switch a
 *    non-event: an insert made in Free mode is born with real timings, so it
 *    already has a chip waiting when the mode flips back. The alternative
 *    ("Free means anywhere") strands untimed cells in a timed file, where the
 *    VTT exporter drops them silently.
 *
 *  - FOOTAGE is not required for a gap. A subtitle file's cues are timed whether
 *    or not a video is attached; without one there is simply no known tail, so
 *    `deriveSourceRegions` offers head and between-cue gaps and no trailing one.
 */
export function cellInsertMode(file: CellEditingFile): CellInsertMode {
  // A media cell IS its audio — there is nothing to mint an inserted one from,
  // and removing one would destroy a stretch of the client's source recording
  // behind a confirmation that cannot see it (the imported clip is seeded with
  // the FILE id, so the take inventory reads zero). Sam, 2026-08-30: no client
  // will expect to add or remove cells in an imported MP3. One media cell
  // switches the whole file off, matching the rule the media table already uses.
  if (file.hasMediaCells) return "none"
  // IDML is excluded while its export patches translations into the original
  // package: a removed cell's text still ships unless export learns about
  // deletions, and removing one slice of a split unit makes export throw (both
  // AQU-803 findings).
  if (file.fileType === "idml") return "none"
  // On a clock: only where there is room, and born with real timings.
  if (file.orderedBy === "time") return "gaps"
  return "anywhere"
}
