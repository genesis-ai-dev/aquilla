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
//
// SINCE 2026-09-09 THIS MODULE IS THE TIER'S ENFORCEMENT, not a preview of the
// server's. The sync perimeter stopped checking `cellEditingFloor` for inserts
// because doing so silently refused audio-cue re-import, DCS upstream import
// and diarization — three flows that emit the same event kinds through the
// user's own outbox. The tier stops accidents, not attackers, so it lives where
// the buttons are drawn.
//
// REMOVING AN IMPORTED LINE FOLLOWS THE TIER TOO (AQU-2632). It used to need
// Maintainer whatever the tier said, which made "Project lead" in the setting
// a promise that was false for every line of an imported Scripture file. The
// server's one remaining removal rule now reads the same tier
// (sync-worker/src/events/cell-removal-authority.ts) — keep the two in step.

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
}

export type CellPlacement =
  /** Anywhere between rows — an ordinary text file has room everywhere. */
  | "anywhere"
  /** Only into a silence wide enough to hold a line — a file on a clock. */
  | "gaps"

/**
 * WHERE can a cell go in this file? The tier answers WHO; this answers where,
 * and the two are independent.
 *
 * THERE IS NO "none" ANY MORE (round 3). A file that cannot take a cell used to
 * be answered here, which meant the controls simply did not render — and Sam,
 * having switched the setting on, could not tell whether the feature was broken
 * or merely inapplicable. Inapplicability is now a per-ROW fact with a reason
 * attached (`rowActionAvailability`), so the control appears and explains
 * itself. This function only decides which shape of "where" the file uses.
 *
 * NOTE WHAT IS ABSENT: the timing MODE (Free vs Original) and whether footage
 * happens to be linked. Neither belongs here.
 *
 *  - MODE governs the derived TARGET timeline, never placement. Free timing lays
 *    takes end to end on their own clock (buildProgramme), but the SOURCE side's
 *    clock does not stop being real because of it — and placement follows the
 *    source, always. That is also what makes a Free -> Original switch a
 *    non-event: an insert made in Free mode is born with real timings, so it
 *    already has a chip waiting when the mode flips back.
 *
 *  - FOOTAGE is not required for a gap. A subtitle file's cues are timed whether
 *    or not a video is attached; without one there is simply no known tail, so
 *    `deriveSourceRegions` offers head and between-cue gaps and no trailing one.
 */
export function cellPlacement(file: CellEditingFile): CellPlacement {
  return file.orderedBy === "time" ? "gaps" : "anywhere"
}

/**
 * Why an action is unavailable on one row. A closed set on purpose: the whole
 * point of round 3 is that every surface asks the same question and gets an
 * answer from the same short list, rather than each growing its own special
 * cases.
 */
export type RowActionReason =
  /** The row IS audio — nothing to mint an inserted one from, and removing it
   *  would destroy a stretch of the client's recording. */
  | "media"
  /** IDML keeps its original layout; export patches translations back into the
   *  package, so a cell born here has nowhere to go (AQU-803). */
  | "idml"
  /** A timed file with no silence wide enough on that side. */
  | "noRoom"

export interface RowActionInput {
  placement: CellPlacement
  /** `cell.medium === "media"` — the row is a piece of imported audio. */
  isMediaCell: boolean
  /** The cell carries an IDML locator (same check the source pencil makes). */
  isIdmlCell: boolean
  /** Timed files only: is there a silence above / below this row wide enough?
   *  Ignored when placement is "anywhere", where there is always room. */
  gapAbove: boolean
  gapBelow: boolean
}

export interface RowActionAvailability {
  /** `null` means available; a reason means render it, disabled, and say why. */
  above: RowActionReason | null
  below: RowActionReason | null
  remove: RowActionReason | null
}

/**
 * THE per-row truth table — one rule, asked the same way by every surface.
 *
 * Reasons are ordered by how fundamental they are: a row that IS audio, or that
 * belongs to a packaged layout, cannot take or lose a cell for reasons that have
 * nothing to do with clocks or clearance, so those answer first.
 */
export function rowActionAvailability(input: RowActionInput): RowActionAvailability {
  const structural: RowActionReason | null = input.isMediaCell
    ? "media"
    : input.isIdmlCell
      ? "idml"
      : null
  if (structural) return { above: structural, below: structural, remove: structural }

  // On a clock, a cell needs a silence to fit into. Off one, there is always
  // room between two rows.
  const above = input.placement === "gaps" && !input.gapAbove ? "noRoom" : null
  const below = input.placement === "gaps" && !input.gapBelow ? "noRoom" : null
  // Who may remove is the tier's question and was answered before the control
  // was drawn (AQU-2632: imported lines follow it too), so by here a row can
  // be removed unless it is audio or a packaged layout, handled above.
  return { above, below, remove: null }
}
