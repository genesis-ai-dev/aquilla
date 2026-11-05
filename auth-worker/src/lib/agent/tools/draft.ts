// draft — the server-side drafting pipeline, as one tool call.
//
// The orchestrator model does NOT hand-write translations inline anymore:
// this tool selects the work list (same selector as `read`), gathers few-shot
// pairs (validated first — the copilot's retrieval), then runs the empirically
// supported STAGED workflow: one compact evidence-research call followed by a
// separate drafting call. The drafting model may be stronger than the cheap
// orchestrator. Results are staged through the same emit-stage lint/staleness
// path as a hand emit. One tool call is one human-review package; the verdict
// tells the orchestrator how much work remains.

import { stripTrailingBareMarkers } from "../../../../../src/lib/completion/strip-trailing-usfm-markers"
import { isRefusalReply } from "../../../../../src/lib/completion/refusal"
import { resolveLaneIdOrTag } from "../../../../../db/shared/lane-ref"
import {
  createTagMask,
  describeTagFailure,
  isTagsOnlyText,
  maskInlineTags,
  settleTagLadder,
  type TagMask,
} from "../../../../../db/shared/inline-tags"
import { instructionsPromptBlock } from "../../../../../db/shared/translation-instructions"
import {
  assemblePromptSections,
  checksHintBlock,
  runDirectionsBlock,
  terminologyBlock,
} from "../../../../../db/shared/prompt-blocks"
import { styleInstructionsForCells } from "../../../../../db/shared/style-instructions"
import { loadProjectContext, termGuidanceForSpan, termHints } from "../../contextual/project-context"
import { rulesForLane } from "../lint"
import { AliasMap } from "../compress"
import { stageEvents, type AgentProposal, type EmitStageContext } from "../emit-stage"
import { executeExamples } from "./examples"
import { pairToRow, resolveScope } from "./read"
import { selectCellPairs, statusOf, type CellPair } from "./select-cells"
import type { FileCandidate, ToolOutcome } from "./types"
import {
  logVendorTimeout,
  vendorDeadline,
  vendorTimeoutMessage,
} from "../../../../../shared/vendor-timeouts"

export interface DraftArgs {
  fileId?: unknown
  ref?: unknown
  cellIds?: unknown
  limit?: unknown
  instructions?: unknown
}

export interface DraftModelConfig {
  model: string
  apiKey: string
  /** Full chat-completions URL (mock-aware, resolved by the route). */
  url: string
  /** Output cap forwarded to the provider (set when the run is metered). */
  maxTokens?: number
}

/** Everything the drafting pipeline itself needs. Deliberately free of any
 *  staging concern: `generateDrafts` produces target.cell.commit emit inputs
 *  and nothing more, so callers that stage through a DIFFERENT engine (the
 *  external Agent API's DraftCells command, AQU-1186) reuse the identical
 *  pipeline rather than re-implementing the copilot. */
export interface DraftGenerationContext {
  projectId: string
  focusedFileId?: string
  /** The active lane, as either its `lanes.id` or its legacy tag: resolved
   *  to the id every lane-scoped query keys on (AQU-1610). `''` is the
   *  project's former default lane. */
  lane: string
  aliases: AliasMap
  sourceLanguage?: string
  targetLanguage?: string
  /** AQU-2342: the project's resolved translation instructions — the ONE
   *  instructions block, right after the fixed role text. */
  translationInstructions?: string
  signal: AbortSignal
  /**
   * AQU-1536: the counter is optional. Drafting runs two batched model
   * calls, so no cell finishes before the whole pass returns — a
   * per-cell `done/total` here could only sit at 0 and then jump to N.
   */
  sendProgress: (label: string, done?: number, total?: number) => void
  addUsage: (usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number }) => void
  /** Re-check the enclosing agent run's cost/token cap between the two paid
   *  phases. Direct unit callers may omit it (no enclosing run budget). */
  canContinuePaidWork?: () => boolean
  /** Weekly-allowance admission for each paid pass (AQU-837). Reserves before
   *  the call; the returned settle records the provider body afterwards. */
  admitPaidCall?: (input: { model: string; promptChars: number }) => Promise<
    { ok: true; settle: (body: unknown) => Promise<unknown>; hold: (body: unknown) => Promise<unknown> } | { ok: false; message: string }>
  /**
   * AQU-2385: mask inline tags to opaque sentinels before each model pass.
   * On unless explicitly false — the escape hatch for a model that handles
   * the sentinel grammar badly. Detection, repair and the quarantine never
   * switch off, so a tag the model mangles is caught either way.
   */
  maskInlineTags?: boolean
  /** Ceiling on cells drafted in one call. Defaults to the in-agent review
   *  package size (MAX_LIMIT); the external DraftCells command passes the
   *  project's configured completion batch size instead. */
  maxCells?: number
}

export interface DraftContext extends DraftGenerationContext {
  stageCtx: EmitStageContext
}

export interface DraftOutcome extends ToolOutcome {
  proposal?: AgentProposal
}

/** One compiled, not-yet-staged target.cell.commit. */
export interface DraftEmit {
  kind: string
  fileId: string
  cellId: string
  payload: Record<string, unknown>
}

export type DraftGeneration =
  | { ok: false; error: string; candidates?: FileCandidate[] }
  | {
      ok: true
      fileId: string
      emits: DraftEmit[]
      /** Cells in the work list the model returned no usable text for —
       *  an absent/empty entry, or a refusal instead of a translation. */
      missed: string[]
      /** Untranslated cells left in scope beyond this package. */
      remaining: number
      /** Work-list entries that actually received a draft (display rows). */
      drafted: CellPair[]
      /** True when nothing in scope needed drafting (not an error). */
      empty: boolean
      /** AQU-1455: set when a failed ref widened the scope to the whole file. */
      notice?: string
    }

// Keep agent proposals in the same human-review package used by the editor.
const DEFAULT_LIMIT = 10
const MAX_LIMIT = 10
const PRECEDING_CONTEXT = 5
const EXAMPLES_N = 10
const RESEARCH_RECORD_MAX_CHARS = 12_000
// v5 (AQU-2342 phase 2): checks hint + matching terms, one shared section order.
const PROMPT_VERSION = "agent-draft-v5-guidance"

/** The standing guidance and evidence one draft call carries, built once and
 *  shared by the research and generation passes. */
export interface DraftGuidance {
  /** db/shared/prompt-blocks checks hint ("" when none). */
  checks: string
  /** db/shared/prompt-blocks terminology block for the work list ("" when none). */
  terminology: string
  /** [E#]-labelled validated pairs ("" when none). */
  examples: string
  /** [C#]-labelled preceding validated context ("" when none). */
  context: string
  /** This run's directions (the `instructions` arg), "" when none. */
  directions: string
}

/** One section order for every drafting path (db/shared/prompt-blocks.ts):
 *  role → instructions → checks → terminology → examples → context → this
 *  run's directions → the pass's own task. */
function passSystemPrompt(ctx: DraftGenerationContext, guidance: DraftGuidance, task: string): string {
  const pair = ctx.targetLanguage
    ? `You translate${ctx.sourceLanguage ? ` from ${ctx.sourceLanguage}` : ""} into ${ctx.targetLanguage}.`
    : "You translate into the project's target language — infer it from the example pairs."
  return assemblePromptSections({
    role: `${pair} You draft for a scripture translation project. The translation pairs below are your PRIMARY source of truth: they carry this team's exact terminology, tone, register, punctuation, and stylistic conventions. This may be an ultra-low-resource language — imitate the project's own patterns above general knowledge of the language.`,
    instructions: instructionsPromptBlock(ctx.translationInstructions),
    checks: guidance.checks,
    terminology: guidance.terminology,
    examples: guidance.examples,
    context: guidance.context,
    directions: guidance.directions,
    output: task,
  })
}

export function researchSystemPrompt(ctx: DraftGenerationContext, guidance: DraftGuidance): string {
  return passSystemPrompt(ctx, guidance, `You are the RESEARCH pass, separate from final generation. Produce a compact evidence record, not a translation and not hidden chain-of-thought.

For each numbered source segment:
1. Inventory every proposition, participant and semantic role, relation, polarity, quantity, and name that the translation must preserve.
2. Record directly attested target wording or constructions from [E#] and [C#] evidence separately from inference. Cite those short evidence labels.
3. Note material conflicts or uncertain choices. Prefer exact and repeated attestation over inference; never construct an answer by splicing unrelated target fragments.
4. Note every listed term and check the segment triggers.
5. End with concise constraints for the drafting pass.

Do not produce final translated segments in this pass.`)
}

export function draftSystemPrompt(ctx: DraftGenerationContext, guidance: DraftGuidance): string {
  return passSystemPrompt(ctx, guidance, `You are the GENERATION pass. Use the separate evidence record supplied by the user as a decision aid, while treating the project evidence above as authoritative.

Rules:
1. Translate segment by segment; do not merge, split, or reorder segments.
2. Keep names, numbers, and punctuation conventions consistent with the pairs.
3. Render every listed term with an approved rendering, and satisfy every listed check.
4. Prefer directly attested, repeated constructions over inference. Resolve conflicts coherently; never concatenate incompatible fragments.
5. Before answering, check that no proposition, participant, semantic role, relation, polarity, quantity, or name was omitted or added. Make at most one evidence-supported repair.
6. When uncertainty remains, preserve the strongest coherent attested construction rather than inventing a distinction.
7. Output STRICT JSON only: an array like [{"i":1,"t":"<translation>"}] with one object per input segment, i matching the input number. No prose, no code fences.`)
}

/**
 * The checks hint and the matching terms for this work list, read the way
 * Autopilot reads them (loadProjectContext: the editor's concepts, affix
 * inventory, project + org rules, Language profile) and rendered by the shared
 * builders. Best-effort: grounding never fails a draft.
 */
async function loadDraftGuidance(
  db: AquillaDb,
  ctx: DraftGenerationContext,
  work: readonly CellPair[],
  fileId: string,
  lane: { laneId: string | null; tag: string },
): Promise<Pick<DraftGuidance, "checks" | "terminology">> {
  try {
    const project = await loadProjectContext(db, ctx.projectId, { laneId: lane.laneId, targetLang: lane.tag })
    const terms = termGuidanceForSpan(project.concepts, work.map((p) => p.source), project.termMatching)
    const styleInstructions = await styleInstructionsForCells(db, {
      projectId: ctx.projectId,
      fileId,
      cells: work,
      settings: { fileGenres: project.fileGenres },
    })
    return {
      checks: checksHintBlock({
        rules: rulesForLane([...project.authoredRules, ...(project.orgRules ?? [])], lane.tag),
        styleInstructions,
        languageProfile: project.languageProfile,
      }),
      terminology: terminologyBlock(termHints(terms)),
    }
  } catch (err) {
    console.warn("[draft] guidance read failed; drafting without checks/terms:", err instanceof Error ? err.message : err)
    return { checks: "", terminology: "" }
  }
}

interface UpstreamJson {
  id?: string
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  error?: { message?: string }
}

type DraftModelResult =
  | { ok: true; content: string; usage?: UpstreamJson["usage"]; id?: string }
  | { ok: false; error: string }

async function callDraftModel(
  modelCfg: DraftModelConfig,
  messages: { role: "system" | "user"; content: string }[],
  signal: AbortSignal,
): Promise<DraftModelResult> {
  // AQU-1849: deadline on the provider's answer, linked to the run's signal
  // so a cancelled run still aborts upstream. `stream: false` means the
  // headers do not arrive until the completion is whole, so disarming at
  // headers bounds the whole answer. A hung provider used to park the entire
  // agent turn with no error the harness could show.
  const deadline = vendorDeadline("openRouterNonStreaming", signal)
  let res: Response
  try {
    res = await fetch(modelCfg.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${modelCfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: modelCfg.model,
        messages,
        stream: false,
        usage: { include: true },
        reasoning: { effort: "none" },
        ...(modelCfg.maxTokens ? { max_tokens: modelCfg.maxTokens } : {}),
      }),
      signal: deadline.signal,
    })
  } catch (err) {
    if (deadline.timedOut()) {
      logVendorTimeout("openRouterNonStreaming", err)
      return { ok: false, error: vendorTimeoutMessage("openRouterNonStreaming") }
    }
    throw err
  } finally {
    deadline.clear()
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    return { ok: false, error: `model failed (${res.status}): ${text.slice(0, 300)}` }
  }
  const data = (await res.json()) as UpstreamJson
  if (data.error?.message) return { ok: false, error: `model: ${data.error.message}` }
  return {
    ok: true,
    content: data.choices?.[0]?.message?.content ?? "",
    ...(data.usage ? { usage: data.usage } : {}),
    ...(typeof data.id === "string" ? { id: data.id } : {}),
  }
}
/** Metered pass: reserve, call, then settle or hold. Unmetered runs call directly. */
async function callPaidPass(
  ctx: DraftGenerationContext,
  modelCfg: DraftModelConfig,
  messages: { role: "system" | "user"; content: string }[],
): Promise<DraftModelResult> {
  if (!ctx.admitPaidCall) return callDraftModel(modelCfg, messages, ctx.signal)
  const admission = await ctx.admitPaidCall({ model: modelCfg.model, promptChars: messages.reduce((n, m) => n + m.content.length, 0) })
  if (!admission.ok) return { ok: false, error: admission.message }
  let result: DraftModelResult
  try {
    result = await callDraftModel(modelCfg, messages, ctx.signal)
  } catch (error) {
    await admission.hold(undefined)
    throw error
  }
  // A provider error is an uncertain charge: the reservation stays held.
  await (result.ok ? admission.settle({ id: result.id, usage: result.usage }) : admission.hold(undefined))
  return result
}

/** Tolerant parse of the drafting model's JSON array. */
export function parseDraftReply(content: string): Map<number, string> {
  const out = new Map<number, string>()
  const start = content.indexOf("[")
  const end = content.lastIndexOf("]")
  if (start === -1 || end <= start) return out
  try {
    const arr = JSON.parse(content.slice(start, end + 1)) as unknown
    if (!Array.isArray(arr)) return out
    for (const item of arr) {
      if (
        typeof item === "object" && item !== null &&
        typeof (item as { i?: unknown }).i === "number" &&
        typeof (item as { t?: unknown }).t === "string"
      ) {
        out.set((item as { i: number }).i, (item as { t: string }).t)
      }
    }
  } catch {
    /* unparseable → empty map; caller reports */
  }
  return out
}

/**
 * Run the two-phase drafting pipeline over the requested scope and return the
 * compiled (still unstaged) target.cell.commit emits. Staging is the caller's
 * job — `executeDraft` stages through emit-stage, the external DraftCells
 * command stages through the changeset engine.
 */
export async function generateDrafts(
  db: AquillaDb,
  args: DraftArgs,
  ctx: DraftGenerationContext,
  modelCfg: DraftModelConfig,
): Promise<DraftGeneration> {
  const scope = await resolveScope(db, args, {
    projectId: ctx.projectId,
    focusedFileId: ctx.focusedFileId,
    lane: ctx.lane,
    aliases: ctx.aliases,
  })
  if (!scope.ok) return { ok: false, error: scope.error, ...(scope.candidates ? { candidates: scope.candidates } : {}) }
  const maxCells = Math.max(1, Math.floor(ctx.maxCells ?? MAX_LIMIT))
  const limit = Math.min(Math.max(Number(args.limit) || DEFAULT_LIMIT, 1), maxCells)

  const resolvedLane = await resolveLaneIdOrTag(db, ctx.projectId, ctx.lane)
  const all = await selectCellPairs(db, ctx.projectId, { fileId: scope.fileId, range: scope.range, laneId: resolvedLane.laneId })

  // Work list: explicit cellIds (aliases ok), else every untranslated cell in scope.
  let work: CellPair[]
  if (Array.isArray(args.cellIds) && args.cellIds.length > 0) {
    const wanted = new Set<string>()
    for (const raw of args.cellIds) {
      if (typeof raw !== "string") continue
      wanted.add(AliasMap.isAlias(raw) ? (ctx.aliases.resolve(raw) ?? raw) : raw)
    }
    work = all.filter((p) => wanted.has(p.cellId))
  } else {
    work = all.filter((p) => statusOf(p) === "untranslated")
  }
  const remaining = Math.max(work.length - limit, 0)
  work = work.slice(0, limit)

  // AQU-2385, rung 0 of the inline-tag ladder: a cell that is nothing but
  // inline markup (plus at most one placeholder) has no words to translate.
  // Copy it across and keep it out of both model passes — no model call means
  // no reply that could drop, duplicate or reorder its tags.
  const copiedPairs = work.filter((p) => isTagsOnlyText(p.source))
  if (copiedPairs.length > 0) work = work.filter((p) => !isTagsOnlyText(p.source))
  const copyEmit = (p: CellPair): DraftEmit => ({
    kind: "target.cell.commit",
    fileId: scope.fileId,
    cellId: p.cellId,
    payload: {
      value: p.source,
      ai_draft: {
        model: modelCfg.model,
        provider: "platform",
        promptVersion: PROMPT_VERSION,
        exampleIds: [],
        generatedAt: Date.now(),
        mode: "agent",
        projectState: {
          sourceLanguage: ctx.sourceLanguage ?? "",
          targetLanguage: ctx.targetLanguage ?? "",
          approvedExampleCount: 0,
        },
      },
    },
  })

  if (work.length === 0) {
    if (copiedPairs.length > 0) {
      return {
        ok: true,
        fileId: scope.fileId,
        emits: copiedPairs.map(copyEmit),
        missed: [],
        remaining,
        drafted: copiedPairs,
        empty: false,
        notice: scope.notice,
      }
    }
    return { ok: true, fileId: scope.fileId, emits: [], missed: [], remaining, drafted: [], empty: true, notice: scope.notice }
  }

  // Discourse left-context: committed pairs immediately before the batch.
  const firstIdx = all.findIndex((p) => p.cellId === work[0].cellId)
  const preceding: CellPair[] = []
  for (let i = firstIdx - 1; i >= 0 && preceding.length < PRECEDING_CONTEXT; i--) {
    if (all[i].validated && all[i].target.trim()) preceding.unshift(all[i])
  }
  const precedingBlock =
    preceding.length > 0
      ? `Immediately preceding, validated context (continue its discourse flow):\n${preceding
          .map((p, i) => `[C${i + 1}; ${p.canonicalRef ?? "no ref"}] ${JSON.stringify(stripTrailingBareMarkers(p.source))} → ${JSON.stringify(stripTrailingBareMarkers(p.target))}`)
          .join("\n")}`
      : ""

  // Few-shot pairs — validated first (the team's terminology decisions).
  const examplesOutcome = await executeExamples(
    db,
    { text: work.map((p) => p.source).join(" "), n: EXAMPLES_N },
    { projectId: ctx.projectId, lane: ctx.lane, aliases: ctx.aliases },
  )
  const examplePairs = examplesOutcome.data?.examples ?? []
  const examplesBlock =
    examplePairs.length > 0
      ? `Translation pairs from this project (imitate them):\n${examplePairs
          .map((e, i) => `[E${i + 1}; ${e.ref ?? "no ref"}] ${JSON.stringify(stripTrailingBareMarkers(e.source))} → ${JSON.stringify(stripTrailingBareMarkers(e.target))}`)
          .join("\n")}`
      : ""

  // AQU-2342: checks hint + the terms that occur in THIS work list — the
  // blocks every drafting path carries (this tool used to get neither, and
  // could only be told about a violation after the lint).
  const guidance: DraftGuidance = {
    ...(await loadDraftGuidance(db, ctx, work, scope.fileId, { laneId: resolvedLane.laneId, tag: resolvedLane.targetLang ?? "" })),
    examples: examplesBlock,
    context: precedingBlock,
    // The caller's per-run steering: last, after the standing guidance.
    directions: runDirectionsBlock(typeof args.instructions === "string" ? args.instructions : ""),
  }
  // AQU-2385, rung 1: inline tags reach the model as opaque sentinels, so it
  // has nothing to "translate", reflow or helpfully reformat. ONE mask per
  // call (one nonce, one ordinal sequence) covers every cell, and the same
  // masked list is carried by the research pass and the drafting pass. The
  // guidance, terminology and example blocks above keep the REAL source —
  // term lookup needs the actual words.
  const tagMask: TagMask | undefined = ctx.maskInlineTags === false ? undefined : createTagMask()
  const maskedSources = work.map((p) => {
    const text = stripTrailingBareMarkers(p.source)
    return tagMask ? maskInlineTags(text, tagMask).masked : text
  })
  const numbered = work
    .map((p, i) => `${i + 1}. ${p.canonicalRef ? `[${p.canonicalRef}] ` : ""}${maskedSources[i]}`)
    .join("\n")

  // Preserve the benchmarked causal structure: research finishes before the
  // model sees the request to translate. This is deliberately two calls, not
  // one prompt asking the model to "think first" and draft in the same pass.
  // AQU-1536: a stage label, not a cell counter. Research is ONE call covering
  // every cell, so there is no per-cell completion to count; the dock showed
  // `Researching 7 cells — 0/7` frozen for the whole pass, which a translator
  // cannot tell from a stalled run. The label names the pass instead, and it
  // changes when generation starts — visible movement before the proposals land.
  ctx.sendProgress(`Researching ${work.length} cells (pass 1 of 2)`)
  const researched = await callPaidPass(
    ctx,
    modelCfg,
    [
      { role: "system", content: researchSystemPrompt(ctx, guidance) },
      { role: "user", content: `Research these ${work.length} source segments:\n${numbered}` },
    ],
  )
  if (!researched.ok) return { ok: false, error: `drafting research ${researched.error}` }
  if (researched.usage) ctx.addUsage(researched.usage)
  if (ctx.canContinuePaidWork && !ctx.canContinuePaidWork()) {
    return {
      ok: false,
      error: "run budget exhausted after the research pass — generation was not started",
    }
  }
  const evidenceRecord = researched.content.trim().slice(0, RESEARCH_RECORD_MAX_CHARS)
  if (!evidenceRecord) {
    return { ok: false, error: "drafting research returned no evidence record — retry or draft fewer cells" }
  }
  ctx.sendProgress(`Drafting ${work.length} cells (pass 2 of 2)`)
  const generated = await callPaidPass(
    ctx,
    modelCfg,
    [
      { role: "system", content: draftSystemPrompt(ctx, guidance) },
      {
        role: "user",
        content:
          `Evidence record from the completed research pass:\n<evidence>\n${evidenceRecord}\n</evidence>\n\n` +
          `Translate these ${work.length} segments:\n${numbered}`,
      },
    ],
  )
  if (!generated.ok) return { ok: false, error: `drafting generation ${generated.error}` }
  if (generated.usage) ctx.addUsage(generated.usage)

  const drafts = parseDraftReply(generated.content)
  if (drafts.size === 0) {
    return { ok: false, error: "drafting model returned no parseable [{i,t}] array — retry or draft fewer cells" }
  }

  const generatedAt = Date.now()
  const exampleIds = examplePairs.flatMap((example) => example.cellId ? [example.cellId] : [])
  const emits: DraftEmit[] = []
  const missed: string[] = []
  const draftedIdx = new Set<number>()
  work.forEach((p, i) => {
    const reply = stripTrailingBareMarkers((drafts.get(i + 1) ?? "").trim())
    // AQU-2385, rungs 2-4: put the real tags back, then detect -> repair ->
    // quarantine. A quarantined draft is NOT dropped: it is staged like any
    // other AI draft and a human approves or rejects it, which is exactly the
    // review this changeset gate exists for.
    const ladder = reply ? settleTagLadder(stripTrailingBareMarkers(p.source), reply, tagMask) : null
    if (ladder && ladder.status !== "clean" && ladder.reason) {
      console.warn(
        `[draft] inline tags ${ladder.status} for cell ${p.cellId}: ` +
        describeTagFailure(ladder.reason, ladder.detail),
      )
    }
    const t = ladder ? ladder.value : reply
    // AQU-2217: the drafting model can fill a well-formed {"i","t"} entry with
    // a refusal ("I'm sorry, but I cannot assist with that request."). That is
    // not a translation, so it must never reach stageEvents and become a
    // reviewable changeset entry — it joins `missed` like an absent entry, and
    // the orchestrator is told to re-run those cells.
    if (t && !isRefusalReply(t)) {
      draftedIdx.add(i)
      emits.push({
        kind: "target.cell.commit",
        fileId: scope.fileId,
        cellId: p.cellId,
        payload: {
          value: t,
          ai_draft: {
            model: modelCfg.model,
            provider: "platform",
            promptVersion: PROMPT_VERSION,
            exampleIds,
            generatedAt,
            mode: "agent",
            projectState: {
              sourceLanguage: ctx.sourceLanguage ?? "",
              targetLanguage: ctx.targetLanguage ?? "",
              approvedExampleCount: examplePairs.length,
            },
          },
        },
      })
    } else {
      missed.push(p.canonicalRef ?? ctx.aliases.alias(p.cellId, "c"))
    }
  })

  return {
    ok: true,
    fileId: scope.fileId,
    emits: [...copiedPairs.map(copyEmit), ...emits],
    missed,
    remaining,
    drafted: [...copiedPairs, ...work.filter((_, i) => draftedIdx.has(i))],
    empty: false,
    notice: scope.notice,
  }
}

export async function executeDraft(
  db: AquillaDb,
  args: DraftArgs,
  ctx: DraftContext,
  modelCfg: DraftModelConfig,
): Promise<DraftOutcome> {
  const gen = await generateDrafts(db, args, ctx, modelCfg)
  if (!gen.ok) {
    return {
      ok: false,
      text: `error: ${gen.error}`,
      ...(gen.candidates ? { data: { candidates: gen.candidates } } : {}),
    }
  }
  if (gen.empty) {
    // A bare "nothing here" reads as a dead end (2026-08-28 transcript) —
    // always hand the model a concrete next step to relay to the user.
    return {
      ok: true,
      text:
        `${gen.notice ? `${gen.notice}\n` : ""}Nothing to draft — no untranslated cells in scope. `
        + "Suggest a next step to the user: run /check to review the existing "
        + "translations in this scope, or pick a file that still has untranslated cells.",
    }
  }

  // Stage through the SAME path as a hand emit: role floors, staleness
  // pre-check, provenance injection, and rule lint all apply.
  const { proposal, modelVerdictBlock } = await stageEvents(db, gen.emits, ctx.stageCtx)

  const lines = gen.notice ? [gen.notice, modelVerdictBlock] : [modelVerdictBlock]
  if (gen.missed.length > 0) lines.push(`No draft returned for: ${gen.missed.join(", ")} — re-run draft with their cellIds.`)
  if (gen.remaining > 0) lines.push(`${gen.remaining} more untranslated cells remain in scope — call draft again to continue.`)

  // Working-set rows carry the cells' CURRENT committed state — the drafted
  // values ride the proposal frame as the pending overlay. Echoing the draft
  // into `target` here made the panel show it as the crossed-out "old value"
  // above the identical proposed text.
  const draftedRows = gen.drafted.map((p) => pairToRow(p, gen.fileId))

  return {
    ok: proposal !== null,
    text: lines.join("\n"),
    data: { cells: draftedRows },
    ...(proposal ? { proposal } : {}),
  }
}
