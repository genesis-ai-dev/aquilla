// What the "Set a new milestone…" dialog needs to know about a file. (AQU-2308)
//
// Kept apart from `user-milestone-spans.ts` on purpose: that module answers
// what a range DOES to the file's divisions (and what to refuse), which the
// navigator derivation and the dialog both have to agree on. This one is only
// about presenting the choice — the rows each picker lists, which row a search
// matches, and which edges the dialog opens with. Nothing here is consulted at
// read time, so none of it can change what the navigator shows.
//
// Pure: no React, no i18n, no store. The pickers themselves are the house
// `SearchSelect` — the primitive every list that grows with the data uses — so
// what is left here is the data it lists and the arithmetic behind the two
// edges, which is the part worth a unit test rather than a click.

import type { ImportMilestone, ImportMilestoneKind } from "../../../shared/import-contract"

/**
 * How much of a cell's text a picker row shows.
 *
 * Capped here rather than by CSS truncation alone: the pickers hold one row
 * per cell in the file, and carrying whole verses through a `useMemo` for a
 * list that only ever shows the opening words is pure waste.
 */
export const MILESTONE_PREVIEW_LENGTH = 90

/** One row of a cell picker, in the file's display order. */
export interface MilestoneDraftCell {
  cellId: string
  /** 1-based position in the file's display order — what "line 50" means. */
  lineNumber: number
  /**
   * The reference the FILE supplies for this cell ("MRK 4:35"), or null when it
   * has none. Decided by the caller, which is also where the one existing rule
   * for "is this context a reference or a timecode" lives.
   */
  reference: string | null
  /** The cell's opening words, capped at MILESTONE_PREVIEW_LENGTH. */
  preview: string
}

/** What the caller reads out of the store for one cell. */
export interface MilestoneDraftCellSource {
  reference?: string | null
  text?: string | null
}

/**
 * The picker rows for one file.
 *
 * `order` is the display order — the same list the navigator derives its
 * divisions from — so a row's `lineNumber` is the number a person is reading
 * off the screen, and index arithmetic against it is index arithmetic against
 * the stored anchors.
 */
export function milestoneDraftCells(
  order: readonly string[],
  read: (cellId: string) => MilestoneDraftCellSource | null | undefined,
): MilestoneDraftCell[] {
  return order.map((cellId, index) => {
    const source = read(cellId)
    const reference = source?.reference?.trim()
    const text = source?.text?.trim() ?? ""
    return {
      cellId,
      lineNumber: index + 1,
      reference: reference ? reference : null,
      preview: text.length > MILESTONE_PREVIEW_LENGTH
        ? `${text.slice(0, MILESTONE_PREVIEW_LENGTH).trimEnd()}…`
        : text,
    }
  })
}

/**
 * The compact badge a picker row leads with: the file's own reference when it
 * has one, otherwise the line number.
 *
 * A file either labels its cells or it does not, so in practice one file's rows
 * all read one way — which is what makes "line 70" and "MRK 4:41" both
 * unambiguous instructions in the dialog.
 */
export function milestoneDraftBadge(cell: MilestoneDraftCell): string {
  return cell.reference ?? String(cell.lineNumber)
}

/**
 * The one line a picker row reads, and the text its search matches.
 *
 * Badge first, then the opening words, because that is the order a person
 * names a line in: "line 50", "Mark 4:35" — the words are how they confirm
 * they picked the right one. It is also what the closed picker shows, so the
 * dialog says which lines the range runs between without being reopened.
 */
export function milestoneDraftLabel(cell: MilestoneDraftCell): string {
  const badge = milestoneDraftBadge(cell)
  return cell.preview ? `${badge} \u00b7 ${cell.preview}` : badge
}

/**
 * The division each cell in `order` belongs to, aligned with `order`.
 *
 * Built from the navigation entries the store already derived rather than
 * re-deriving: the dialog must refuse exactly what the navigator would have
 * refused, and the only way to guarantee that is to ask the same answer.
 *
 * The entries are post-derivation, which is fine and worth stating plainly,
 * because it is the one subtle thing here: a hand-set milestone already in the
 * file shows up as its own `user` division. `refusalForUserMilestone` checks
 * overlap against the stored RECORDS first, so a range reaching into one is
 * refused by name before any division is consulted; and the renumbering a
 * milestone causes among app-invented runs only ever changes their keys and
 * labels, never their `kind`, which is the only thing the placement rules read.
 */
export function divisionsForOrder(
  order: readonly string[],
  entries: readonly {
    key: string
    label: string
    shortLabel: string
    kind: ImportMilestoneKind
    cellIds: readonly string[]
  }[],
): (ImportMilestone | undefined)[] {
  const byCellId = new Map<string, ImportMilestone>()
  for (const entry of entries) {
    const division: ImportMilestone = {
      key: entry.key,
      kind: entry.kind,
      label: entry.label,
      shortLabel: entry.shortLabel,
    }
    for (const cellId of entry.cellIds) byCellId.set(cellId, division)
  }
  return order.map((cellId) => byCellId.get(cellId))
}

/**
 * The edges the dialog opens with.
 *
 * The cell the menu was opened on is the start. When a range was shift-click
 * selected first, the selection's EDGES are both prefilled instead — that is
 * the whole gesture: a person who just dragged over lines 80–95 has already
 * said which range they mean, and re-picking both edges in two comboboxes
 * would be the dialog ignoring them.
 *
 * The selection is only honoured when it reaches past the clicked cell and
 * actually contains it. A stale selection somewhere else in the file (the
 * module-level store outlives a scroll) must not silently retarget the
 * milestone away from the row whose menu is open.
 *
 * `endCellId` falls back to the start, not to nothing: a one-cell milestone is
 * a legal thing to save, so the dialog opens on a valid draft and the person
 * widens it, rather than opening on a refusal they did not cause.
 */
export function milestoneDraftPrefill(
  order: readonly string[],
  cellId: string,
  selected: ReadonlySet<string>,
): { startCellId: string; endCellId: string } {
  const indices: number[] = []
  if (selected.has(cellId) && selected.size > 1) {
    order.forEach((id, index) => {
      if (selected.has(id)) indices.push(index)
    })
  }
  if (indices.length > 1) {
    return {
      startCellId: order[indices[0]],
      endCellId: order[indices[indices.length - 1]],
    }
  }
  return { startCellId: cellId, endCellId: cellId }
}
