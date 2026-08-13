// tick — the durable run engine's span-tick executor (design §8, slice D1).
//
// One tick = load the run from Postgres → honour pause/terminate → consume
// steering → derive/replay the span cursor → process EXACTLY ONE span through
// slice C's `runSpan` (real callbacks: proposeSceneBrief / lintSpanDraft /
// insertDrafts / OpenRouter fetch) → record the outcome in one guarded UPDATE.
//
// v1 design deviation (documented): there is NO Workflows binding yet. The
// route's selfTickLoop calls runOneTick until {continueRun:false} (or a safety
// cap); because every bit of state (cursor, counters, steering, drafts,
// briefs) is resumable from Postgres, a Workflows driver can wrap this same
// function later with zero schema change.
//
// The LLM is reached ONLY through the injected LlmCall built by makeLlmCall —
// tick tests stub global fetch; e2e uses scripts/mock-openrouter.ts, routed by
// the [[ctx:*]] prompt markers.

import type { AquillaDb } from "../../../../db/shim/postgres"
import {
  getRun,
  failRun,
  confirmPause,
  parkRun,
  recordWaveOutcome,
  setSpanCursor,
  touchRun,
  readUnconsumedSteering,
  markSteeringConsumed,
  insertDrafts,
  findOccupiedCells,
  findProposedCellsFromOtherRuns,
  appendContextualRunEvent,
  type ContextualRun,
  type ContextualRunStatus,
  type ContextualSpanReason,
  type SpanCursor,
  type StoredSpanSeed,
} from "../../../../db/shared/contextual-runs"
import {
  proposeSceneBrief,
  listSceneBriefs,
  markStale,
  getSceneBrief,
} from "../../../../db/shared/scene-briefs"
import { selectCellPairs, type CellPair } from "../agent/tools/select-cells"
import { type LintRule } from "../agent/lint"
import { loadProjectContext, type ProjectContext } from "./project-context"
import { openRouterUsage } from "../llm-vendor"
import { deriveSpanSeeds } from "./segment"
import { lintSpanDraft } from "./lint-node"
import { runSpan, EXAMPLES_TARGET } from "./pipeline"
import type { ExamplePair } from "./draft"
import type { NeighborBrief, LayerAboveBlock } from "./closure"
import type { LlmCall, SpanSeed, SpanPhase, SpanReport, Tier } from "./types"
import { DEFAULT_LLM_MODEL_ID } from "../model-defaults"

// ── Model + endpoint resolution ─────────────────────────────────────────────

export interface ContextualModels {
  fast: string
  mid: string
  deep: string
}

interface ModelEnv {
  CONTEXTUAL_FAST_MODEL?: string
  CONTEXTUAL_DEEP_MODEL?: string
  AGENT_DRAFT_MODEL_DEFAULT?: string
  AGENT_MODEL_DEFAULT?: string
}

/** Tier → model map. mid follows the agent draft-model resolution
 *  (platform_settings.agentDraftModel → env → agent model); deep defaults to
 *  the draft (mid) model until a dedicated deep model is configured. */
export function resolveContextualModels(
  env: ModelEnv,
  settings: { agentModel?: string; agentDraftModel?: string },
): ContextualModels {
  const agentModel = settings.agentModel || env.AGENT_MODEL_DEFAULT || DEFAULT_LLM_MODEL_ID
  const mid = settings.agentDraftModel || env.AGENT_DRAFT_MODEL_DEFAULT || agentModel
  return {
    fast: env.CONTEXTUAL_FAST_MODEL || DEFAULT_LLM_MODEL_ID,
    mid,
    deep: env.CONTEXTUAL_DEEP_MODEL || mid,
  }
}

/** Same override rule as routes/agent.ts resolveOpenRouterUrl — dev/e2e point
 *  OPENROUTER_BASE_URL at scripts/mock-openrouter.ts; prod ignores it. */
export function resolveOpenRouterUrl(env: { OPENROUTER_BASE_URL?: string }): string {
  return env.OPENROUTER_BASE_URL
    ? `${env.OPENROUTER_BASE_URL.replace(/\/$/, "")}/chat/completions`
    : "https://openrouter.ai/api/v1/chat/completions"
}

/** One metered model call. `costCents` is 0 against any non-OpenRouter
 *  upstream (`usage.cost` is an OpenRouter extension — see lib/llm-vendor.ts),
 *  so the cost meter prices `promptTokens`/`completionTokens` offline instead
 *  of trusting this field. */
export interface LlmCallUsage {
  promptTokens: number
  completionTokens: number
  costCents: number
  /** Pipeline node that issued the call (LlmRequest.label); "" if unlabelled. */
  label: string
  /** Span the call belongs to (LlmRequest.spanId); "" outside a span. */
  spanId: string
  tier: Tier
  /** Model actually requested for this tier. */
  model: string
  latencyMs: number
  /** False when the call threw or returned no usage block — a failed call
   *  still costs wall-clock and still burdens the run's budget. */
  ok: boolean
  /** llama.cpp/llama-swap `timings.predicted_per_second`, when the upstream
   *  reports it. Absent for OpenRouter. */
  tokensPerSecond?: number
}

/** Bounded-concurrency gate. `limit <= 0` disables it entirely (no queueing,
 *  no bookkeeping) so the OpenRouter path behaves exactly as before. */
function makeGate(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (limit <= 0) return (fn) => fn()
  let active = 0
  const waiting: (() => void)[] = []
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve))
    active++
    try {
      return await fn()
    } finally {
      active--
      waiting.shift()?.()
    }
  }
}

/** Build the pipeline's LlmCall over the OpenRouter chat-completions API
 *  (non-streaming). Throws on transport/HTTP errors — runSpan's nodes treat a
 *  throw as that call failing, and the tick records the span outcome.
 *
 *  `onUsage` fires exactly once per call, including on failure, so the cost
 *  meter counts attempts rather than successes: a model that fails a parse and
 *  forces a retry costs twice, and a ledger that only recorded successes would
 *  hide that. It must never throw — it is called from the LLM hot path. */
export function makeLlmCall(cfg: {
  url: string
  apiKey: string
  models: ContextualModels
  signal?: AbortSignal
  onUsage?: (u: LlmCallUsage) => void
  /** Cap on HTTP requests in flight through THIS LlmCall at any moment.
   *  0/undefined = uncapped (the OpenRouter default). */
  maxInFlight?: number
}): LlmCall {
  // Span concurrency is not request concurrency: one span fans its verifier
  // panel out three-wide, so N spans burst to ~3N requests. Against an upstream
  // with a fixed slot count that burst is rejected outright, and retrying it
  // just re-collides. Gate here, where every node's call converges, so the
  // wave width stays a scheduling decision and this stays the hard limit.
  const gate = makeGate(cfg.maxInFlight ?? 0)
  return async (req) => {
    const model = cfg.models[req.tier as Tier]
    // Per-ATTEMPT, so a retry's recorded latency is its own round-trip and not
    // the backoff it waited through. Reset at the top of each attempt below.
    let startedAt = Date.now()
    const report = (
      u: Omit<LlmCallUsage, "label" | "spanId" | "tier" | "model" | "latencyMs">,
    ): void => {
      if (!cfg.onUsage) return
      try {
        cfg.onUsage({
          ...u,
          label: req.label ?? "",
          spanId: req.spanId ?? "",
          tier: req.tier as Tier,
          model,
          latencyMs: Date.now() - startedAt,
        })
      } catch {
        /* the meter must never break the run it is measuring */
      }
    }
    const failed = { promptTokens: 0, completionTokens: 0, costCents: 0, ok: false }

    // Capacity rejections are NOT model failures. A busy upstream (OpenRouter
    // rate limit, or a self-hosted server whose slots are all occupied) answers
    // in milliseconds with no tokens spent, but the pipeline treats a throw as
    // the node failing — and a rejected `ambiguity` verifier fails its whole
    // span. Wait for a slot instead. Each attempt is still metered, so
    // contention stays visible rather than being smoothed away.
    const requestBody = JSON.stringify({
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens,
      temperature: req.temperature,
      ...openRouterUsage(cfg.url),
    })
    const RETRIABLE = new Set([429, 500, 502, 503, 504])
    const MAX_ATTEMPTS = 5

    interface UpstreamBody {
      choices?: { message?: { content?: string | null } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
      timings?: { predicted_per_second?: number }
    }
    type Attempt =
      | { ok: true; body: UpstreamBody }
      | { ok: false; status: number; code: "http_error" | "invalid_response" }

    let body!: UpstreamBody
    for (let attempt = 1; ; attempt++) {
      startedAt = Date.now()
      let outcome: Attempt
      try {
        // The gate holds a slot only for the round-trip, never across the
        // backoff below — a sleeping retry must not occupy capacity.
        outcome = await gate<Attempt>(async () => {
          const res = await fetch(cfg.url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${cfg.apiKey}`,
              "Content-Type": "application/json",
            },
            body: requestBody,
            ...(cfg.signal ? { signal: cfg.signal } : {}),
          })
          if (!res.ok) {
            // Provider bodies are untrusted and may echo credentials, prompts,
            // or user text. Never materialize them in an Error that can reach
            // the durable run row or a live progress frame.
            try {
              await res.body?.cancel()
            } catch {
              /* cancellation is cleanup only */
            }
            return { ok: false, status: res.status, code: "http_error" }
          }
          try {
            return { ok: true, body: (await res.json()) as UpstreamBody }
          } catch {
            return { ok: false, status: res.status, code: "invalid_response" }
          }
        })
      } catch {
        report(failed)
        throw new Error(cfg.signal?.aborted ? "provider_request_aborted" : "provider_transport_error")
      }
      if (outcome.ok) {
        body = outcome.body
        break
      }

      report(failed)
      if (
        outcome.code === "invalid_response"
        || !RETRIABLE.has(outcome.status)
        || attempt >= MAX_ATTEMPTS
        || cfg.signal?.aborted
      ) {
        const code = outcome.code === "invalid_response"
          ? "provider_invalid_response"
          : "provider_http_error"
        throw new Error(`${code} status=${outcome.status}`)
      }
      // Exponential backoff with jitter — without the jitter every rejected
      // lane in a wave would wake at the same instant and collide again.
      const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 8000) * (0.5 + Math.random())
      await new Promise((r) => setTimeout(r, backoffMs))
    }
    const tps = body.timings?.predicted_per_second
    report({
      promptTokens: body.usage?.prompt_tokens ?? 0,
      completionTokens: body.usage?.completion_tokens ?? 0,
      costCents: (body.usage?.cost ?? 0) * 100,
      ok: body.usage !== undefined,
      ...(typeof tps === "number" ? { tokensPerSecond: tps } : {}),
    })
    return body.choices?.[0]?.message?.content ?? ""
  }
}

// ── Progress frames (shapes mirror src/lib/contextual/run-store.ts) ─────────

export interface ContextualRunStateFrame {
  type: "contextual.run.state"
  runId: string
  fileId: string
  targetLang: string
  status: ContextualRunStatus
  done: number
  total: number
  failed?: number
}

export interface ContextualSceneFrame {
  type: "contextual.scene"
  runId: string
  sceneBriefId: string
  spanLabel: string
  ambiguityCount: number
  /** Which lane this belongs to (a wave runs several spans at once). */
  spanId?: string
}

export interface ContextualSpanFrame {
  type: "contextual.span"
  runId: string
  spanLabel: string
  staged: number
  skipped: number
  verdictSummary: string
  spanId?: string
  /** Sanitized durable outcome fields. `verdictSummary` remains a live-display
   * string; persistence records only this categorical subset. */
  outcome?: "complete" | "partial" | "failed"
  reasons?: ContextualSpanReason[]
  calls?: number
  units?: number
}

/** A lane OPENS. Emitted before any model call, so the UI never shows dead air
 *  while the closure loop reads context (the slowest phase of a span). */
export interface ContextualSpanStartFrame {
  type: "contextual.span.start"
  runId: string
  fileId: string
  targetLang: string
  spanId: string
  spanLabel: string
}

/** Within-lane phase movement — decoration only, never a control signal. */
export interface ContextualPhaseFrame {
  type: "contextual.phase"
  runId: string
  spanId: string
  spanLabel: string
  phase: SpanPhase
}

/** THE payload the user is waiting for: text that just cleared verification
 *  and landed as a reviewable draft. Batched per span (a wave stages tens of
 *  cells at once) and capped — the client refetches the tail from
 *  GET …/contextual/drafts when `truncated` is set. */
export interface ContextualDraftsFrame {
  type: "contextual.drafts"
  runId: string
  fileId: string
  /** Empty string is Project default. Consumers fail closed when this does
   *  not match the editor's attached language lane. */
  targetLang: string
  spanId?: string
  spanLabel: string
  /** Authoritative staged count when the draft payload below is capped. */
  draftCount?: number
  drafts: { draftId: string; cellId: string; text: string }[]
  truncated?: boolean
}

export type ContextualProgressFrame =
  | ContextualRunStateFrame
  | ContextualSceneFrame
  | ContextualSpanFrame
  | ContextualSpanStartFrame
  | ContextualPhaseFrame
  | ContextualDraftsFrame

/** Frame-size guards: a draft burst must not turn one span into a megabyte of
 *  WebSocket traffic. Beyond these the client refetches the authoritative list. */
export const MAX_DRAFTS_PER_FRAME = 40
export const MAX_DRAFT_TEXT_CHARS = 2000

export function runStateFrame(run: ContextualRun): ContextualRunStateFrame {
  return {
    type: "contextual.run.state",
    runId: run.id,
    fileId: run.fileId,
    targetLang: run.targetLang,
    status: run.status,
    done: run.doneSpans,
    total: run.totalSpans,
    failed: run.failedSpans,
  }
}

/** Persist one live progress frame as a bounded product-activity fact. The
 * draft frame intentionally loses draft ids/text here: only count + cell ids
 * cross the durable telemetry boundary. */
export async function persistContextualProgressFrame(
  db: AquillaDb,
  scope: { projectId: string; fileId: string },
  frame: ContextualProgressFrame,
): Promise<void> {
  switch (frame.type) {
    case "contextual.run.state":
      await appendContextualRunEvent(db, {
        runId: frame.runId,
        projectId: scope.projectId,
        fileId: scope.fileId,
        kind: "run_state",
        status: frame.status,
        details: { done: frame.done, total: frame.total, failed: frame.failed ?? 0 },
      })
      return
    case "contextual.span.start":
      await appendContextualRunEvent(db, {
        runId: frame.runId,
        projectId: scope.projectId,
        fileId: scope.fileId,
        kind: "span_started",
        spanId: frame.spanId,
        spanLabel: frame.spanLabel,
        status: "started",
      })
      return
    case "contextual.phase":
      await appendContextualRunEvent(db, {
        runId: frame.runId,
        projectId: scope.projectId,
        fileId: scope.fileId,
        kind: "phase",
        spanId: frame.spanId,
        spanLabel: frame.spanLabel,
        phase: frame.phase,
      })
      return
    case "contextual.scene":
      await appendContextualRunEvent(db, {
        runId: frame.runId,
        projectId: scope.projectId,
        fileId: scope.fileId,
        kind: "scene_ready",
        spanId: frame.spanId,
        spanLabel: frame.spanLabel,
        status: "complete",
        details: {
          sceneBriefId: frame.sceneBriefId,
          ambiguityCount: frame.ambiguityCount,
        },
      })
      return
    case "contextual.drafts":
      await appendContextualRunEvent(db, {
        runId: frame.runId,
        projectId: scope.projectId,
        fileId: scope.fileId,
        kind: "drafts_staged",
        spanId: frame.spanId,
        spanLabel: frame.spanLabel,
        status: "complete",
        details: {
          count: frame.draftCount ?? frame.drafts.length,
          cellIds: frame.drafts.map((draft) => draft.cellId),
          truncated: frame.truncated === true,
        },
      })
      return
    case "contextual.span":
      await appendContextualRunEvent(db, {
        runId: frame.runId,
        projectId: scope.projectId,
        fileId: scope.fileId,
        kind: "span_outcome",
        spanId: frame.spanId,
        spanLabel: frame.spanLabel,
        status: frame.outcome ?? "complete",
        details: {
          staged: frame.staged,
          skipped: frame.skipped,
          reasons: frame.reasons,
          calls: frame.calls,
          units: frame.units,
        },
      })
  }
}

// ── Wave sizing + ordering ──────────────────────────────────────────────────

/** Ceiling on spans a single run drives concurrently. */
export const MAX_WAVE_CONCURRENCY = 6
/** Below this many remaining spans a run stays serial: a graph pays scheduling
 *  and burst-rate overhead a chain does not, and on small files that overhead
 *  is the whole cost. Wide work is where fan-out pays. */
const SPANS_PER_LANE = 8

/** How many spans to run at once, given how much work is left. */
export function waveSize(spansRemaining: number, cap: number = MAX_WAVE_CONCURRENCY): number {
  if (spansRemaining <= 1) return 1
  const ceiling = Math.max(1, Math.min(cap, MAX_WAVE_CONCURRENCY))
  return Math.max(1, Math.min(ceiling, Math.ceil(spansRemaining / SPANS_PER_LANE)))
}

/**
 * Rotate the seed list so the span covering `anchorCellId` runs FIRST, with
 * document order preserved from there and wrapping to the top.
 *
 * Coverage is identical — every seed still runs exactly once — but the first
 * results land where the user is already looking instead of at the top of a
 * file they may be nowhere near. Perceived latency is the product metric here;
 * total latency is unchanged.
 */
export function orderSeedsFromAnchor(
  seeds: StoredSpanSeed[],
  anchorCellId: string | null | undefined,
  pairs: CellPair[],
): StoredSpanSeed[] {
  if (!anchorCellId || seeds.length < 2) return seeds
  const order = new Map(pairs.map((p, i) => [p.cellId, i]))
  const anchorPos = order.get(anchorCellId)
  if (anchorPos === undefined) return seeds
  const hit = seeds.findIndex((s) => {
    const start = order.get(s.startCellId)
    const end = order.get(s.endCellId)
    return start !== undefined && end !== undefined && anchorPos >= start && anchorPos <= end
  })
  if (hit <= 0) return seeds
  return [...seeds.slice(hit), ...seeds.slice(0, hit)]
}

// ── Span label ("LUK 1:1–1:8") — display only, never authoritative ──────────

function spanLabel(seed: StoredSpanSeed, pairs: CellPair[]): string {
  const byId = new Map(pairs.map((p) => [p.cellId, p]))
  const start = byId.get(seed.startCellId)
  const end = byId.get(seed.endCellId)
  if (start?.canonicalRef && end?.canonicalRef) {
    return start.canonicalRef === end.canonicalRef
      ? start.canonicalRef
      : `${start.canonicalRef}–${end.canonicalRef}`
  }
  return `${seed.startCellId.slice(0, 8)}…${seed.endCellId.slice(0, 8)}`
}

// ── Context assembly ────────────────────────────────────────────────────────
//
// Project context now comes from lib/contextual/project-context.ts, which
// reads the whole settings blob rather than just the brief's L1 summary. That
// is where the project's TERMINOLOGY lives — key-term decisions that used to
// be compiled to rules client-side only, so no server-side draft or lint ever
// saw them.

/** Approved briefs adjacent to the seed, sided by document position. */
async function loadNeighborBriefs(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  targetLang: string,
  seed: StoredSpanSeed,
  pairs: CellPair[],
): Promise<NeighborBrief[]> {
  try {
    const approved = await listSceneBriefs(db, projectId, {
      fileId,
      status: "approved",
      targetLang,
    })
    const order = new Map(pairs.map((p, i) => [p.cellId, i]))
    const seedStart = order.get(seed.startCellId) ?? 0
    const out: NeighborBrief[] = []
    for (const b of approved) {
      const pos = order.get(b.startCellId)
      if (pos === undefined || !b.l1Summary) continue
      // Skip a brief covering the seed's own span (re-work path).
      if (b.startCellId === seed.startCellId && b.endCellId === seed.endCellId) continue
      out.push({ id: b.id, l1Summary: b.l1Summary, side: pos < seedStart ? "before" : "after" })
    }
    return out
  } catch {
    return []
  }
}

function validatedExamples(pairs: CellPair[]): ExamplePair[] {
  return pairs
    .filter((p) => p.validated && p.target.trim())
    .slice(0, EXAMPLES_TARGET)
    .map((p) => ({ cellId: p.cellId, source: p.source, target: p.target, validated: true }))
}

// ── Steering ────────────────────────────────────────────────────────────────

interface SteeringOutcome {
  directions: string[]
  /** Entry ids of the directions above — consumed by the caller ONLY when a
   *  span actually runs. A direction sent to an exhausted run must stay
   *  queued (visible as a chip) until there is a span for it to shape;
   *  consuming it on a park-only wake would swallow it with zero effect. */
  directionIds: string[]
  /** Seeds re-enqueued by refresh_span (appended to the cursor). */
  refreshedSeeds: StoredSpanSeed[]
}

/** Read the run's unconsumed steering. refresh_span entries (body =
 *  sceneBriefId) mark the brief stale, re-enqueue the matching span, and are
 *  consumed here along with notes (recorded-for-humans only). Directions are
 *  returned UNCONSUMED — the tick consumes them only when a span runs. */
async function consumeSteering(
  db: AquillaDb,
  run: ContextualRun,
  cursor: SpanCursor | null,
): Promise<SteeringOutcome> {
  const entries = await readUnconsumedSteering(db, {
    projectId: run.projectId,
    fileId: run.fileId,
    runId: run.id,
  })
  const directions: string[] = []
  const directionIds: string[] = []
  const consumedNow: string[] = []
  const refreshedSeeds: StoredSpanSeed[] = []
  for (const e of entries) {
    if (e.kind === "direction") {
      directions.push(e.body)
      directionIds.push(e.id)
    } else if (e.kind === "refresh_span") {
      const briefId = e.body.trim()
      const brief = await getSceneBrief(db, briefId)
      if (
        brief &&
        brief.projectId === run.projectId &&
        brief.fileId === run.fileId &&
        brief.targetLang === run.targetLang
      ) {
        await markStale(db, briefId, "steering-refresh")
        const seed = cursor?.seeds.find(
          (s) => s.startCellId === brief.startCellId && s.endCellId === brief.endCellId,
        )
        if (seed) refreshedSeeds.push(seed)
      }
      consumedNow.push(e.id)
    } else {
      // kind === "note": consumed without pipeline effect (a message to humans).
      consumedNow.push(e.id)
    }
  }
  if (consumedNow.length > 0) await markSteeringConsumed(db, consumedNow)
  return { directions, directionIds, refreshedSeeds }
}

// ── The tick ────────────────────────────────────────────────────────────────

export interface TickDeps {
  db: AquillaDb
  runId: string
  llm: LlmCall
  /** Best-effort progress notification (sync-worker DO fan-out). */
  notify?: (frame: ContextualProgressFrame) => Promise<void>
  signal?: AbortSignal
  /** Spans to drive concurrently this wave. Defaults to `waveSize()` over the
   *  remaining spans; pass 1 to force the original strictly-serial behaviour. */
  concurrency?: number
}

export interface TickResult {
  continueRun: boolean
  status: string
  /** The wave's LAST span report — kept singular for callers written against
   *  the one-span-per-tick contract. `reports` carries the whole wave. */
  report?: SpanReport
  reports?: SpanReport[]
}

/** Shared per-run context, loaded ONCE per wave rather than once per span. */
interface RunContext {
  ctx: ProjectContext
  rules: LintRule[]
  pairs: CellPair[]
  layerAbove: LayerAboveBlock[]
  excludedCellIds: Set<string>
  scope: {
    projectId: string
    fileId: string
    targetLang: string
    orderedCellIds: string[]
    untranslatedCellIds: string[]
    fileKind: string
  }
}

interface SpanOutcome {
  outcome: "done" | "failed"
  lastError: string | null
  report?: SpanReport
}

/** Reduce pipeline/model prose to a stable categorical vocabulary before it
 * reaches durable activity. This preserves the reason a user can act on
 * without persisting verifier reasoning or upstream response text. */
function spanReasonCodes(
  report: SpanReport | undefined,
  outcome: "done" | "failed",
  occupiedAtStage: number,
): ContextualSpanReason[] {
  const reasons = new Set<ContextualSpanReason>()
  if (outcome === "failed") reasons.add("span_failed")
  if (occupiedAtStage > 0) reasons.add("target_already_filled")
  for (const reason of report?.incompleteReasons ?? []) {
    if (reason.startsWith("scene construal did not close")) reasons.add("scene_construal_incomplete")
    else if (reason.startsWith("draft attempt")) reasons.add("draft_failed")
    else if (reason.startsWith("verifier barrier unmet")) reasons.add("verification_unavailable")
  }
  for (const skipped of report?.cellsSkipped ?? []) {
    if (skipped.reason.startsWith("construal incomplete")) reasons.add("scene_construal_incomplete")
    else if (skipped.reason.startsWith("draft failed")) reasons.add("draft_failed")
    else if (skipped.reason.startsWith("no draft returned")) reasons.add("no_draft_returned")
    else if (skipped.reason.startsWith("verification unavailable")) reasons.add("verification_unavailable")
    else if (skipped.reason.startsWith("rejected by quorum twice")) reasons.add("rejected_by_quorum")
  }
  return [...reasons]
}

/**
 * Drive ONE span end to end, emitting live frames as it goes. Pure with
 * respect to the run row — the caller records every outcome in one guarded
 * write, so a wave's spans never race each other on the counters.
 */
async function processSpan(
  deps: TickDeps,
  run: ContextualRun,
  shared: RunContext,
  storedSeed: StoredSpanSeed,
  steeringDirections: string[],
  notify: (frame: ContextualProgressFrame) => Promise<void>,
): Promise<SpanOutcome> {
  const { db } = deps
  const seed: SpanSeed = {
    id: storedSeed.id,
    fileId: storedSeed.fileId,
    anchorCellId: storedSeed.anchorCellId,
    startCellId: storedSeed.startCellId,
    endCellId: storedSeed.endCellId,
    seedSource: storedSeed.seedSource as SpanSeed["seedSource"],
  }
  const label = spanLabel(storedSeed, shared.pairs)

  // The lane opens BEFORE the closure loop's first model call — otherwise the
  // UI shows nothing at all through the slowest phase of the span.
  await notify({
    type: "contextual.span.start",
    runId: run.id,
    fileId: run.fileId,
    targetLang: run.targetLang,
    spanId: seed.id,
    spanLabel: label,
  })

  const neighborBriefs = await loadNeighborBriefs(
    db,
    run.projectId,
    run.fileId,
    run.targetLang,
    storedSeed,
    shared.pairs,
  )

  let outcome: "done" | "failed" = "done"
  let lastError: string | null = null
  let report: SpanReport | undefined
  let occupiedAtStage = 0
  let phaseActivity = Promise.resolve()
  try {
    report = await runSpan({
      seed,
      scope: shared.scope,
      pairs: shared.pairs,
      excludedCellIds: shared.excludedCellIds,
      neighborBriefs,
      layerAbove: shared.layerAbove,
      examples: validatedExamples(shared.pairs),
      ...(shared.ctx.projectBriefL1 ? { projectBriefL1: shared.ctx.projectBriefL1 } : {}),
      // The brief's own answers carry when nobody generated an L1 summary, and
      // the concepts get scoped to this span's source text inside runSpan.
      briefParameters: shared.ctx.briefParameters,
      ...(shared.ctx.concepts.length > 0 ? { concepts: shared.ctx.concepts } : {}),
      ...(steeringDirections.length > 0 ? { steeringDirections } : {}),
      rules: shared.rules,
      ...(shared.ctx.sourceLanguage ? { sourceLanguage: shared.ctx.sourceLanguage } : {}),
      ...(run.targetLang || shared.ctx.targetLanguage
        ? { targetLanguage: run.targetLang || shared.ctx.targetLanguage }
        : {}),
      // Tag every call this span makes, for cost attribution. A wave runs
      // several spans concurrently, so the span id must ride the request
      // rather than live in shared mutable state.
      llm: (req) => deps.llm({ ...req, spanId: seed.id }),
      onPhase: (phase: SpanPhase) => {
        // RunSpan's phase callback is synchronous, so serialize the async
        // durable writes here and drain them before the span outcome. Failure
        // remains decorative (never breaks translation work), matching the
        // callback's existing contract.
        phaseActivity = phaseActivity
          .then(() =>
            notify({
              type: "contextual.phase",
              runId: run.id,
              spanId: seed.id,
              spanLabel: label,
              phase,
            }),
          )
          .catch(() => {})
      },
      persistBrief: async (brief) => {
        const proposed = await proposeSceneBrief(db, {
          projectId: run.projectId,
          fileId: run.fileId,
          startCellId: brief.startCellId,
          endCellId: brief.endCellId,
          targetLang: run.targetLang,
          construal: brief.l2Construal,
          ambiguityRegister: brief.ambiguityRegister,
          l1Summary: brief.l1Summary,
          provenance: {
            runId: run.id,
            spanSeedSource: seed.seedSource,
            closureRounds: brief.provenance.closureRounds,
            windowCellIds: brief.provenance.windowCellIds,
          },
          createdBy: run.initiatedBy,
        })
        if (proposed.status !== "ok") {
          throw new Error(`scene brief rejected: ${proposed.message}`)
        }
        await notify({
          type: "contextual.scene",
          runId: run.id,
          sceneBriefId: proposed.brief.id,
          spanLabel: label,
          ambiguityCount: brief.ambiguityRegister.length,
          spanId: seed.id,
        })
        return proposed.brief.id
      },
      lint: async (draft) => lintSpanDraft(shared.rules, shared.pairs, draft, shared.ctx.concepts),
      stage: async (draft) => {
        // Anti-clobber, checked as late as possible: a human may have typed
        // into one of these cells while the span was running. `pairs` is a
        // snapshot from wave start, so re-read the live targets and drop any
        // cell that gained one. Drafts are proposals, never commits — but a
        // proposal over someone's fresh work is still noise they must dismiss.
        const occupied = await findOccupiedCells(db, {
          projectId: run.projectId,
          fileId: run.fileId,
          cellIds: draft.cells.map((c) => c.cellId),
          targetLang: run.targetLang,
        })
        occupiedAtStage += occupied.size
        const fresh = draft.cells.filter((c) => !occupied.has(c.cellId))
        if (fresh.length === 0) {
          return { proposalId: "", spanId: draft.spanId, stagedCellIds: [], verdicts: {} }
        }
        const staged = await insertDrafts(db, {
          runId: run.id,
          projectId: run.projectId,
          fileId: run.fileId,
          sceneBriefId: draft.sceneBriefId,
          drafts: fresh.map((c) => ({
            cellId: c.cellId,
            text: c.text,
            provenance: {
              spanId: draft.spanId,
              promptVersion: draft.promptVersion,
              exampleIds: draft.exampleIds,
            },
          })),
        })
        // The moment that makes the feature legible: verified text, streamed
        // to every open editor on this project.
        if (staged.length > 0) {
          // Live frames are an optimization, never the authoritative review
          // payload. Do not send a cropped suggestion that the editor could
          // mistake for the full text stored in Postgres. Omit oversized
          // entries and mark the frame incomplete so the client refetches the
          // exact draft before exposing any review action.
          const frameDrafts = staged
            .slice(0, MAX_DRAFTS_PER_FRAME)
            .filter((draft) => draft.text.length <= MAX_DRAFT_TEXT_CHARS)
            .map((draft) => ({
              draftId: draft.id,
              cellId: draft.cellId,
              text: draft.text,
            }))
          const frameIsTruncated =
            staged.length > MAX_DRAFTS_PER_FRAME ||
            frameDrafts.length !== Math.min(staged.length, MAX_DRAFTS_PER_FRAME)
          await notify({
            type: "contextual.drafts",
            runId: run.id,
            fileId: run.fileId,
            targetLang: run.targetLang,
            spanId: seed.id,
            spanLabel: label,
            draftCount: staged.length,
            drafts: frameDrafts,
            ...(frameIsTruncated ? { truncated: true } : {}),
          })
        }
        return {
          proposalId: staged[0]?.id ?? crypto.randomUUID(),
          spanId: draft.spanId,
          stagedCellIds: staged.map((d) => d.cellId),
          verdicts: {},
        }
      },
    })
    await phaseActivity
    const skippedCount = report.cellsSkipped.length
    if (skippedCount > 0) {
      // A named skip is unfinished work even when sibling cells staged cleanly.
      // Keep the useful partial proposals, but account the passage in the
      // failure counter so the overview cannot call it a clean completion.
      outcome = "failed"
      lastError = report.cellsStaged.length > 0
        ? "Some cells could not be drafted and need attention."
        : "This passage could not produce a reviewable draft."
    } else if (report.incomplete && report.cellsStaged.length === 0) {
      outcome = "failed"
      lastError = report.incompleteReasons.join("; ").slice(0, 2000) || "span incomplete"
    }
  } catch (err) {
    await phaseActivity
    outcome = "failed"
    lastError = (err instanceof Error ? err.message : String(err)).slice(0, 2000)
  }

  const skippedCount = report?.cellsSkipped.length ?? 0
  const stagedCount = report?.cellsStaged.length ?? 0
  // Event outcome describes the evidence produced; aggregate outcome above
  // describes whether the passage needs attention. A partially staged span
  // with named skips is therefore `partial` evidence but one failed passage.
  const eventOutcome = skippedCount > 0
    ? stagedCount > 0 ? "partial" : "failed"
    : outcome === "failed"
      ? "failed"
      : report?.incomplete || occupiedAtStage > 0
        ? "partial"
        : "complete"
  const reasons = spanReasonCodes(report, outcome, occupiedAtStage)
  await notify({
    type: "contextual.span",
    runId: run.id,
    spanLabel: label,
    staged: stagedCount,
    skipped: skippedCount + occupiedAtStage,
    // Only stable categories cross the activity boundary. Verifier/model
    // prose remains inside the transient report and is never persisted.
    verdictSummary: eventOutcome === "complete"
      ? "complete"
      : `${eventOutcome}: ${reasons.join(", ") || "attention_required"}`,
    spanId: seed.id,
    outcome: eventOutcome,
    ...(reasons.length > 0 ? { reasons } : {}),
    ...(report ? { calls: report.callsUsed, units: report.unitsUsed } : {}),
  })

  return { outcome, lastError, ...(report ? { report } : {}) }
}

/**
 * Process ONE WAVE of the run — up to `concurrency` spans driven at the same
 * time — then return whether the caller's loop should continue.
 *
 * Spans are independent by construction: the only cross-span edge is
 * `loadNeighborBriefs`, which reads APPROVED briefs only, so nothing a wave
 * produces feeds anything else in the same wave. Ordering them was buying
 * nothing but wall-clock.
 *
 * Durability is unchanged: the cursor advances past the whole wave in ONE
 * guarded write, so a crash mid-wave replays that wave's spans (re-proposing
 * drafts is idempotent per cell) and never skips one.
 */
export async function runOneTick(deps: TickDeps): Promise<TickResult> {
  const { db, runId } = deps
  const externalNotify = deps.notify ?? (async () => {})
  const run = await getRun(db, runId)
  if (!run) return { continueRun: false, status: "not_found" }
  const notify = async (frame: ContextualProgressFrame): Promise<void> => {
    try {
      await persistContextualProgressFrame(
        db,
        { projectId: run.projectId, fileId: run.fileId },
        frame,
      )
    } catch (err) {
      // Observability is durable when healthy, never a control dependency.
      // In particular, a code-before-migration deploy must not fail a span.
      console.warn(`[contextual] activity append failed for run ${run.id}/${frame.type}:`, err)
    }
    try {
      await externalNotify(frame)
    } catch (err) {
      // The relay is a live-view optimization. Snapshot/activity persistence
      // remains authoritative, so a collaborator broadcast outage must never
      // turn otherwise valid drafting work into a failed passage.
      console.warn(`[contextual] live notification failed for run ${run.id}/${frame.type}:`, err)
    }
  }

  // Pause/terminate honoured at the span edge — never mid-span.
  if (run.status === "pausing") {
    const t = await confirmPause(db, runId)
    if (t.status === "ok") await notify(runStateFrame(t.run))
    return { continueRun: false, status: "paused" }
  }
  if (run.status !== "running") {
    return { continueRun: false, status: run.status }
  }

  // Scope + cursor. Pairs are re-read every wave (cells move under the run);
  // seeds are pinned in the cursor so segmentation never shifts mid-run.
  const [pairs, excludedCellIds] = await Promise.all([
    selectCellPairs(db, run.projectId, { fileId: run.fileId, targetLang: run.targetLang }),
    findProposedCellsFromOtherRuns(db, {
      projectId: run.projectId,
      fileId: run.fileId,
      runId: run.id,
      targetLang: run.targetLang,
    }),
  ])
  let cursor = run.spanCursor
  if (!cursor) {
    // First wave: derive the segmentation, then rotate it so work starts where
    // the user was last looking (run.anchorCellId, set at start).
    const seeds = orderSeedsFromAnchor(deriveSpanSeeds(run.fileId, pairs), run.anchorCellId, pairs)
    cursor = { seeds, nextIndex: 0 }
    const updated = await setSpanCursor(db, runId, cursor)
    if (updated) await notify(runStateFrame(updated))
  }

  // Steering (directions + refresh_span re-enqueues) before picking the wave.
  const steering = await consumeSteering(db, run, cursor)
  if (steering.refreshedSeeds.length > 0) {
    cursor = { seeds: [...cursor.seeds, ...steering.refreshedSeeds], nextIndex: cursor.nextIndex }
    await setSpanCursor(db, runId, cursor)
  }

  if (cursor.nextIndex >= cursor.seeds.length) {
    // Exhausted work parks so successful drafts stay reviewable on a live run.
    // A run that produced nothing at all still fails, so Play can start fresh.
    const t = run.failedSpans > 0 && run.doneSpans === 0
      ? await failRun(db, runId, run.lastError ?? "One or more passages need attention.")
      : await parkRun(db, runId)
    if (t.status === "ok") await notify(runStateFrame(t.run))
    return { continueRun: false, status: t.status === "ok" ? t.run.status : run.status }
  }

  // Spans WILL run this wave — the queued directions now take effect, so
  // consume them (exactly-once across waves).
  if (steering.directionIds.length > 0) {
    await markSteeringConsumed(db, steering.directionIds)
  }

  // Per-run context is loaded ONCE and shared by every span in the wave
  // (it was re-fetched per span before, which was pure overhead).
  const ctx = await loadProjectContext(db, run.projectId)
  const layerAbove: LayerAboveBlock[] = ctx.projectBriefL1
    ? [{ ref: "project-brief", text: ctx.projectBriefL1 }]
    : []
  const rules: LintRule[] = ctx.authoredRules
  const shared: RunContext = {
    ctx,
    rules,
    pairs,
    layerAbove,
    excludedCellIds,
    scope: {
      projectId: run.projectId,
      fileId: run.fileId,
      targetLang: run.targetLang,
      orderedCellIds: pairs.map((p) => p.cellId),
      untranslatedCellIds: pairs
        .filter((p) => !p.target.trim() && !excludedCellIds.has(p.cellId))
        .map((p) => p.cellId),
      fileKind: "",
    },
  }

  const remaining = cursor.seeds.length - cursor.nextIndex
  const width = Math.max(1, Math.min(deps.concurrency ?? waveSize(remaining), remaining))
  const wave = cursor.seeds.slice(cursor.nextIndex, cursor.nextIndex + width)

  // Heartbeat before a long wave so the stranded-run sweeper doesn't mistake
  // work in flight for a dead driver.
  await touchRun(db, runId)

  // One lane's unexpected throw must cost exactly one span. Without this
  // catch a single rejection takes down `Promise.all`, so the wave's other
  // spans lose their work AND the cursor never advances — the run would
  // replay the same failing wave forever instead of recording the failure and
  // moving on. `processSpan` already handles pipeline errors; this covers the
  // paths outside it (a throwing progress reporter, a dropped connection).
  const outcomes = await Promise.all(
    wave.map((storedSeed) =>
      processSpan(deps, run, shared, storedSeed, steering.directions, notify).catch(
        (err: unknown): SpanOutcome => ({
          outcome: "failed",
          lastError: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
        }),
      ),
    ),
  )

  const reports = outcomes.flatMap((o) => (o.report ? [o.report] : []))
  const doneCount = outcomes.filter((o) => o.outcome === "done").length
  const failedCount = outcomes.length - doneCount
  const lastError = outcomes.filter((o) => o.lastError).map((o) => o.lastError).pop() ?? null

  const advanced: SpanCursor = { seeds: cursor.seeds, nextIndex: cursor.nextIndex + wave.length }
  const after = await recordWaveOutcome(db, runId, {
    cursor: advanced,
    doneCount,
    failedCount,
    unitsUsed: reports.reduce((n, r) => n + r.unitsUsed, 0),
    callsUsed: reports.reduce((n, r) => n + r.callsUsed, 0),
    lastError,
    steeringCursor: new Date().toISOString(),
  })

  const lastReport = reports[reports.length - 1]
  const result = (continueRun: boolean, status: string): TickResult => ({
    continueRun,
    status,
    ...(lastReport ? { report: lastReport } : {}),
    ...(reports.length > 0 ? { reports } : {}),
  })

  // Continue only while the run is STILL running (a pause/terminate landed
  // mid-wave loses nothing). A pause needs acknowledgement at THIS edge:
  // returning `pausing` would stop the loop and strand the run because the
  // sweeper intentionally adopts only running/parked work.
  let fresh = after ?? (await getRun(db, runId))
  if (fresh?.status === "pausing") {
    const paused = await confirmPause(db, runId)
    if (paused.status === "ok") {
      await notify(runStateFrame(paused.run))
      return result(false, "paused")
    }
    // A hard terminate can win between the wave write and confirmation. Do
    // not publish the stale pausing snapshot in that case.
    fresh = await getRun(db, runId)
    return result(false, fresh?.status ?? "not_found")
  }
  if (after) await notify(runStateFrame(after))
  if (fresh?.status === "running" && advanced.nextIndex >= advanced.seeds.length) {
    // Mixed success parks with failedSpans as the attention signal. A run
    // that staged nothing still fails so retry can start a new run.
    const t = fresh.failedSpans > 0 && fresh.doneSpans === 0
      ? await failRun(db, runId, fresh.lastError ?? "One or more passages need attention.")
      : await parkRun(db, runId)
    if (t.status === "ok") await notify(runStateFrame(t.run))
    return result(false, t.status === "ok" ? t.run.status : fresh.status)
  }
  const more = fresh !== null && fresh.status === "running"
  return result(more, fresh?.status ?? "not_found")
}
