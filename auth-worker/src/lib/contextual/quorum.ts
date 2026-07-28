// quorum — accept a cell on a majority of approvals (graph node `quorum`).
// Pure code, zero tokens. Per-cell verdicts; a vote with no explicit verdict
// for a cell contributes its span-level approve. verify_ambiguity carries an
// ABSOLUTE veto: any ambiguity disapproval on a cell rejects it regardless of
// the other votes — preserving registered ambiguity is the design's
// distinctive guarantee, and it is counted here in code, not judged by a
// model.

import type { SpanDraft, Vote } from "./types"

export interface QuorumResult {
  accepted: string[]
  rejected: { cellId: string; constraints: string[] }[]
}

/** A cell's effective verdict from one vote: explicit per-cell verdict when
 *  present, else the vote's span-level approve. */
function verdictFor(vote: Vote, cellId: string): { approve: boolean; reason?: string } {
  const explicit = vote.cellVerdicts.find((v) => v.cellId === cellId)
  if (explicit) return { approve: explicit.approve, ...(explicit.reason ? { reason: explicit.reason } : {}) }
  return { approve: vote.approve, ...(vote.reason && !vote.approve ? { reason: vote.reason } : {}) }
}

export function tallyVotes(votes: Vote[], draft: SpanDraft): QuorumResult {
  const accepted: string[] = []
  const rejected: { cellId: string; constraints: string[] }[] = []

  for (const cell of draft.cells) {
    let approvals = 0
    let vetoed = false
    const constraints: string[] = []

    for (const vote of votes) {
      const verdict = verdictFor(vote, cell.cellId)
      if (verdict.approve) {
        approvals += 1
      } else {
        if (vote.verifier === "ambiguity") vetoed = true
        constraints.push(`${vote.verifier}: ${verdict.reason ?? "rejected without stated reason"}`)
      }
    }

    // Strict majority (2-of-3 with the full panel; the single mandatory
    // ambiguity vote decides alone on low-risk spans) — and the ambiguity
    // veto overrides any majority.
    const majority = approvals * 2 > votes.length
    if (!vetoed && majority) accepted.push(cell.cellId)
    else rejected.push({ cellId: cell.cellId, constraints })
  }

  return { accepted, rejected }
}
