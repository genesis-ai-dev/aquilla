import type { ProjectedCellRow, SeededFileEvent } from "../e2e/helpers/seed-project"

/** A reviewer signs off on exactly one translation, and on nothing else. */
export interface ValidationContract {
  cellId: string
  author: string
  baseline: ProjectedCellRow[]
}

/** The intended target row carries the sign-off, and no other row does. */
export function validationLanded(
  contract: ValidationContract, rows: ProjectedCellRow[],
): boolean {
  const targets = rows.filter((row) => row.side === "target")
  const intended = targets.filter((row) => row.cellId === contract.cellId)
  return intended.length === 1 && intended[0].validated
    && targets.every((row) => row.cellId === contract.cellId || !row.validated)
}

/**
 * The append-only log, not the projection, is where a wrong-cell or
 * duplicate sign-off is visible. A validate that was applied and then
 * withdrawn leaves both events behind and must not read as a clean pass.
 */
export function validationLogClean(
  contract: ValidationContract, events: SeededFileEvent[],
): boolean {
  const signOffs = events.filter((event) =>
    event.kind === "cell.validate" || event.kind === "cell.unvalidate")
  const [only] = signOffs
  return signOffs.length === 1 && only.kind === "cell.validate"
    && only.author === contract.author
}

/**
 * Sign-off must not rewrite translations. Compare value and chain head for
 * every row, and `validated` for every row except the intended target — the
 * one field this journey is allowed to change.
 */
export function translationsUntouched(
  contract: ValidationContract, rows: ProjectedCellRow[],
): boolean {
  const canonical = (values: ProjectedCellRow[]) => JSON.stringify(values.map((row) => {
    const intended = row.side === "target" && row.cellId === contract.cellId
    return JSON.stringify([row.cellId, row.side, row.value, row.eventId, row.aiDrafted,
      intended ? "validation-under-test" : row.validated])
  }).sort())
  return canonical(contract.baseline) === canonical(rows)
}
