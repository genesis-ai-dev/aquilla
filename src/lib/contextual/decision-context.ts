// decision-context — where an open question applies, in words a translator
// can act on: which file, which passage, what the source says there, and what
// the translation currently reads. A bare reason ("Two prior renderings of
// this name conflict") is unanswerable without it.
//
// Two reads, both lazy-ish: `loadDecisionPlace` runs when a card mounts (the
// cap on shown decisions keeps that to a handful of small requests);
// `loadDecisionSurroundings` runs only when a reader asks for neighbouring
// verses, because it walks the whole file to find document order.

import { loadSession } from "@/lib/frontier/session-store"
import { fetchAllFileCells, fetchCellsByIds, fetchFile } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { fetchSyncToken } from "@/lib/sync/sync-token"
import { cellDisplayTag, formatSpanRange } from "../../../shared/span-label"

/** Verses shown on each side of the affected passage when expanded. */
export const SURROUNDING_RADIUS = 3

export interface DecisionCellView {
  cellId: string
  /** Human tag ("MRK 4:3"), or null when the cell has none. */
  ref: string | null
  source: string
  /** Current default-lane translation; empty when not yet translated. */
  target: string
  /** True for cells the question is about (vs. surrounding context). */
  affected: boolean
}

export interface DecisionPlace {
  fileName: string
  /** "MRK 4:1–4:8"; null when the cells carry no human-readable ref. */
  passage: string | null
  cells: DecisionCellView[]
}

interface DecisionAddress {
  fileId: string
  cellIds: string[]
}

async function syncToken(projectId: string, fileId: string): Promise<string> {
  const session = await loadSession()
  if (!session?.jwt) throw new Error("not signed in")
  const mint = await fetchSyncToken(session.jwt, projectId, fileId)
  return mint.token
}

/** Pair source and default-lane target rows into one view per cell, in the
 *  order of `cellIds`. Rows for other lanes are ignored. */
export function pairCells(
  rows: readonly CellRow[],
  cellIds: readonly string[],
  affected: ReadonlySet<string>,
): DecisionCellView[] {
  const source = new Map<string, CellRow>()
  const target = new Map<string, CellRow>()
  for (const row of rows) {
    if (row.side === "source") source.set(row.cellId, row)
    else if ((row.targetLang ?? "") === "") target.set(row.cellId, row)
  }
  return cellIds.flatMap((cellId) => {
    const src = source.get(cellId)
    if (!src) return []
    return [{
      cellId,
      ref: cellDisplayTag(src),
      source: src.value,
      target: target.get(cellId)?.value ?? "",
      affected: affected.has(cellId),
    }]
  })
}

/** The affected cells plus `radius` cells either side, in document order.
 *  `order` is the file's source cell ids in anchor-chain order. Cells the
 *  file no longer contains are dropped rather than guessed at. */
export function windowAround(
  order: readonly string[],
  cellIds: readonly string[],
  radius: number,
): string[] {
  const positions = cellIds.map((id) => order.indexOf(id)).filter((i) => i >= 0)
  if (positions.length === 0) return []
  const start = Math.max(0, Math.min(...positions) - radius)
  const end = Math.min(order.length - 1, Math.max(...positions) + radius)
  return order.slice(start, end + 1)
}

export async function loadDecisionPlace(
  projectId: string,
  decision: DecisionAddress,
): Promise<DecisionPlace> {
  const token = await syncToken(projectId, decision.fileId)
  const [file, rows] = await Promise.all([
    fetchFile(projectId, decision.fileId, token),
    fetchCellsByIds(projectId, decision.fileId, decision.cellIds, token),
  ])
  const cells = pairCells(rows, decision.cellIds, new Set(decision.cellIds))
  const first = rows.find((r) => r.side === "source" && r.cellId === cells[0]?.cellId)
  const last = rows.find((r) => r.side === "source" && r.cellId === cells[cells.length - 1]?.cellId)
  return {
    fileName: file.name,
    passage: formatSpanRange(first ?? null, last ?? null),
    cells,
  }
}

export async function loadDecisionSurroundings(
  projectId: string,
  decision: DecisionAddress,
  radius = SURROUNDING_RADIUS,
): Promise<DecisionCellView[]> {
  const token = await syncToken(projectId, decision.fileId)
  const rows = await fetchAllFileCells(projectId, decision.fileId, token)
  const order = rows.filter((r) => r.side === "source").map((r) => r.cellId)
  const ids = windowAround(order, decision.cellIds, radius)
  return pairCells(rows, ids, new Set(decision.cellIds))
}
