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
import { isKnownBookCode } from "../../../../../src/lib/file-labeling/bible-book-names"
import { AliasMap } from "../compress"
import { stageEvents, type AgentProposal, type EmitStageContext } from "../emit-stage"
import { loadDraftReferenceBlock } from "../reference-bible"
import { executeExamples } from "./examples"
import { pairToRow, resolveScope } from "./read"
import { selectCellPairs, statusOf, type CellPair } from "./select-cells"
import type { FileCandidate, ToolOutcome } from "./types"

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
  /** Active lane ('' = default lane). Required for proper lane scoping. */
  lane: string
  aliases: AliasMap
  sourceLanguage?: string
  targetLanguage?: string
  briefSummary?: string
  signal: AbortSignal
  sendProgress: (label: string, done: number, total: number) => void
  addUsage: (usage: { prompt_tokens?: number; completion_tokens?: number; cost?: number }) => void
  /** Re-check the enclosing agent run's cost/token cap between the two paid
   *  phases. Direct unit callers may omit it (no enclosing run budget). */
  canContinuePaidWork?: () => boolean
  /** Weekly-allowance admission for each paid pass (AQU-837). Reserves before
   *  the call; the returned settle records the provider body afterwards. */
  admitPaidCall?: (input: { model: string; promptChars: number }) => Promise<
    { ok: true; settle: (body: unknown) => Promise<unknown>; hold: (body: unknown) => Promise<unknown> } | { ok: false; message: string }>
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
      /** Cells in the work list the model returned no usable text for. */
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
const PROMPT_VERSION = "agent-draft-v3-staged-research"

/** What every pass is grounded in, besides the shared context `ctx`. */
interface Grounding {
  examplesBlock: string
  precedingBlock: string
  /** AQU-1573: the cited verses from the lane's reference Bible, or "". */
  referenceBlock: string
  /** AQU-1573: true when some cell in the work list is a Bible verse. */
  scripture: boolean
}

/**
 * A cell of a Bible book or a Bible story, as opposed to a sermon's own
 * labels: "MRK 4:12" / "MRK 4", the USFM front matter and headings the
 * importer refs "GEN:h:1" / "GEN:mt1:1", and Open Bible Stories frames
 * "OBS 1:1". Every one of these was drafted as "a scripture translation
 * project" before AQU-1573 and must stay so (review 2026-10-02).
 */
export function isScriptureRef(ref: string | null): boolean {
  const trimmed = ref?.trim() ?? ""
  if (/^OBS\s+\d/.test(trimmed)) return true
  const m = trimmed.match(/^([1-3A-Z][A-Z0-9]{2})(?:\s+\d|:)/)
  return !!m && isKnownBookCode(m[1])
}

function groundingPrompt(ctx: DraftGenerationContext, g: Grounding): string {
  const pair = ctx.targetLanguage
    ? `You translate${ctx.sourceLanguage ? ` from ${ctx.sourceLanguage}` : ""} into ${ctx.targetLanguage}.`
    : "You translate into the project's target language — infer it from the example pairs."
  // AQU-1573: a sermon or a devotional is not Scripture; telling the model it
  // was invited it to "correct" the prose toward Bible text. Scripture work
  // lists keep the exact wording they always had.
  const project = g.scripture ? "a scripture translation project" : "a translation project"
  return `${pair} You draft for ${project}.

The translation pairs below are your PRIMARY source of truth: they carry this team's exact terminology, tone, register, punctuation, and stylistic conventions. This may be an ultra-low-resource language — imitate the project's own patterns above general knowledge of the language.
${ctx.briefSummary ? `\nProject brief (honour it): ${ctx.briefSummary}\n` : ""}${g.examplesBlock}${g.precedingBlock}${g.referenceBlock ? `\n${g.referenceBlock}\n` : ""}`
}

function researchSystemPrompt(ctx: DraftGenerationContext, g: Grounding): string {
  return `${groundingPrompt(ctx, g)}

You are the RESEARCH pass, separate from final generation. Produce a compact evidence record, not a translation and not hidden chain-of-thought.

For each numbered source segment:
1. Inventory every proposition, participant and semantic role, relation, polarity, quantity, and name that the translation must preserve.
2. Record directly attested target wording or constructions from [E#] and [C#] evidence separately from inference. Cite those short evidence labels.
3. Note material conflicts or uncertain choices. Prefer exact and repeated attestation over inference; never construct an answer by splicing unrelated target fragments.
4. End with concise constraints for the drafting pass.

Do not produce final translated segments in this pass.`
}

function draftSystemPrompt(ctx: DraftGenerationContext, g: Grounding): string {
  return `${groundingPrompt(ctx, g)}

You are the GENERATION pass. Use the separate evidence record supplied by the user as a decision aid, while treating the project evidence above as authoritative.

Rules:
1. Translate segment by segment; do not merge, split, or reorder segments.
2. Keep names, numbers, and punctuation conventions consistent with the pairs.
3. Prefer directly attested, repeated constructions over inference. Resolve conflicts coherently; never concatenate incompatible fragments.
4. Before answering, check that no proposition, participant, semantic role, relation, polarity, quantity, or name was omitted or added. Make at most one evidence-supported repair.
5. When uncertainty remains, preserve the strongest coherent attested construction rather than inventing a distinction.
6. Output STRICT JSON only: an array like [{"i":1,"t":"<translation>"}] with one object per input segment, i matching the input number. No prose, no code fences.`
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
  const res = await fetch(modelCfg.url, {
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
    signal,
  })
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

  const all = await selectCellPairs(db, ctx.projectId, { fileId: scope.fileId, range: scope.range, targetLang: ctx.lane })

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

  if (work.length === 0) {
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
      ? `\nImmediately preceding, validated context (continue its discourse flow):\n${preceding
          .map((p, i) => `[C${i + 1}; ${p.canonicalRef ?? "no ref"}] ${JSON.stringify(stripTrailingBareMarkers(p.source))} → ${JSON.stringify(stripTrailingBareMarkers(p.target))}`)
          .join("\n")}\n`
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
      ? `\nTranslation pairs from this project (imitate them):\n${examplePairs
          .map((e, i) => `[E${i + 1}; ${e.ref ?? "no ref"}] ${JSON.stringify(stripTrailingBareMarkers(e.source))} → ${JSON.stringify(stripTrailingBareMarkers(e.target))}`)
          .join("\n")}\n`
      : ""

  // AQU-1573: verses the work list's sources cite, from the lane's reference
  // Bible. Both passes see them, so the research record can already say
  // "copy ISA 40:25 from the block" and the generation pass does.
  const grounding: Grounding = {
    examplesBlock,
    precedingBlock,
    referenceBlock: await loadDraftReferenceBlock(db, {
      projectId: ctx.projectId,
      lane: ctx.lane,
      sources: work.map((p) => p.source),
    }),
    scripture: work.some((p) => isScriptureRef(p.canonicalRef)),
  }

  const instructions =
    typeof args.instructions === "string" && args.instructions.trim()
      ? `\nExtra instructions for this batch: ${args.instructions.trim()}`
      : ""
  const numbered = work
    .map((p, i) => `${i + 1}. ${p.canonicalRef ? `[${p.canonicalRef}] ` : ""}${stripTrailingBareMarkers(p.source)}`)
    .join("\n")

  // Preserve the benchmarked causal structure: research finishes before the
  // model sees the request to translate. This is deliberately two calls, not
  // one prompt asking the model to "think first" and draft in the same pass.
  ctx.sendProgress(`Researching ${work.length} cells`, 0, work.length)
  const researched = await callPaidPass(
    ctx,
    modelCfg,
    [
      { role: "system", content: researchSystemPrompt(ctx, grounding) },
      { role: "user", content: `Research these ${work.length} source segments:${instructions}\n${numbered}` },
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
  ctx.sendProgress(`Researching ${work.length} cells`, work.length, work.length)

  ctx.sendProgress(`Drafting ${work.length} cells`, 0, work.length)
  const generated = await callPaidPass(
    ctx,
    modelCfg,
    [
      { role: "system", content: draftSystemPrompt(ctx, grounding) },
      {
        role: "user",
        content:
          `Evidence record from the completed research pass:\n<evidence>\n${evidenceRecord}\n</evidence>\n\n` +
          `Translate these ${work.length} segments:${instructions}\n${numbered}`,
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
  work.forEach((p, i) => {
    const t = stripTrailingBareMarkers((drafts.get(i + 1) ?? "").trim())
    if (t) {
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
  ctx.sendProgress(`Drafting ${work.length} cells`, work.length, work.length)

  return {
    ok: true,
    fileId: scope.fileId,
    emits,
    missed,
    remaining,
    drafted: work.filter((_, i) => drafts.has(i + 1)),
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
