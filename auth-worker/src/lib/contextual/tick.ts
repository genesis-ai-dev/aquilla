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
  confirmPause,
  parkRun,
  recordWaveOutcome,
  setSpanCursor,
  touchRun,
  readUnconsumedSteering,
  markSteeringConsumed,
  insertDrafts,
  findOccupiedCells,
  type ContextualRun,
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
import { loadLintRules, type LintRule } from "../agent/lint"
import { openRouterUsage } from "../llm-vendor"
import { deriveSpanSeeds } from "./segment"
import { lintSpanDraft } from "./lint-node"
import { runSpan, EXAMPLES_TARGET } from "./pipeline"
import type { ExamplePair } from "./draft"
import type { NeighborBrief, LayerAboveBlock } from "./closure"
import type { LlmCall, SpanSeed, SpanPhase, SpanReport, Tier } from "./types"

// ── Model + endpoint resolution ─────────────────────────────────────────────

/** Default fast-tier model (Haiku-class, same default as the agent loop). */
const DEFAULT_FAST_MODEL = "anthropic/claude-haiku-4-5"

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
  const agentModel = settings.agentModel || env.AGENT_MODEL_DEFAULT || DEFAULT_FAST_MODEL
  const mid = settings.agentDraftModel || env.AGENT_DRAFT_MODEL_DEFAULT || agentModel
  return {
    fast: env.CONTEXTUAL_FAST_MODEL || DEFAULT_FAST_MODEL,
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

/** Build the pipeline's LlmCall over the OpenRouter chat-completions API
 *  (non-streaming). Throws on transport/HTTP errors — runSpan's nodes treat a
 *  throw as that call failing, and the tick records the span outcome. */
export function makeLlmCall(cfg: {
  url: string
  apiKey: string
  models: ContextualModels
  signal?: AbortSignal
  onUsage?: (u: { promptTokens: number; completionTokens: number; costCents: number }) => void
}): LlmCall {
  return async (req) => {
    const model = cfg.models[req.tier as Tier]
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        ...openRouterUsage(cfg.url),
      }),
      ...(cfg.signal ? { signal: cfg.signal } : {}),
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`openrouter_error ${res.status}: ${text.slice(0, 300)}`)
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
    }
    if (body.usage && cfg.onUsage) {
      cfg.onUsage({
        promptTokens: body.usage.prompt_tokens ?? 0,
        completionTokens: body.usage.completion_tokens ?? 0,
        costCents: (body.usage.cost ?? 0) * 100,
      })
    }
    return body.choices?.[0]?.message?.content ?? ""
  }
}

// ── Progress frames (shapes mirror src/lib/contextual/run-store.ts) ─────────

export interface ContextualRunStateFrame {
  type: "contextual.run.state"
  runId: string
  fileId: string
  status: string
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
}

/** A lane OPENS. Emitted before any model call, so the UI never shows dead air
 *  while the closure loop reads context (the slowest phase of a span). */
export interface ContextualSpanStartFrame {
  type: "contextual.span.start"
  runId: string
  fileId: string
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
  spanLabel: string
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
    status: run.status,
    done: run.doneSpans,
    total: run.totalSpans,
    failed: run.failedSpans,
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

interface ProjectContext {
  sourceLanguage?: string
  targetLanguage?: string
  projectBriefL1?: string
}

async function loadProjectContext(db: AquillaDb, projectId: string): Promise<ProjectContext> {
  try {
    const row = await db
      .prepare(
        `SELECT source_language, target_language,
                settings::jsonb -> 'translationBrief' ->> 'l1Summary' AS brief_summary
           FROM project_settings WHERE project_id = ?`,
      )
      .bind(projectId)
      .first<{ source_language: string | null; target_language: string | null; brief_summary: string | null }>()
    return {
      sourceLanguage: row?.source_language ?? undefined,
      targetLanguage: row?.target_language ?? undefined,
      projectBriefL1: row?.brief_summary ?? undefined,
    }
  } catch {
    return {}
  }
}

/** Approved briefs adjacent to the seed, sided by document position. */
async function loadNeighborBriefs(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  seed: StoredSpanSeed,
  pairs: CellPair[],
): Promise<NeighborBrief[]> {
  try {
    const approved = await listSceneBriefs(db, projectId, { fileId, status: "approved" })
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
      if (brief && brief.projectId === run.projectId) {
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
    spanId: seed.id,
    spanLabel: label,
  })

  const neighborBriefs = await loadNeighborBriefs(db, run.projectId, run.fileId, storedSeed, shared.pairs)

  let outcome: "done" | "failed" = "done"
  let lastError: string | null = null
  let report: SpanReport | undefined
  try {
    report = await runSpan({
      seed,
      scope: shared.scope,
      pairs: shared.pairs,
      neighborBriefs,
      layerAbove: shared.layerAbove,
      examples: validatedExamples(shared.pairs),
      ...(shared.ctx.projectBriefL1 ? { projectBriefL1: shared.ctx.projectBriefL1 } : {}),
      ...(steeringDirections.length > 0 ? { steeringDirections } : {}),
      rules: shared.rules,
      ...(shared.ctx.sourceLanguage ? { sourceLanguage: shared.ctx.sourceLanguage } : {}),
      ...(shared.ctx.targetLanguage ? { targetLanguage: shared.ctx.targetLanguage } : {}),
      llm: deps.llm,
      onPhase: (phase: SpanPhase) => {
        void notify({
          type: "contextual.phase",
          runId: run.id,
          spanId: seed.id,
          spanLabel: label,
          phase,
        }).catch(() => {})
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
      lint: async (draft) => lintSpanDraft(shared.rules, shared.pairs, draft),
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
        })
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
          await notify({
            type: "contextual.drafts",
            runId: run.id,
            fileId: run.fileId,
            spanLabel: label,
            drafts: staged.slice(0, MAX_DRAFTS_PER_FRAME).map((d) => ({
              draftId: d.id,
              cellId: d.cellId,
              text: d.text.slice(0, MAX_DRAFT_TEXT_CHARS),
            })),
            ...(staged.length > MAX_DRAFTS_PER_FRAME ? { truncated: true } : {}),
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
    if (report.incomplete && report.cellsStaged.length === 0) {
      outcome = "failed"
      lastError = report.incompleteReasons.join("; ").slice(0, 2000) || "span incomplete"
    }
  } catch (err) {
    outcome = "failed"
    lastError = (err instanceof Error ? err.message : String(err)).slice(0, 2000)
  }

  await notify({
    type: "contextual.span",
    runId: run.id,
    spanLabel: label,
    staged: report?.cellsStaged.length ?? 0,
    skipped: report?.cellsSkipped.length ?? 0,
    verdictSummary:
      outcome === "failed"
        ? `failed: ${lastError ?? "unknown"}`
        : report?.incomplete
          ? `partial: ${report.incompleteReasons.join("; ")}`
          : "complete",
    spanId: seed.id,
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
  const notify = deps.notify ?? (async () => {})
  const run = await getRun(db, runId)
  if (!run) return { continueRun: false, status: "not_found" }

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
  const pairs = await selectCellPairs(db, run.projectId, { fileId: run.fileId })
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
    // Spans exhausted → parked (steering or resume can wake the run). Queued
    // directions are deliberately NOT consumed here — they stay visible and
    // apply when a span next exists (refresh, new cells, or re-run).
    const t = await parkRun(db, runId)
    if (t.status === "ok") await notify(runStateFrame(t.run))
    return { continueRun: false, status: t.status === "ok" ? "parked" : run.status }
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
  let rules: LintRule[] = []
  try {
    rules = await loadLintRules(db, run.projectId)
  } catch {
    /* lint is best-effort — never blocks the span */
  }
  const shared: RunContext = {
    ctx,
    rules,
    pairs,
    layerAbove,
    scope: {
      projectId: run.projectId,
      fileId: run.fileId,
      targetLang: run.targetLang,
      orderedCellIds: pairs.map((p) => p.cellId),
      untranslatedCellIds: pairs.filter((p) => !p.target.trim()).map((p) => p.cellId),
      fileKind: "",
    },
  }

  const remaining = cursor.seeds.length - cursor.nextIndex
  const width = Math.max(1, Math.min(deps.concurrency ?? waveSize(remaining), remaining))
  const wave = cursor.seeds.slice(cursor.nextIndex, cursor.nextIndex + width)

  // Heartbeat before a long wave so the stranded-run sweeper doesn't mistake
  // work in flight for a dead driver.
  await touchRun(db, runId)

  const outcomes = await Promise.all(
    wave.map((storedSeed) =>
      processSpan(deps, run, shared, storedSeed, steering.directions, notify),
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
  if (after) await notify(runStateFrame(after))

  const lastReport = reports[reports.length - 1]
  const result = (continueRun: boolean, status: string): TickResult => ({
    continueRun,
    status,
    ...(lastReport ? { report: lastReport } : {}),
    ...(reports.length > 0 ? { reports } : {}),
  })

  // Continue only while the run is STILL running (a pause/terminate landed
  // mid-wave loses nothing — the next wave honours it) and spans remain.
  const fresh = after ?? (await getRun(db, runId))
  if (fresh?.status === "running" && advanced.nextIndex >= advanced.seeds.length) {
    // That was the last wave — park immediately so the run never idles as
    // 'running' with an exhausted cursor.
    const t = await parkRun(db, runId)
    if (t.status === "ok") await notify(runStateFrame(t.run))
    return result(false, "parked")
  }
  const more = fresh !== null && fresh.status === "running"
  return result(more, fresh?.status ?? "not_found")
}
