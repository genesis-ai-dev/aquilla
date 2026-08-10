// draft — perform the span from the scene brief (graph node `draft`).
//
// Generalizes the agent draft tool (../agent/tools/draft.ts): same numbered
// cell list + strict [{"i","t"}] output + tolerant parse, but the performer
// works FROM THE SCENE BRIEF, not wording-by-wording — target-language idioms
// are explicitly licensed, and the ambiguity register rides in the system
// prompt as HARD constraints ("do not resolve"), which verify_ambiguity later
// enforces with a veto.

import { parseDraftReply } from "../agent/tools/draft"
import type { LintRule } from "../agent/lint"
import type { CellPair } from "../agent/tools/select-cells"
import {
  PERFORMER_BRIEF_FIELDS,
  type TermGuidance,
  type TranslationBriefParameters,
} from "./project-context"
import { chargeBudget, type AmbiguityEntry, type LlmCall, type RunBudget, type SpanDraft } from "./types"

export const CONTEXTUAL_PROMPT_VERSION = "contextual-draft-v2"

export interface ExamplePair {
  cellId?: string
  source: string
  target: string
  validated: boolean
}

export interface PerformSpanDeps {
  sceneBrief: {
    id: string
    spanId: string
    l1Summary: string
    ambiguityRegister: AmbiguityEntry[]
  }
  /** The cells to draft, in display order (already filtered to the work list). */
  pairs: CellPair[]
  examples: ExamplePair[]
  /** Validated pairs immediately preceding the span (discourse left-context). */
  precedingValidated: CellPair[]
  steeringDirections?: string[]
  projectBriefL1?: string
  /** The brief's structured answers, used when there is no L1 summary. */
  briefParameters?: TranslationBriefParameters
  /** Approved/forbidden renderings for the key terms that appear in THIS span. */
  terms?: TermGuidance[]
  rules?: LintRule[]
  /** Per-cell constraints from a previous quorum rejection (redraft loop —
   *  losing verdicts, never "improve this"). */
  constraints?: { cellId: string; constraints: string[] }[]
  sourceLanguage?: string
  targetLanguage?: string
  llm: LlmCall
  budget: RunBudget
}

export type PerformSpanResult =
  | { ok: true; draft: SpanDraft; missedCellIds: string[] }
  | { ok: false; error: string }

/** FNV-1a over the effective system prompt (idiom from useCompletion.ts). */
export function promptFingerprint(prompt: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < prompt.length; index++) {
    hash ^= prompt.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

// Keep supporting metadata bounded without truncating source or target text.
// Translation examples and preceding segments are serialized in full below.
function clip(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
}

function performerSystemPrompt(deps: PerformSpanDeps): string {
  const pair = deps.targetLanguage
    ? `You translate${deps.sourceLanguage ? ` from ${deps.sourceLanguage}` : ""} into ${deps.targetLanguage}.`
    : "You translate into the project's target language — infer it from the example pairs."

  const registerBlock =
    deps.sceneBrief.ambiguityRegister.length > 0
      ? `\nAmbiguity register — HARD constraints. Each item below is ambiguous ON PURPOSE in the source. Your draft must keep it just as open; do NOT resolve, clarify, or pick a reading:\n${deps.sceneBrief.ambiguityRegister.map((a) => `- [${a.id}] ${a.question}`).join("\n")}\n`
      : ""

  // Key terms first, and as HARD constraints: an inconsistently rendered key
  // term is the defect a translation consultant rejects a whole book over.
  // These were previously invisible to the model — terminology compiled to
  // rules client-side only — so the performer could only be punished for
  // missing a rendering it was never shown.
  const termsBlock =
    deps.terms && deps.terms.length > 0
      ? `\nKey terms appearing in this passage — HARD constraints. Use an approved rendering for each; never use a forbidden one:\n${deps.terms
          .map((t) => {
            const use = [...t.preferred, ...t.admitted]
            const parts = [
              use.length > 0 ? `use ${use.map((r) => `"${r}"`).join(" or ")}` : null,
              t.forbidden.length > 0
                ? `never ${t.forbidden.map((r) => `"${r}"`).join(" or ")}`
                : null,
            ].filter(Boolean)
            return `- "${t.sourceTerm}": ${parts.join("; ")}${t.notes ? ` (${clip(t.notes, 160)})` : ""}`
          })
          .join("\n")}\n`
      : ""

  // Rules carry a description that states what they REQUIRE. Sending only the
  // name ("Term: grace") told the model a label and expected it to infer the
  // requirement.
  const rulesBlock =
    deps.rules && deps.rules.length > 0
      ? `\nProject rules (deterministic checks will run on your output):\n${deps.rules
          .filter((r) => r.enabled)
          .map((r) => `- ${r.description ? clip(r.description, 200) : r.name}`)
          .join("\n")}\n`
      : ""

  // The brief's own answers, used when nobody has generated the L1 summary —
  // an un-summarised brief is still a brief, and drafting without audience,
  // register, or literalness means guessing the decisions that shape every
  // sentence.
  const briefFallbackBlock =
    !deps.projectBriefL1 && deps.briefParameters
      ? (() => {
          const lines = PERFORMER_BRIEF_FIELDS.flatMap((f) => {
            const v = deps.briefParameters?.[f.id]
            return v ? [`- ${f.label}: ${clip(v, 300)}`] : []
          })
          return lines.length > 0 ? `\nProject brief (honour it):\n${lines.join("\n")}\n` : ""
        })()
      : ""

  const steeringBlock =
    deps.steeringDirections && deps.steeringDirections.length > 0
      ? `\nActive directions from the human team (honour them):\n${deps.steeringDirections.map((d) => `- ${d}`).join("\n")}\n`
      : ""

  // [[ctx:draft]] routes the scripted e2e mock (scripts/mock-openrouter.ts).
  return `[[ctx:draft]] ${pair} You are the PERFORMER in a two-role translation pipeline: an analyzer has already construed the scene below. Work from the scene brief — translate the scene's moves, not word by word. Target-language idioms are explicitly licensed where they carry the same move with the same social force.
${deps.projectBriefL1 ? `\nProject brief (honour it): ${deps.projectBriefL1}\n` : briefFallbackBlock}
Scene brief: ${deps.sceneBrief.l1Summary}
${registerBlock}${termsBlock}${rulesBlock}${steeringBlock}
Rules:
1. Translate segment by segment; do not merge, split, or reorder segments.
2. Keep names, numbers, and punctuation conventions consistent with the example pairs.
3. Preserve every registered ambiguity exactly as open as the source leaves it.
4. Render every key term listed above with one of its approved renderings.
5. Output STRICT JSON only: an array like [{"i":1,"t":"<translation>"}] with one object per input segment, i matching the input number. No prose, no code fences.`
}

function userPrompt(deps: PerformSpanDeps): string {
  const examplesBlock =
    deps.examples.length > 0
      ? `Translation pairs from this project (imitate them):\n${deps.examples
          .map((e) => `${e.validated ? "✓" : "·"} ${JSON.stringify(e.source)} → ${JSON.stringify(e.target)}`)
          .join("\n")}\n\n`
      : ""
  const precedingBlock =
    deps.precedingValidated.length > 0
      ? `Immediately preceding, already-translated segments (continue their discourse flow):\n${deps.precedingValidated
          .map((p) => `${p.canonicalRef ?? "·"}: ${JSON.stringify(p.source)} → ${JSON.stringify(p.target)}`)
          .join("\n")}\n\n`
      : ""
  const constraintsById = new Map((deps.constraints ?? []).map((c) => [c.cellId, c.constraints]))
  const numbered = deps.pairs
    .map((p, i) => {
      const cs = constraintsById.get(p.cellId)
      const constraintNote =
        cs && cs.length > 0 ? `\n   Constraints from review (satisfy each): ${cs.join("; ")}` : ""
      return `${i + 1}. ${p.canonicalRef ? `[${p.canonicalRef}] ` : ""}${p.source}${constraintNote}`
    })
    .join("\n")
  return `${examplesBlock}${precedingBlock}Translate these ${deps.pairs.length} segments:\n${numbered}`
}

export async function performSpan(deps: PerformSpanDeps): Promise<PerformSpanResult> {
  if (deps.pairs.length === 0) return { ok: false, error: "no cells to draft" }
  const system = performerSystemPrompt(deps)
  const charge = chargeBudget(deps.budget, "mid")
  if (!charge.ok) return { ok: false, error: `budget: ${charge.reason}` }

  const reply = await deps.llm({
    system,
    user: userPrompt(deps),
    tier: "mid",
    maxTokens: 4096,
    temperature: 0,
    label: "draft",
  })
  const parsed = parseDraftReply(reply)
  if (parsed.size === 0) {
    // parseDraftReply swallows the parse error, so re-run it here to surface
    // WHY. Without this an operator sees only "no parseable array" and cannot
    // tell a truncated response (raise maxTokens) from a malformed one (the
    // model emitted a bad character mid-array — one glitch discards the whole
    // span). Deliberately logs no reply text: these are translation drafts,
    // and the failure classification is the diagnostic value, not the content.
    const start = reply.indexOf("[")
    const end = reply.lastIndexOf("]")
    let why = end <= start ? "no closing ] (truncated mid-array?)" : "no {i,t} items"
    if (end > start) {
      try {
        JSON.parse(reply.slice(start, end + 1))
      } catch (err) {
        why = err instanceof Error ? err.message.slice(0, 120) : "parse failed"
      }
    }
    console.error(
      `[contextual] draft reply unparseable (${deps.pairs.length} segments, ${reply.length} chars): ${why}`,
    )
    return { ok: false, error: "drafting model returned no parseable [{i,t}] array" }
  }

  const cells: { cellId: string; text: string }[] = []
  const missedCellIds: string[] = []
  deps.pairs.forEach((p, i) => {
    const t = parsed.get(i + 1)
    if (t && t.trim()) cells.push({ cellId: p.cellId, text: t.trim() })
    else missedCellIds.push(p.cellId)
  })

  const exampleIds = Array.from(
    new Set(deps.examples.flatMap((e) => (e.cellId ? [e.cellId] : []))),
  )
  return {
    ok: true,
    draft: {
      spanId: deps.sceneBrief.spanId,
      sceneBriefId: deps.sceneBrief.id,
      cells,
      exampleIds,
      promptVersion: `${CONTEXTUAL_PROMPT_VERSION}:${promptFingerprint(system)}`,
    },
    missedCellIds,
  }
}
