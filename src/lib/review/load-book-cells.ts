/**
 * AQU-2673: cells of a book the editor does not have open.
 *
 * The cell store holds the open file only. A header run that covers other
 * books reads each file the same way the store pairs a page: source rows plus
 * the active language's target rows, with that file's audit stats so "already
 * signed off" is still true.
 */
import { buildCellData, type CellData } from "@/hooks/useCells"
import { fetchFileAuditStats, type CellAuditStats } from "@/hooks/useCellsAuditStats"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"

function laneOf(row: CellRow): string {
  return row.targetLang ?? ""
}

export function pairBookRows(
  rows: readonly CellRow[],
  fileId: string,
  lane: string,
  username: string,
  requiredValidations: number,
  stats: ReadonlyMap<string, CellAuditStats>,
): CellData[] {
  const sourceById = new Map<string, CellRow>()
  const targetById = new Map<string, CellRow>()
  for (const row of rows) {
    if (row.side === "source") sourceById.set(row.cellId, row)
    else if (laneOf(row) === lane) targetById.set(row.cellId, row)
  }
  const order: string[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (row.side !== "source" || seen.has(row.cellId)) continue
    seen.add(row.cellId)
    order.push(row.cellId)
  }
  for (const id of targetById.keys()) {
    if (!seen.has(id)) order.push(id)
  }
  return order.map((id) => buildCellData(
    id,
    sourceById.get(id),
    targetById.get(id),
    fileId,
    username,
    requiredValidations,
    stats.get(id),
  ))
}

export async function loadBookCells(args: {
  projectId: string
  fileId: string
  jwt: string
  lane: string
  username: string
  requiredValidations: number
}): Promise<CellData[]> {
  const [rows, audit] = await Promise.all([
    fetchAllFileCells(args.projectId, args.fileId, args.jwt, undefined, args.lane || undefined),
    fetchFileAuditStats(args.fileId, args.jwt, args.lane),
  ])
  return pairBookRows(
    rows,
    args.fileId,
    args.lane,
    args.username,
    args.requiredValidations,
    audit.map,
  )
}
