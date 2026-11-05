// AQU-2342: pending agent brief proposals become `decisions/` memories.
//
// The brief review screen is gone — the project's standing guidance is ONE
// text, the instructions, and an agent's change to it is a `decisions/`
// memory whose approval appends the text there (agent-memory.ts reviewMemory).
// A `propose_brief_update` from an older conversation is already retargeted to
// that path (auth-worker harness-tools.ts). This moves the rows proposed
// BEFORE that change, so a reviewer finds them in the Memory tab with the rest
// of the queue instead of in a table no screen lists.
//
// Lazily, on read (the Memory tab's list route), not by a migration: a
// project nobody opens keeps its rows untouched, and nothing runs against a
// shared database at deploy. Each moved proposal is closed as `rejected` with
// `reviewed_by = MOVED_TO_DECISIONS_REVIEWER` (the status CHECK allows no
// other value without a migration) and its memory carries
// `provenance.briefProposalId`, so the move is traceable both ways. A proposal
// the memory rules refuse (too large, a secret-looking string) is left as it
// was: closing it would reject a human-gated change nobody reviewed.

import type { AquillaDb } from "../shim/postgres"
import { createProposal, validateMemoryContent } from "./agent-memory"

/** `reviewed_by` on a brief proposal that was moved, not reviewed. */
export const MOVED_TO_DECISIONS_REVIEWER = "aqu-2342:moved-to-decisions"

/** A stable decisions/ path for a brief update's text: same text → same path,
 *  so a repeat supersedes on approval rather than piling up. */
export async function briefDecisionPath(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content.trim())
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  const hex = [...new Uint8Array(hash).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("")
  return `decisions/instructions-${hex}.md`
}

interface PendingRow {
  id: string
  content: string
  rationale: string | null
  created_by: string | null
}

/** Move the project's pending brief proposals into the memory queue. Returns
 *  how many moved. Cheap when there are none (one indexed SELECT). */
export async function moveBriefProposalsToDecisions(db: AquillaDb, projectId: string): Promise<number> {
  const any = await db
    .prepare(`SELECT 1 FROM project_brief_proposals WHERE project_id = ? AND status = 'proposed' LIMIT 1`)
    .bind(projectId)
    .first()
  if (!any) return 0

  const move = async (tx: AquillaDb): Promise<number> => {
    // FOR UPDATE: a concurrent list waits here, then re-checks status and
    // finds the rows already moved — no proposal becomes two memories.
    const { results } = await tx
      .prepare(
        `SELECT id, content, rationale, created_by FROM project_brief_proposals
          WHERE project_id = ? AND status = 'proposed'
          ORDER BY created_at
          FOR UPDATE`,
      )
      .bind(projectId)
      .all<PendingRow>()
    let moved = 0
    for (const row of results) {
      if (!row.content.trim() || validateMemoryContent(row.content)) continue
      const created = await createProposal(tx, {
        projectId,
        path: await briefDecisionPath(row.content),
        content: row.content,
        rationale: row.rationale,
        provenance: { briefProposalId: row.id },
        createdBy: row.created_by,
      })
      if (created.status !== "ok") continue
      await tx
        .prepare(
          `UPDATE project_brief_proposals
              SET status = 'rejected', reviewed_by = ?, reviewed_at = now()
            WHERE id = ? AND status = 'proposed'`,
        )
        .bind(MOVED_TO_DECISIONS_REVIEWER, row.id)
        .run()
      moved += 1
    }
    return moved
  }
  return db.transaction ? db.transaction(move) : move(db)
}
