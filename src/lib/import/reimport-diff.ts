/**
 * What a re-import would change, before the user confirms.
 *
 * Pairing follows the reconcile planner: unit key, then cell id, then
 * canonical reference, then the same content match a shifted document uses.
 * Apostrophe lookalikes and soft hyphens count as the same words, so a
 * republished heading stays on its cell instead of showing up as new.
 */

import { orderCellsByAnchor } from "../../../db/shared/link-file-match"
import { matchImportContent, normalizeForMatch } from "../../../sync-worker/src/events/import-content-match"

export interface ReimportCountedCell {
  cellId: string
  value: string
  valueHtml?: string | null
  canonicalRef?: string | null
  anchorCellId?: string | null
  metadata?: unknown
}

export interface ReimportChangeCell {
  text: string
  /** The original file's text, when this cell is an update. */
  previous?: string
  /** 1-based place of this cell in the uploaded document. */
  number: number
}

export interface ReimportChangeCounts {
  added: number
  updated: number
  addedCells: readonly ReimportChangeCell[]
  updatedCells: readonly ReimportChangeCell[]
}

function unitKeyOf(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null
  const aquilla = (metadata as { aquillaImport?: unknown }).aquillaImport
  if (!aquilla || typeof aquilla !== "object") return null
  const key = (aquilla as { unitKey?: unknown }).unitKey
  return typeof key === "string" && key.trim() ? key : null
}

function uniqueBy(
  cells: readonly ReimportCountedCell[],
  keyOf: (cell: ReimportCountedCell) => string | null,
): Map<string, ReimportCountedCell> {
  const result = new Map<string, ReimportCountedCell>()
  const duplicates = new Set<string>()
  for (const cell of cells) {
    const key = keyOf(cell)
    if (!key) continue
    if (result.has(key)) duplicates.add(key)
    else result.set(key, cell)
  }
  for (const key of duplicates) result.delete(key)
  return result
}

function sameWords(existing: ReimportCountedCell, incoming: ReimportCountedCell): boolean {
  return normalizeForMatch(existing.value) === normalizeForMatch(incoming.value)
}

export function countReimportDiff(
  incoming: readonly ReimportCountedCell[],
  existing: readonly ReimportCountedCell[],
): ReimportChangeCounts {
  const existingOrdered = orderCellsByAnchor(existing)
  const existingByUnitKey = uniqueBy(existingOrdered, (cell) => unitKeyOf(cell.metadata))
  const existingByCellId = new Map(existingOrdered.map((cell) => [cell.cellId, cell]))
  const existingByCanonicalRef = uniqueBy(existingOrdered, (cell) => cell.canonicalRef?.trim() || null)
  const used = new Set<string>()
  const preliminary = incoming.map((cell) => {
    const key = unitKeyOf(cell.metadata)
    let matched = key ? existingByUnitKey.get(key) : undefined
    if (!matched) matched = existingByCellId.get(cell.cellId)
    const ref = cell.canonicalRef?.trim()
    if (!matched && ref) matched = existingByCanonicalRef.get(ref)
    if (matched && used.has(matched.cellId)) matched = undefined
    if (matched) used.add(matched.cellId)
    return { incoming: cell, existing: matched }
  })

  const locked = new Map<string, string>()
  for (const row of preliminary) {
    if (!row.existing || !sameWords(row.existing, row.incoming)) continue
    locked.set(row.incoming.cellId, row.existing.cellId)
  }
  const { adopted } = matchImportContent(
    incoming.map((cell) => ({ cellId: cell.cellId, value: cell.value })),
    existingOrdered.map((cell) => ({ cellId: cell.cellId, value: cell.value })),
    locked,
  )

  const claimed = new Set(locked.values())
  for (const row of preliminary) {
    if (locked.has(row.incoming.cellId)) continue
    const adoption = adopted.get(row.incoming.cellId)
    const adoptedCell = adoption ? existingByCellId.get(adoption.cellId) : undefined
    if (!adoption || !adoptedCell || claimed.has(adoptedCell.cellId)) continue
    claimed.add(adoptedCell.cellId)
    row.existing = adoptedCell
  }
  for (const row of preliminary) {
    if (locked.has(row.incoming.cellId)) continue
    if (adopted.has(row.incoming.cellId) && row.existing) continue
    if (row.existing && !claimed.has(row.existing.cellId)) {
      claimed.add(row.existing.cellId)
      continue
    }
    row.existing = undefined
  }

  const addedCells: ReimportChangeCell[] = []
  const updatedCells: ReimportChangeCell[] = []
  for (let index = 0; index < preliminary.length; index++) {
    const row = preliminary[index]
    const number = index + 1
    if (!row.existing) {
      addedCells.push({ text: row.incoming.value, number })
      continue
    }
    if (!sameWords(row.existing, row.incoming)) {
      updatedCells.push({ text: row.incoming.value, previous: row.existing.value, number })
    }
  }
  return {
    added: addedCells.length,
    updated: updatedCells.length,
    addedCells,
    updatedCells,
  }
}
