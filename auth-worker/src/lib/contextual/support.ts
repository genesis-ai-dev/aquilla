// support — does the draft say anything the retrieval never showed it?
// (graph node `support`, CODE tier + a fast-tier confirmation.)
//
// The claim the drafter makes is causal: given validated pairs 1..N as the
// only evidence of how this project renders this language, the draft is what
// those pairs imply. That claim is checkable in code. Content in the draft
// that is attested nowhere in the pairs it was shown is not necessarily
// wrong — a new passage introduces new vocabulary, and morphology reshapes
// words — but it is the part of the draft the retrieval does not vouch for,
// and it is exactly where a drafting model invents.
//
// So the check runs in three escalating tiers, cheapest first:
//
//   1. CODE (this file, free)      — tokenize, attest against the corpus the
//                                    prompt actually carried, flag the cells
//                                    whose unattested share crosses a floor.
//                                    Most cells clear here and cost nothing.
//   2. FAST MODEL (confirmSupport) — only for flagged cells: is the
//                                    unattested wording ordinary morphology
//                                    and necessary new vocabulary, or is it
//                                    invented? One cheap call per span.
//   3. DEEP PANEL (router)         — only for cells the fast model confirms.
//
// Tier 1 exists to keep tier 3 rare; tier 2 exists to keep tier 1's false
// positives from making tier 3 common. Escalating on the code signal alone
// would fire the full verifier panel on every morphologically rich language.

import {
  chargeBudget,
  type LlmCall,
  type RunBudget,
  type SpanDraft,
} from "./types"

// ── Thresholds ───────────────────────────────────────────────────────────────

/** Corpus texts below this ⇒ nothing to attest against; the check abstains. */
export const MIN_CORPUS_TEXTS = 5
/** Distinct target-side tokens below this ⇒ the vocabulary is too small for
 *  "unattested" to mean anything. A five-word corpus makes every draft novel. */
export const MIN_CORPUS_TOKENS = 60
/** Cells shorter than this are not judged: one novel token in a three-token
 *  cell is a 0.33 ratio and no evidence at all. */
export const MIN_CELL_TOKENS = 4
/** Attested share below this ⇒ the cell is a candidate for confirmation. */
export const CELL_SUPPORT_FLOOR = 0.6
/** Crude stemming: a draft token counts as attested when some corpus token
 *  shares this many leading characters. Agglutinative and richly inflected
 *  target languages would otherwise report most of a correct draft as novel. */
export const PREFIX_MATCH_MIN = 5
/** Novel tokens carried per cell into the confirmation prompt. */
export const MAX_NOVEL_REPORTED = 12

// ── Types ────────────────────────────────────────────────────────────────────

/** The evidence the draft prompt ACTUALLY carried — not everything the project
 *  knows. The question is whether the retrieval supports the draft, so widening
 *  this to the whole project would answer a different (and weaker) question. */
export interface SupportCorpus {
  /** Target-side texts: retrieved example targets + preceding validated targets. */
  targets: string[]
  /** Source-side texts: names, numbers and citations legitimately carried through. */
  sources: string[]
}

export interface CellSupport {
  cellId: string
  /** Content tokens in the drafted text. */
  tokens: number
  /** How many of them the corpus attests. */
  attested: number
  /** attested / tokens; 1 for an empty cell. */
  ratio: number
  /** Unattested tokens, deduped, first-appearance order, capped. */
  novel: string[]
}

export interface SpanSupport {
  /** False when the corpus is too thin to judge — never routed on. */
  applicable: boolean
  /** Why the check abstained, when it did. */
  abstainReason?: string
  /** Span-level attested / total over judged cells; 1 when nothing was judged. */
  ratio: number
  cells: CellSupport[]
  /** Judged cells below CELL_SUPPORT_FLOOR — the confirmation's work list. */
  suspect: CellSupport[]
}

/** What the router consumes. Deliberately narrow: a level, not a transcript. */
export interface SupportSignal {
  applicable: boolean
  ratio: number
  /** Cells whose unattested wording survived confirmation. */
  riskyCellIds: string[]
}

// ── Tier 1: code ─────────────────────────────────────────────────────────────

/**
 * Unicode-aware content tokenizer. Mirrors the SPA's
 * `src/lib/search/tokenizer.ts` (not importable across the worker boundary):
 * strip markup, fold case, keep letters/marks/numbers, split on the rest.
 * `\p{M}` keeps combining marks attached so Hebrew niqqud and Arabic harakat
 * do not shatter every word into fragments.
 */
export function tokenizeSupport(text: string): string[] {
  return (text || "")
    .toLowerCase()
    .replace(/<[^>]*?>/g, " ")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
}

interface Attestation {
  exact: Set<string>
  prefixes: Set<string>
  /** Distinct TARGET-side tokens — the applicability measure. */
  distinctTargets: number
}

/** Index the corpus once per span. Both sides attest; only targets count
 *  toward applicability, since source tokens are a different language and
 *  would inflate a vocabulary that is not the one being judged. */
export function buildAttestation(corpus: SupportCorpus): Attestation {
  const exact = new Set<string>()
  const prefixes = new Set<string>()
  const targetTokens = new Set<string>()
  const add = (text: string, isTarget: boolean): void => {
    for (const token of tokenizeSupport(text)) {
      exact.add(token)
      if (token.length >= PREFIX_MATCH_MIN) prefixes.add(token.slice(0, PREFIX_MATCH_MIN))
      if (isTarget) targetTokens.add(token)
    }
  }
  for (const text of corpus.targets) add(text, true)
  for (const text of corpus.sources) add(text, false)
  return { exact, prefixes, distinctTargets: targetTokens.size }
}

function isAttested(token: string, att: Attestation): boolean {
  if (att.exact.has(token)) return true
  return token.length >= PREFIX_MATCH_MIN && att.prefixes.has(token.slice(0, PREFIX_MATCH_MIN))
}

/**
 * Attest every drafted cell against the corpus. Pure, synchronous, zero
 * tokens. Cells shorter than MIN_CELL_TOKENS are measured but never marked
 * suspect — the ratio is too coarse at that length to carry a decision.
 */
export function analyzeSupport(draft: SpanDraft, corpus: SupportCorpus): SpanSupport {
  const att = buildAttestation(corpus)
  const cells: CellSupport[] = []
  for (const cell of draft.cells) {
    const tokens = tokenizeSupport(cell.text)
    const novel: string[] = []
    const seen = new Set<string>()
    let attested = 0
    for (const token of tokens) {
      if (isAttested(token, att)) {
        attested += 1
      } else if (!seen.has(token)) {
        seen.add(token)
        if (novel.length < MAX_NOVEL_REPORTED) novel.push(token)
      }
    }
    cells.push({
      cellId: cell.cellId,
      tokens: tokens.length,
      attested,
      ratio: tokens.length === 0 ? 1 : attested / tokens.length,
      novel,
    })
  }

  const abstainReason =
    corpus.targets.filter((t) => t.trim()).length < MIN_CORPUS_TEXTS
      ? `corpus has fewer than ${MIN_CORPUS_TEXTS} target texts`
      : att.distinctTargets < MIN_CORPUS_TOKENS
        ? `corpus vocabulary is ${att.distinctTargets} distinct token(s) (< ${MIN_CORPUS_TOKENS})`
        : undefined
  if (abstainReason) {
    return { applicable: false, abstainReason, ratio: 1, cells, suspect: [] }
  }

  const judged = cells.filter((c) => c.tokens >= MIN_CELL_TOKENS)
  const totalTokens = judged.reduce((n, c) => n + c.tokens, 0)
  const totalAttested = judged.reduce((n, c) => n + c.attested, 0)
  return {
    applicable: true,
    ratio: totalTokens === 0 ? 1 : totalAttested / totalTokens,
    cells,
    suspect: judged.filter((c) => c.ratio < CELL_SUPPORT_FLOOR),
  }
}

// ── Tier 2: fast model ───────────────────────────────────────────────────────

export interface ConfirmSupportDeps {
  draft: SpanDraft
  support: SpanSupport
  /** Source text per drafted cell, so the confirmer can see what the novel
   *  wording is FOR — a new proper noun in the source explains a new token. */
  sourcesByCellId: Map<string, string>
  targetLanguage?: string
  llm: LlmCall
  budget: RunBudget
}

export interface ConfirmSupportResult {
  riskyCellIds: string[]
  /** Per-cell justification, for the span report. */
  reasons: Record<string, string>
  /** True when the model answered; false when it was unaffordable, threw, or
   *  returned nothing parseable — in which case every suspect cell is treated
   *  as risky. Fail-safe: an unavailable cheap check must escalate to the
   *  expensive one, never quietly wave the span through. */
  confirmed: boolean
  error?: string
}

/** Tolerant parse of `{"cells":[{"i":1,"risky":true,"reason":"…"}]}`. */
export function parseConfirmReply(
  content: string,
  suspect: CellSupport[],
): { cellId: string; risky: boolean; reason: string }[] | null {
  const start = content.indexOf("{")
  const end = content.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const raw = JSON.parse(content.slice(start, end + 1)) as { cells?: unknown }
    if (!Array.isArray(raw.cells)) return null
    const out: { cellId: string; risky: boolean; reason: string }[] = []
    for (const entry of raw.cells as { i?: unknown; risky?: unknown; reason?: unknown }[]) {
      if (typeof entry !== "object" || entry === null) continue
      if (typeof entry.i !== "number" || typeof entry.risky !== "boolean") continue
      const cell = suspect[entry.i - 1]
      if (!cell) continue
      out.push({
        cellId: cell.cellId,
        risky: entry.risky,
        reason: typeof entry.reason === "string" ? entry.reason : "",
      })
    }
    return out
  } catch {
    return null
  }
}

/**
 * Ask the cheap model the one narrow question code cannot answer: is this
 * unattested wording ordinary language, or invention?
 *
 * The prompt carries only the flagged cells and their novel tokens — not the
 * corpus, not the scene brief, not the other cells. The judgment is simple and
 * local, which is precisely why it does not need the frontier model.
 */
export async function confirmSupport(deps: ConfirmSupportDeps): Promise<ConfirmSupportResult> {
  const suspect = deps.support.suspect
  const allRisky = (error: string): ConfirmSupportResult => ({
    riskyCellIds: suspect.map((c) => c.cellId),
    reasons: Object.fromEntries(suspect.map((c) => [c.cellId, `unconfirmed (${error})`])),
    confirmed: false,
    error,
  })
  if (suspect.length === 0) return { riskyCellIds: [], reasons: {}, confirmed: true }

  const charge = chargeBudget(deps.budget, "fast")
  if (!charge.ok) return allRisky(`budget: ${charge.reason}`)

  const textByCellId = new Map(deps.draft.cells.map((c) => [c.cellId, c.text]))
  const block = suspect
    .map((c, i) => {
      const parts = [
        `${i + 1}.`,
        `   source: ${deps.sourcesByCellId.get(c.cellId) ?? "(unknown)"}`,
        `   draft:  ${textByCellId.get(c.cellId) ?? ""}`,
        `   unattested wording: ${c.novel.join(", ")}`,
        `   attested share: ${c.ratio.toFixed(2)}`,
      ]
      return parts.join("\n")
    })
    .join("\n")

  // [[ctx:support]] routes the scripted e2e mock (scripts/mock-openrouter.ts).
  const system = `[[ctx:support]] You are a fast triage check on machine-translated drafts${deps.targetLanguage ? ` in ${deps.targetLanguage}` : ""}. Each item below contains wording that appears NOWHERE in the validated translation pairs the drafter was shown.

For each item decide ONE thing: is the unattested wording a genuine risk, or benign?

BENIGN (risky=false) — the usual case:
- inflected, compounded, or affixed forms of words the project already uses;
- vocabulary the SOURCE segment plainly requires (a name, place, number, or object that has not come up before);
- ordinary function words and connectives.

RISKY (risky=true):
- content with no basis in the source segment — added explanation, invented detail, a name or number the source does not contain;
- a key term rendered with wording unrelated to anything the project uses;
- wording that looks like a different language, or like the drafting model's own commentary.

Judge only the unattested wording. Do not review style, fluency, or accuracy in general — other checks own those.

Output STRICT JSON only, no prose, no code fences:
{"cells":[{"i":1,"risky":false,"reason":"…"}]}
One entry per numbered item; "reason" is required whenever risky is true.`

  let reply: string
  try {
    reply = await deps.llm({
      system,
      user: `Triage these ${suspect.length} draft segment(s):\n${block}`,
      tier: "fast",
      maxTokens: 1024,
      temperature: 0,
      label: "support",
    })
  } catch {
    return allRisky("support confirmation call failed")
  }

  const parsed = parseConfirmReply(reply, suspect)
  if (!parsed || parsed.length === 0) return allRisky("support confirmation returned no parseable verdict")

  const verdictByCellId = new Map(parsed.map((p) => [p.cellId, p]))
  const riskyCellIds: string[] = []
  const reasons: Record<string, string> = {}
  for (const cell of suspect) {
    const verdict = verdictByCellId.get(cell.cellId)
    // A cell the model silently omitted was never triaged — escalate it
    // rather than read the omission as approval.
    if (!verdict) {
      riskyCellIds.push(cell.cellId)
      reasons[cell.cellId] = "unconfirmed (omitted from the triage verdict)"
      continue
    }
    if (verdict.risky) {
      riskyCellIds.push(cell.cellId)
      reasons[cell.cellId] = verdict.reason || "unattested wording judged risky"
    }
  }
  return { riskyCellIds, reasons, confirmed: true }
}

/**
 * Collapse the two tiers into the router's input.
 *
 * The reported ratio EXCLUDES cells the fast model cleared. Without that, the
 * cheap check would be overruled by the raw code measurement it exists to
 * refine: a span whose only thin cell was vouched for still averages low, and
 * would escalate to the deep panel anyway — spending tier 3 on exactly the
 * case tier 2 was added to prevent. What survives is the span-wide signal the
 * per-cell floor cannot see: many cells each just above the floor, thin
 * together.
 */
export function toSupportSignal(support: SpanSupport, confirmation: ConfirmSupportResult): SupportSignal {
  const risky = new Set(confirmation.riskyCellIds)
  const cleared = new Set(support.suspect.map((c) => c.cellId).filter((id) => !risky.has(id)))
  const counted = support.cells.filter(
    (c) => c.tokens >= MIN_CELL_TOKENS && !cleared.has(c.cellId),
  )
  const tokens = counted.reduce((n, c) => n + c.tokens, 0)
  const attested = counted.reduce((n, c) => n + c.attested, 0)
  return {
    applicable: support.applicable,
    ratio: tokens === 0 ? 1 : attested / tokens,
    riskyCellIds: confirmation.riskyCellIds,
  }
}
