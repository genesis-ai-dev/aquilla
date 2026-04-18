import type { CellData } from "@/hooks/useCells"

export interface RecentExample {
  cellId: string
  source: string
  target: string
  validatedAt: string // ISO; empty string if no history available
  author: string       // last human edit author if available
}

/**
 * Return the N most recently validated cells across the project, sorted by
 * most-recent validation timestamp descending.
 *
 * "Validated" means validationStatus is "full" (consensus reached) or "self"
 * (current user has validated). Empty and un-validated cells are excluded.
 * Cells with no history are included but sorted to the bottom.
 */
export function selectRecentValidatedExamples(cells: CellData[], limit: number): RecentExample[] {
  const validated = cells.filter(
    (c) => c.validationStatus === "full" || c.validationStatus === "self",
  )

  const examples: RecentExample[] = validated.map((c) => {
    const lastEntry = c.history[c.history.length - 1]
    return {
      cellId: c.id,
      source: c.original,
      target: c.translated,
      validatedAt: lastEntry?.timestamp ?? "",
      author: lastEntry?.author ?? "",
    }
  })

  examples.sort((a, b) => b.validatedAt.localeCompare(a.validatedAt))
  return examples.slice(0, limit)
}
