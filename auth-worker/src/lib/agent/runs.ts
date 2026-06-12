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
}

export async function insertAgentRun(db: AquillaDb, run: AgentRunStart): Promise<void> {
  await db
    .prepare(
      `INSERT INTO agent_runs (run_id, project_id, user_id, username, prompt, model, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .bind(run.runId, run.projectId, run.userId, run.username, run.prompt, run.model, Date.now())
    .run()
}

export interface AgentRunFinish {
  runId: string
  status: "ok" | "capped" | "error"
  promptTokens: number
  completionTokens: number
  costCents: number
  steps: number
}

export async function finishAgentRun(db: AquillaDb, fin: AgentRunFinish): Promise<void> {
  await db
    .prepare(
      `UPDATE agent_runs
       SET status = ?, prompt_tokens = ?, completion_tokens = ?, cost_cents = ?, steps = ?, ended_at = ?
       WHERE run_id = ?`,
    )
    .bind(
      fin.status,
      fin.promptTokens,
      fin.completionTokens,
      fin.costCents,
      fin.steps,
      Date.now(),
      fin.runId,
    )
    .run()
}
