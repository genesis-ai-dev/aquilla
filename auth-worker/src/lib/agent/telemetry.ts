// telemetry — PostHog events for one in-app agent run (AQU-1467).
//
// Three events, all buffered and sent in ONE request when the run ends:
//   agent_tool_run  one per tool call the loop executes
//   $ai_generation  one per model call (orchestrator turns and tool-internal)
//   $ai_trace       one per run; every generation shares its $ai_trace_id
//
// Data policy: counts only. Nothing a user or the model wrote leaves the
// worker: no prompt, reply, cell text, SQL, search query, or tool result. We
// send lengths in chars instead. The one string we derive from a tool result
// is an error class, and it is scrubbed (see `errorClassOf`).
//
// Contract, same as cost-meter: never throws, never blocks a run. Off when
// POSTHOG_KEY is blank, and then no method does any work.

import { resolvePosthogHost } from "../../posthog-logs"
import type { ToolResultData } from "./tools/types"

export interface AgentTelemetryEnv {
  POSTHOG_KEY?: string
  POSTHOG_HOST?: string
}

export interface AgentTelemetryContext {
  runId: string
  projectId: string
  /** Internal user id, never the email. */
  userId: string | number
  orgId?: number
  model: string
}

export type ToolOutcomeClass = "error" | "nothing-to-do" | "ok"

export interface ToolRunInput {
  tool: string
  args: Record<string, unknown>
  lane?: string
  ok: boolean
  data?: ToolResultData
  /** Read for its first line and length only; never sent. */
  resultText: string
  latencyMs: number
}

export interface GenerationInput {
  span: string
  model: string
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
  latencyMs?: number
  ok: boolean
  httpStatus?: number
  inputChars?: number
  outputChars?: number
}

interface PosthogEvent {
  event: string
  distinct_id: string
  properties: Record<string, unknown>
  timestamp: string
}

const ERROR_CLASS_MAX = 80
const FLUSH_TIMEOUT_MS = 3000

/** Anything that looks like a credential or an address. Matching drops the
 *  whole value: a partial redaction of a token is still a leak. */
const SENSITIVE = /aqk_|eyJ[A-Za-z0-9_-]{10,}|Bearer|sk-or-|@/

/** Returns the value, or undefined when it looks like it carries a secret. */
export function scrubSensitive(value: string): string | undefined {
  return SENSITIVE.test(value) ? undefined : value
}

/**
 * Reduce a tool result to a low-cardinality error label, or undefined.
 * Takes the first line when it starts with `error:` or `tool_error`, strips
 * uuids, quoted text, and digits (so ids, refs, and user strings vanish),
 * collapses whitespace, truncates to 80 chars, then scrubs.
 */
export function errorClassOf(resultText: string): string | undefined {
  const first = resultText.trimStart().split("\n", 1)[0] ?? ""
  if (!/^(error:|tool_error)/i.test(first)) return undefined
  // Scrub the raw line first: a token inside a quoted string must still
  // trip the check even though the quote is about to be stripped.
  if (scrubSensitive(first) === undefined) return undefined
  const cleaned = first
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "")
    .replace(/"[^"]*"/g, "")
    .replace(/`[^`]*`/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ERROR_CLASS_MAX)
  return cleaned ? scrubSensitive(cleaned) : undefined
}

function countOf(data: ToolResultData | undefined): number | undefined {
  if (!data) return undefined
  const list = data.cells ?? data.examples ?? data.hits
  return list ? list.length : undefined
}

const ARG_MAX = 80

/** A tool argument as a short, scrubbed string. The model writes these, so
 *  treat them like any other model output: cap the length and drop secrets. */
function str(v: unknown): string | undefined {
  return typeof v === "string" ? scrubSensitive(v.slice(0, ARG_MAX)) : undefined
}

/** Classify one tool call. `ok` already reflects the code_result frame. */
export function classifyToolRun(input: {
  ok: boolean
  count?: number
  resultText: string
}): ToolOutcomeClass {
  if (!input.ok) return "error"
  const text = input.resultText.trimStart()
  if (input.count === 0 || /^(Nothing to draft|No matches)/.test(text)) return "nothing-to-do"
  return "ok"
}

export interface AgentTelemetry {
  toolRun(input: ToolRunInput): void
  generation(input: GenerationInput): void
  flush(status: "ok" | "capped" | "error"): Promise<void>
}

const NOOP: AgentTelemetry = {
  toolRun() {},
  generation() {},
  async flush() {},
}

export function makeAgentTelemetry(env: AgentTelemetryEnv, ctx: AgentTelemetryContext): AgentTelemetry {
  const key = env.POSTHOG_KEY?.trim()
  if (!key) return NOOP
  return new PosthogAgentTelemetry(key, resolvePosthogHost(env.POSTHOG_HOST), ctx)
}

class PosthogAgentTelemetry implements AgentTelemetry {
  private events: PosthogEvent[] = []
  private readonly startedAt = Date.now()
  private promptTokens = 0
  private completionTokens = 0
  private costUsd = 0
  private generations = 0
  private toolRuns = 0
  private flushed = false

  constructor(
    private readonly key: string,
    private readonly host: string,
    private readonly ctx: AgentTelemetryContext,
  ) {}

  private push(event: string, properties: Record<string, unknown>): void {
    this.events.push({
      event,
      distinct_id: String(this.ctx.userId),
      properties: { ...properties, $lib: "aquilla-auth-worker" },
      timestamp: new Date().toISOString(),
    })
  }

  toolRun(input: ToolRunInput): void {
    try {
      const count = countOf(input.data)
      const outcome = classifyToolRun({ ok: input.ok, count, resultText: input.resultText })
      this.toolRuns++
      this.push("agent_tool_run", {
        tool: input.tool,
        run_id: this.ctx.runId,
        project_id: this.ctx.projectId,
        lane: str(input.lane),
        file_id: str(input.args.fileId),
        // A verse reference such as "MRK 1:1-20": an address, not content.
        ref: str(input.args.ref),
        filter: str(input.args.filter),
        outcome,
        count,
        error_class: outcome === "error" ? errorClassOf(input.resultText) : undefined,
        latency_ms: input.latencyMs,
        result_chars: input.resultText.length,
      })
    } catch {
      /* telemetry must not break the run */
    }
  }

  generation(input: GenerationInput): void {
    try {
      this.generations++
      this.promptTokens += input.promptTokens ?? 0
      this.completionTokens += input.completionTokens ?? 0
      this.costUsd += input.costUsd ?? 0
      this.push("$ai_generation", {
        $ai_trace_id: this.ctx.runId,
        $ai_span_name: input.span,
        $ai_model: input.model,
        $ai_provider: "openrouter",
        $ai_input_tokens: input.promptTokens,
        $ai_output_tokens: input.completionTokens,
        $ai_total_cost_usd: input.costUsd,
        $ai_latency: input.latencyMs === undefined ? undefined : input.latencyMs / 1000,
        $ai_is_error: !input.ok,
        $ai_http_status: input.httpStatus,
        run_id: this.ctx.runId,
        project_id: this.ctx.projectId,
        input_chars: input.inputChars,
        output_chars: input.outputChars,
      })
    } catch {
      /* telemetry must not break the run */
    }
  }

  /** Append the trace event and send everything in one request. Never throws. */
  async flush(status: "ok" | "capped" | "error"): Promise<void> {
    try {
      if (this.flushed) return
      this.flushed = true
      this.push("$ai_trace", {
        $ai_trace_id: this.ctx.runId,
        $ai_span_name: "agent-run",
        $ai_latency: (Date.now() - this.startedAt) / 1000,
        $ai_is_error: status === "error",
        $ai_model: this.ctx.model,
        run_id: this.ctx.runId,
        project_id: this.ctx.projectId,
        org_id: this.ctx.orgId,
        status,
        generations: this.generations,
        tool_runs: this.toolRuns,
        prompt_tokens: this.promptTokens,
        completion_tokens: this.completionTokens,
        total_cost_usd: this.costUsd,
      })
      const batch = this.events
      this.events = []
      const res = await fetch(`${this.host}/batch/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: this.key, batch }),
        signal: AbortSignal.timeout(FLUSH_TIMEOUT_MS),
      })
      // Release the connection; we never read the reply.
      await res.body?.cancel()
    } catch (err) {
      // Dropped events cost us a chart, never the run. Log the class only.
      console.error("[agent-telemetry] dropped events:", err instanceof Error ? err.name : "unknown")
    }
  }
}
