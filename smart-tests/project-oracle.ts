import type { ProjectedCellRow } from "../e2e/helpers/seed-project"
import type { Outcome } from "./outcome"
import type { CommentRecord } from "../src/lib/sync/comments-read-types"

export function commentMatches(
  comments: CommentRecord[],
  expected: { body: string; projectId: string; fileId: string; cellId: string },
): boolean {
  const comment = comments[0]
  return comments.length === 1 && comment.body === expected.body
    && comment.projectId === expected.projectId && comment.fileId === expected.fileId
    && comment.cellId === expected.cellId && comment.scopeKind === "cell"
    && comment.parentCommentId === null && comment.deletedAt === null && !comment.resolved
}

/** Compare identity, values, and event heads, independent of query ordering. */
export function cellsUnchanged(before: ProjectedCellRow[], after: ProjectedCellRow[]): boolean {
  const canonical = (rows: ProjectedCellRow[]) => JSON.stringify(rows.map((row) =>
    JSON.stringify([row.cellId, row.side, row.value, row.eventId, row.validated, row.aiDrafted])).sort())
  return canonical(before) === canonical(after)
}

export function verifiedOutcome(checks: Record<string, boolean>, inputObserved: boolean): Outcome {
  const passed = Object.keys(checks).length > 0 && Object.values(checks).every(Boolean) && inputObserved
  return {
    checks: { ...checks, inputObserved },
    verdict: passed ? "passed" : inputObserved ? "product_failure" : "inconclusive",
    reason: passed ? "Server state and a fresh browser verify the requested outcome."
      : inputObserved ? "The observed input did not satisfy the independent outcome contract."
        : "The agent did not establish the intended input.",
  }
}
