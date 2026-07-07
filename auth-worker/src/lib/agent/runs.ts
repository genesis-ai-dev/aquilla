// agent_runs ledger (design §5 "Attribution + rollback"; metering-first P0).
//
// One row per POST /api/v1/ai/agent/run. Inserted as `running` before the
// first model call; finalised with tokens/cost/steps/status when the run
// ends (ok | capped | error). Every staged target.cell.commit carries
// payload.agent_run_id pointing back here, so "undo run X" / PM cost
// rollups have a stable key. Table: db/postgres/schema.sql +
// db/postgres/migrations/0040_agent_runs.sql.

export interface AgentRunStart {
  runId: string
  projectId: string
  userId: number
  username: string
  /** The user's request (last user message), for the observability ledger. */
  prompt: string
  model: string
  /** Owning agent_sessions row; null for sessionless (v1) clients. */
  sessionId?: string | null
}

export async function insertAgentRun(db: AquillaDb, run: AgentRunStart): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_runs (run_id, project_id, user_id, username, prompt, model, status, session_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
    )
    .bind(
      run.runId,
      run.projectId,
      run.userId,
      run.username,
      run.prompt,
      run.model,
      run.sessionId ?? null,
      Date.now(),
    )
    .run()
}

export interface AgentRunFinish {
  runId: string
  status: "ok" | "capped" | "error"
  promptTokens: number
  completionTokens: number
  costCents: number
  steps: number
  /** target.cell.commit events staged across the run's proposals (0051). */
  stagedCount: number
}

export async function finishAgentRun(db: AquillaDb, fin: AgentRunFinish): Promise<void> {
  await db
    .prepare(
      `UPDATE agent_runs
       SET status = ?, prompt_tokens = ?, completion_tokens = ?, cost_cents = ?, steps = ?, staged_count = ?, ended_at = ?
       WHERE run_id = ?`,
    )
    .bind(
      fin.status,
      fin.promptTokens,
      fin.completionTokens,
      fin.costCents,
      fin.steps,
      fin.stagedCount,
      Date.now(),
      fin.runId,
    )
    .run()
}

// ── Acceptance rollup (design §7 kill/health metrics) ───────────────────────
//
// The applied/undone sides of the ratio come from the EVENT LOG, not a second
// write path: an applied draft carries payload.agent_run_id (staged server-
// side, preserved by the client Apply), a compensating undo carries
// payload.undo_of_agent_run_id (src/lib/agent/undo.ts). So per run:
// acceptance = applied ÷ staged, and undone shows post-apply regret.

export interface AgentRunSummary {
  runId: string
  username: string
  prompt: string
  model: string
  status: string
  startedAt: number
  endedAt: number | null
  costCents: number
  steps: number
  stagedCount: number
  appliedCount: number
  undoneCount: number
}

/** Provenance-key → count over a project's target.cell.commit events. */
async function countByProvenance(
  db: AquillaDb,
  projectId: string,
  key: "agent_run_id" | "undo_of_agent_run_id",
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT payload::jsonb->>'${key}' AS run_id, COUNT(*) AS n
       FROM events
       WHERE project_id = ? AND kind = 'target.cell.commit'
         AND payload::jsonb->>'${key}' IS NOT NULL
       GROUP BY payload::jsonb->>'${key}'`,
    )
    .bind(projectId)
    .all<{ run_id: string; n: number | string }>()
  return new Map(results.map((r) => [r.run_id, Number(r.n)]))
}

export async function listAgentRuns(
  db: AquillaDb,
  projectId: string,
  limit: number,
): Promise<AgentRunSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT run_id, username, prompt, model, status, started_at, ended_at,
              cost_cents, steps, staged_count
       FROM agent_runs WHERE project_id = ?
       ORDER BY started_at DESC LIMIT ?`,
    )
    .bind(projectId, limit)
    .all<{
      run_id: string
      username: string
      prompt: string
      model: string
      status: string
      started_at: number | string
      ended_at: number | string | null
      cost_cents: number
      steps: number
      staged_count: number
    }>()
  const applied = await countByProvenance(db, projectId, "agent_run_id")
  const undone = await countByProvenance(db, projectId, "undo_of_agent_run_id")
  return results.map((r) => ({
    runId: r.run_id,
    username: r.username,
    prompt: r.prompt,
    model: r.model,
    status: r.status,
    startedAt: Number(r.started_at),
    endedAt: r.ended_at === null ? null : Number(r.ended_at),
    costCents: r.cost_cents,
    steps: r.steps,
    stagedCount: r.staged_count,
    appliedCount: applied.get(r.run_id) ?? 0,
    undoneCount: undone.get(r.run_id) ?? 0,
  }))
}
