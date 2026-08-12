// cost-meter — a per-call ledger of everything an agent surface spends.
//
// DEV INSTRUMENTATION (AQU pricing exercise). Not part of the product cost
// path: `credits.ts` remains the billing ledger. This records one row per
// model call and per tool call so a run can be re-priced offline against any
// vendor's rate card, and so we can see WHERE the compute goes (which node,
// which tool, how much of it was retries).
//
// Why raw tokens rather than dollars: `usage.cost` is an OpenRouter extension
// (lib/llm-vendor.ts) and is absent from every self-hosted upstream, so a
// local Gemma run reports 0 cost while still burning real tokens. Tokens are
// the durable measurement; `scripts/cost-report.ts` applies the price table.
//
// Contract: never throws, never blocks a run. Rows are buffered and flushed in
// batches — a per-call round-trip would add DB latency inside the model hot
// path and distort the very latency numbers we are collecting.

import type { AquillaDb } from "../../../db/shim/postgres"

export type CostSurface = "autopilot" | "agent"
export type CostKind = "llm" | "tool"

export interface CostRow {
  surface: CostSurface
  runId: string
  projectId: string
  kind: CostKind
  /** Pipeline node ("construe", "draft"), or tool name ("search", "run_code"). */
  label: string
  /** Autopilot only: the span this call served. The unit of work the cost
   *  distribution is computed over — a run has one total, but ~200 spans. */
  spanId?: string
  tier?: string
  model?: string
  promptTokens?: number
  completionTokens?: number
  /** Provider-reported cost. 0 on any non-OpenRouter upstream. */
  costCents?: number
  latencyMs?: number
  tokensPerSecond?: number
  ok?: boolean
}

/**
 * Build a meter from env. **Off unless `COST_METER=1`** — disabled means no
 * table creation, no writes, and no measurable overhead, so this ships dark and
 * production is untouched until someone deliberately turns it on for a costing
 * run. That default is also why the DDL below can live in code rather than in
 * db/postgres/migrations: nothing creates this table in a deployed environment.
 */
export function makeCostMeter(env: { COST_METER?: string }, db: AquillaDb): CostMeter {
  return new CostMeter(db, { enabled: env.COST_METER === "1" })
}

const DDL = `
CREATE TABLE IF NOT EXISTS agent_cost_meter (
  id                bigserial PRIMARY KEY,
  surface           text NOT NULL,
  run_id            text NOT NULL,
  project_id        text NOT NULL,
  kind              text NOT NULL,
  label             text NOT NULL DEFAULT '',
  span_id           text NOT NULL DEFAULT '',
  tier              text,
  model             text,
  prompt_tokens     integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_cents        double precision NOT NULL DEFAULT 0,
  latency_ms        integer NOT NULL DEFAULT 0,
  tokens_per_second double precision,
  ok                boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
)`

const COLUMNS = 15

/**
 * Buffered writer for one run. Create per run/loop, `add()` from the hot path,
 * `flush()` at a natural boundary (end of a wave, end of an agent run).
 */
export class CostMeter {
  private rows: CostRow[] = []
  private ensured = false
  private readonly enabled: boolean
  private readonly flushAt: number

  constructor(
    private readonly db: AquillaDb,
    opts: { enabled: boolean; flushAt?: number },
  ) {
    this.enabled = opts.enabled
    this.flushAt = opts.flushAt ?? 64
  }

  /** Buffer one row. Fire-and-forget: callers must not await the auto-flush. */
  add(row: CostRow): void {
    if (!this.enabled) return
    this.rows.push(row)
    if (this.rows.length >= this.flushAt) void this.flush()
  }

  /** Write buffered rows. Safe to call concurrently and when empty. */
  async flush(): Promise<void> {
    if (!this.enabled || this.rows.length === 0) return
    const batch = this.rows
    this.rows = []
    try {
      if (!this.ensured) {
        await this.db.prepare(DDL).run()
        this.ensured = true
      }
      // One multi-row INSERT — 1000+ single-row round-trips per run would cost
      // more wall-clock than the model calls being measured.
      const placeholders = batch
        .map(() => `(${Array.from({ length: COLUMNS }, () => "?").join(", ")})`)
        .join(", ")
      const binds = batch.flatMap((r) => [
        r.surface,
        r.runId,
        r.projectId,
        r.kind,
        r.label,
        r.spanId ?? "",
        r.tier ?? null,
        r.model ?? null,
        r.promptTokens ?? 0,
        r.completionTokens ?? 0,
        r.costCents ?? 0,
        r.latencyMs ?? 0,
        r.tokensPerSecond ?? null,
        r.ok ?? true,
        new Date().toISOString(),
      ])
      await this.db
        .prepare(
          `INSERT INTO agent_cost_meter
             (surface, run_id, project_id, kind, label, span_id, tier, model,
              prompt_tokens, completion_tokens, cost_cents, latency_ms,
              tokens_per_second, ok, created_at)
           VALUES ${placeholders}`,
        )
        .bind(...binds)
        .run()
    } catch (err) {
      // Never let the meter break the run it is measuring. Dropped rows are
      // logged loudly: a silently short ledger would understate the cost we
      // are trying to establish, which is worse than no ledger at all.
      console.error(`[cost-meter] dropped ${batch.length} row(s):`, err)
    }
  }
}
