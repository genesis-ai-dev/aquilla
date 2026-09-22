import { useMemo } from "react"
import type { CellSummary } from "./useActiveCellStore"

type EvidenceCell = Pick<CellSummary, "id" | "status" | "translated" | "targetEventId" | "lastEditAt">

/** The refresh key for translate-as-read. Consume immutable summaries instead
 * of materializing full views; unavailable queues need no evidence scan. */
export function useValidatedEvidenceVersion(available: boolean, cells: readonly EvidenceCell[]): string {
  return useMemo(() => available
    ? cells.filter(cell => cell.status === "validated" && cell.translated.trim())
      .map(cell => `${cell.id}:${cell.targetEventId ?? cell.lastEditAt ?? ""}`)
      .join("|")
    : "", [available, cells])
}
