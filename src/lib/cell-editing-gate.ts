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
import { isUserAddedLine } from "@/lib/timeline/user-line-origin"
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

/**
 * ...and the OTHER half of that clause: which rows count as imported.
 *
 * One signal, the `aquillaOrigin` marker the create event writes — the same
 * question the server's `isUserInsertedCell` asks, so the two can never
 * disagree about whose content a row is.
 *
 * AQU-1068 review: the two surfaces each carried their own version of this and
 * both added "...and it is still EMPTY", which turned a line you added into
 * imported content the moment you typed or recorded into it. Matthew hit it by
 * recording audio on a new cell and finding he could no longer remove it,
 * while the server would have accepted that delete. The emptiness test answers
 * a different question — whether the removal needs a confirmation dialog — and
 * still does, in `buildCellRemovalInventory`.
 *
 * It lives here so there is exactly one definition for the table and the
 * timeline to share.
 */
export function isImportedRow(cell: { metadata?: Record<string, unknown> | null }): boolean {
  return !isUserAddedLine(cell)
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
  /** An imported line, and this person is not a maintainer. */
  | "maintainerOnly"

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
  /** False for a line somebody added here and left empty — the take-back case. */
  isImported: boolean
  /** Whether this viewer may remove an imported line (maintainer and up). */
  canRemoveImported: boolean
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
  // Taking back a line somebody added here is always allowed at this point;
  // removing one the client imported is maintainer work, whatever the tier.
  const remove = input.isImported && !input.canRemoveImported ? "maintainerOnly" : null
  return { above, below, remove }
}
