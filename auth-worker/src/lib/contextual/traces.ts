// traces — the prompt and reply of every Autopilot model call, kept so a
// project member can open a step in the Team inspector and see what the model
// was actually asked and what it said.
//
// Data policy. This deliberately crosses the line contextual_run_events holds
// ("never prompts, draft text, model reasoning"): the events table is
// telemetry and stays bounded; this table is the project's own working text,
// shown only to people who can already view the run (VIEWER on the project),
// and it expires after TRACE_RETENTION_DAYS (pruned by the 5-minute cron).
// Provider error bodies are still never stored — `error` is a machine code.
//
// PostHog: each call is also sent as an `$ai_generation` (counts only, like
// lib/agent/telemetry.ts). The prompt and reply go to PostHog ONLY when
// POSTHOG_LLM_CONTENT=1 — that sends translators' text to a third party, so
// it is an explicit per-environment opt-in, off by default.
//
// Contract, same as cost-meter: never throws, never blocks a run. Rows are
// buffered and flushed in one multi-row INSERT per wave.

import type { AquillaDb } from "../../../../db/shim/postgres"
import { resolvePosthogHost } from "../../posthog-logs"
import type { LlmCallTrace } from "./tick"

export const TRACE_RETENTION_DAYS = 30
/** Per text field. A construe prompt with examples runs ~10-20k chars; this
 *  keeps the common case whole and bounds the pathological one. */
export const TRACE_TEXT_MAX_CHARS = 32_768
export const TRACE_LIST_LIMIT = 50
const FLUSH_TIMEOUT_MS = 3000
const COLUMNS = 18

export interface TraceEnv {
  /** "0" turns trace storage off. On by default. */
  CONTEXTUAL_TRACES?: string
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
  /** "1" includes prompt/reply text in PostHog $ai_generation events. */
  POSTHOG_LLM_CONTENT?: string
}

export interface ContextualRunTrace {
  id: number
  runId: string
  spanId: string
  label: string
  tier: string
  model: string
  system: string
  user: string
  output: string | null
  error: string | null
  generationId: string | null
  promptTokens: number
  completionTokens: number
  costCents: number
  latencyMs: number
  attempts: number
  truncated: boolean
  createdAt: string
}

function clip(text: string): { text: string; clipped: boolean } {
  if (text.length <= TRACE_TEXT_MAX_CHARS) return { text, clipped: false }
  return { text: `${text.slice(0, TRACE_TEXT_MAX_CHARS)}\n…[truncated]`, clipped: true }
}

export function makeTraceRecorder(
  env: TraceEnv,
  db: AquillaDb,
  ctx: { runId: string; projectId: string },
): TraceRecorder {
  const key = env.POSTHOG_KEY?.trim()
  return new TraceRecorder(db, ctx, {
    store: env.CONTEXTUAL_TRACES !== "0",
    posthog: key
      ? { key, host: resolvePosthogHost(env.POSTHOG_HOST), content: env.POSTHOG_LLM_CONTENT === "1" }
      : null,
  })
}

/**
 * One row. A model call is an LlmCallTrace; AQU-1690 also records Jev calls
 * (tier "jev", label "jev:bible-qa") and code-only rows such as the Bible
 * facts a span used (tier "code"), so the tier is any short label here.
 */
export type TraceInput = Omit<LlmCallTrace, "tier"> & { tier: string }

export class TraceRecorder {
  private rows: TraceInput[] = []

  constructor(
    private readonly db: AquillaDb,
    private readonly ctx: { runId: string; projectId: string },
    private readonly opts: {
      store: boolean
      posthog: { key: string; host: string; content: boolean } | null
      flushAt?: number
    },
  ) {}

  /** Buffer one call. Fire-and-forget: callers must not await the auto-flush. */
  add(t: TraceInput): void {
    if (!this.opts.store && !this.opts.posthog) return
    this.rows.push(t)
    if (this.rows.length >= (this.opts.flushAt ?? 32)) void this.flush()
  }

  /** Write buffered rows. Safe to call concurrently and when empty. */
  async flush(): Promise<void> {
    if (this.rows.length === 0) return
    const batch = this.rows
    this.rows = []
    await Promise.all([this.store(batch), this.sendPosthog(batch)])
  }

  private async store(batch: TraceInput[]): Promise<void> {
    if (!this.opts.store) return
    try {
      const placeholders = batch
        .map(() => `(${Array.from({ length: COLUMNS }, () => "?").join(", ")})`)
        .join(", ")
      const binds = batch.flatMap((t) => {
        const system = clip(t.system)
        const user = clip(t.user)
        const output = t.output === null ? null : clip(t.output)
        return [
          this.ctx.runId,
          this.ctx.projectId,
          t.spanId,
          t.label,
          t.tier,
          t.model,
          system.text,
          user.text,
          output?.text ?? null,
          t.error,
          t.generationId ?? null,
          t.promptTokens,
          t.completionTokens,
          t.costCents,
          t.latencyMs,
          t.attempts,
          system.clipped || user.clipped || (output?.clipped ?? false),
          new Date().toISOString(),
        ]
      })
      await this.db
        .prepare(
          `INSERT INTO contextual_run_traces
             (run_id, project_id, span_id, label, tier, model, system_prompt,
              user_prompt, output, error, generation_id, prompt_tokens,
              completion_tokens, cost_cents, latency_ms, attempts, truncated,
              created_at)
           VALUES ${placeholders}`,
        )
        .bind(...binds)
        .run()
    } catch (err) {
      // A missing trace costs a user one inspector view, never the run.
      console.error(`[contextual-traces] dropped ${batch.length} row(s):`, err instanceof Error ? err.message : err)
    }
  }

  private async sendPosthog(rows: TraceInput[]): Promise<void> {
    const ph = this.opts.posthog
    // A code-only row (tier "code") is not a generation.
    const batch = rows.filter((t) => t.tier !== "code")
    if (!ph || batch.length === 0) return
    try {
      const events = batch.map((t) => ({
        event: "$ai_generation",
        // Autopilot runs have no acting user mid-run; key events to the run
        // and keep them off person profiles.
        distinct_id: `contextual-run:${this.ctx.runId}`,
        timestamp: new Date().toISOString(),
        properties: {
          $process_person_profile: false,
          $lib: "aquilla-auth-worker",
          $ai_trace_id: this.ctx.runId,
          $ai_span_id: t.spanId || undefined,
          $ai_span_name: t.label || undefined,
          $ai_model: t.model,
          $ai_provider: "openrouter",
          $ai_input_tokens: t.promptTokens,
          $ai_output_tokens: t.completionTokens,
          $ai_total_cost_usd: t.costCents / 100,
          $ai_latency: t.latencyMs / 1000,
          $ai_is_error: t.error !== null,
          ...(ph.content
            ? {
                $ai_input: [
                  { role: "system", content: clip(t.system).text },
                  { role: "user", content: clip(t.user).text },
                ],
                $ai_output_choices: t.output === null
                  ? []
                  : [{ role: "assistant", content: clip(t.output).text }],
              }
            : {}),
          surface: "autopilot",
          run_id: this.ctx.runId,
          project_id: this.ctx.projectId,
          tier: t.tier,
          attempts: t.attempts,
          error_code: t.error ?? undefined,
          input_chars: t.system.length + t.user.length,
          output_chars: t.output?.length ?? 0,
        },
      }))
      const res = await fetch(`${ph.host}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: ph.key, batch: events }),
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      })
      await res.body?.cancel()
    } catch (err) {
      console.error("[contextual-traces] posthog dropped:", err instanceof Error ? err.name : "unknown")
    }
  }
}

interface TraceRow {
  id: number | string
  run_id: string
  span_id: string
  label: string
  tier: string
  model: string
  system_prompt: string
  user_prompt: string
  output: string | null
  error: string | null
  generation_id: string | null
  prompt_tokens: number
  completion_tokens: number
  cost_cents: number
  latency_ms: number
  attempts: number
  truncated: boolean
  created_at: string | Date
}

/**
 * Traces for one run, oldest first, optionally narrowed to a span. Jev rows
 * (label "jev:…", AQU-1690) carry shadow-mode answers that act on nothing
 * yet; only callers that pass `includeJev` (maintainers) see them.
 */
export async function listRunTraces(
  db: AquillaDb,
  input: { projectId: string; runId: string; spanId?: string; limit?: number; includeJev?: boolean },
): Promise<{ traces: ContextualRunTrace[]; truncated: boolean }> {
  const limit = Math.min(Math.max(1, input.limit ?? TRACE_LIST_LIMIT), TRACE_LIST_LIMIT)
  const spanClause = input.spanId ? "AND span_id = ?" : ""
  const jevClause = input.includeJev ? "" : "AND label NOT LIKE 'jev:%'"
  const { results } = await db
    .prepare(
      `SELECT * FROM contextual_run_traces
        WHERE project_id = ? AND run_id = ? ${spanClause} ${jevClause}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`,
    )
    .bind(...[input.projectId, input.runId, ...(input.spanId ? [input.spanId] : []), limit + 1])
    .all<TraceRow>()
  const truncated = results.length > limit
  return {
    truncated,
    traces: results.slice(0, limit).map((r) => ({
      id: Number(r.id),
      runId: r.run_id,
      spanId: r.span_id,
      label: r.label,
      tier: r.tier,
      model: r.model,
      system: r.system_prompt,
      user: r.user_prompt,
      output: r.output,
      error: r.error,
      generationId: r.generation_id,
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      costCents: Number(r.cost_cents),
      latencyMs: Number(r.latency_ms),
      attempts: Number(r.attempts),
      truncated: Boolean(r.truncated),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    })),
  }
}

/** Retention. Called from the 5-minute cron; non-throwing. */
export async function pruneExpiredTraces(db: AquillaDb): Promise<void> {
  try {
    await db
      .prepare(
        `DELETE FROM contextual_run_traces
          WHERE created_at < now() - make_interval(days => ?)`,
      )
      .bind(TRACE_RETENTION_DAYS)
      .run()
  } catch (err) {
    console.error("[contextual-traces] prune failed (non-fatal):", err instanceof Error ? err.message : err)
  }
}
