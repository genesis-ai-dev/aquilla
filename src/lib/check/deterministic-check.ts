/**
 * Deterministic "Check file" pass — Phase 0.5 of the agentic-harness strategy
 * (docs/superpowers/specs/agentic-harness-strategy.md §4 `check-chapter`,
 * deterministic pass only).
 *
 * Pure functions, no network, no LLM. Two scans over the scoped cells:
 *
 *  1. Rule violations — `checkRulesForCell` over every scoped cell using the
 *     project's enabled NON-terminology rules. Terminology-compiled rules
 *     (id `term:…`) are excluded here because scan #2 covers the same
 *     concepts with per-concept occurrence aggregation; including both would
 *     double-report every miss.
 *
 *  2. Term consistency — for each active concept whose source form matches a
 *     cell's source text (shared matcher in lib/terminology/match.ts), flag
 *     cells whose target lacks ALL approved (preferred/admitted) renderings.
 *     Findings are grouped by concept so they read
 *     "Χριστός: 14 of 18 occurrences use 'Kristo', 4 use something else."
 *     The scan itself lives in `term-consistency-scan.ts` (re-exported below)
 *     so the Agent API's term-consistency read runs the same code — AQU-1231.
 *
 *  3. Capitalization (AQU-1734) — mixed capitalization inside a word
 *     (`tHe`), and headings that open with a lowercase letter. Corpus-scoped
 *     on purpose: `tHe` and `kiSwahili` are structurally identical, so only
 *     recurrence across the scoped cells tells a typo from the project's own
 *     spelling. `learnCaseExceptions` derives those exceptions here and the
 *     result reports them, so a reviewer can see what was let through. The
 *     per-cell half of the same check (lowercase after sentence-final
 *     punctuation or a paragraph/heading marker) needs no corpus and rides
 *     the rule pass as the `capitalization` built-in instead.
 *
 * Glosser drift is deferred (stretch goal in the spec): the bt-glosser builds
 * its alignment model from validated pairs at run time and a deterministic
 * "drift" verdict isn't specified yet.
 *
 * Findings are session-local; callers hold the result in component state.
 */

import type { TranslationRule, RuleInfraction } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"
import { checkRulesForCell } from "@/lib/rules/rule-engine"
import { semanticSourceText } from "@/lib/semantic-source-text"
import {
  findMixedCaseWords,
  hasCasedLetters,
  learnCaseExceptions,
  type CaseExceptionProposal,
} from "@/lib/qa/capitalization"
import { buildConceptRegex, buildTermRegex } from "@/lib/terminology/match"
import type { Concept, TermMatchingSettings } from "@/lib/terminology/types"
import type { CheckableCell, TermConsistencyFinding } from "@/lib/check/term-consistency-scan"

// `TermConsistencyFinding` (and friends) live in the alias-free leaf module so
// sync-worker can import them too (AQU-1231). Re-exported here because this
// module has always been their public home for in-app callers. The scan
// FUNCTION itself is NOT re-exported from there: AQU-1271's source-form
// matcher (`buildConceptRegex`, below) reaches `@/lib/terminology/types` for
// `Concept`/`TermMatchingSettings`, which is not alias-free-reachable, so the
// in-app scan is defined locally here rather than in the sync-worker-shared
// module. `term-consistency-scan.ts`'s own `scanTermConsistency` (plain
// `buildTermRegex` source matching, no termMatching settings) remains the one
// the external Agent API uses.
export type {
  CheckableCell,
  CheckableConcept,
  RenderingUsage,
  TermConsistencyFinding,
} from "@/lib/check/term-consistency-scan"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One rule with every cell that breaks it (grouped for card rendering). */
export interface RuleFindingGroup {
  rule: TranslationRule
  infractions: RuleInfraction[]
}

/** One capitalization finding, grouped so a form is reported once, not per cell. */
export interface CapitalizationFinding {
  /** `mixed-case` groups by word form; `lowercase-heading-start` by nothing. */
  code: "mixed-case" | "lowercase-heading-start"
  /** The offending word form for `mixed-case` — raw content, never translated. */
  form: string
  cells: { cellId: string; cellLabel?: string }[]
}

export interface CheckRunResult {
  /** ISO timestamp of when the run finished. */
  ranAt: string
  fileId: string | null
  /** What was checked — the summary line per spec §8. */
  checkedCellCount: number
  checkedRuleCount: number
  checkedTermCount: number
  ruleFindings: RuleFindingGroup[]
  termFindings: TermConsistencyFinding[]
  /** AQU-1734: corpus-scoped capitalization findings (see `scanCapitalization`). */
  capitalizationFindings: CapitalizationFinding[]
  /** Forms the capitalization scan learned to allow, for a reviewer to confirm. */
  caseExceptions: CaseExceptionProposal[]
  /** Total issue count: infraction rows + flagged term cells + capitalization cells. */
  totalFindingCount: number
}

// ---------------------------------------------------------------------------
// Term-consistency scan (pure, synchronous)
// ---------------------------------------------------------------------------

/**
 * Scan scoped cells for term consistency against active concepts.
 *
 * Only translated cells participate (an empty target is "not translated yet",
 * not a term inconsistency — mirrors the rule engine's empty short-circuit).
 * Concepts with no approved renderings produce no finding: there is nothing
 * the target could be checked against.
 *
 * Returns one finding per concept that has ≥1 occurrence, in concept order.
 * Callers typically render only findings with flaggedCells.length > 0 but the
 * fully-consistent ones are returned too so the UI can say "14 of 14".
 */
export function scanTermConsistency(
  cells: readonly CheckableCell[],
  concepts: readonly Concept[],
  termMatching?: TermMatchingSettings,
): TermConsistencyFinding[] {
  const findings: TermConsistencyFinding[] = []

  for (const concept of concepts) {
    if (concept.status !== "active") continue
    // AQU-1271: source side through the concept matcher so the check agrees
    // with the rule engine, the chips and the glossary counts.
    const sourceRe = buildConceptRegex(concept, termMatching)
    if (!sourceRe) continue

    const approved = concept.renderings.filter(
      (r) => r.status === "preferred" || r.status === "admitted",
    )
    if (approved.length === 0) continue

    const approvedRes = approved
      .map((r) => ({ rendering: r.rendering, re: buildTermRegex(r.rendering) }))
      .filter((x): x is { rendering: string; re: RegExp } => x.re !== null)
    if (approvedRes.length === 0) continue

    let totalOccurrences = 0
    let consistentCount = 0
    const usage = new Map<string, string[]>()
    const flaggedCells: TermConsistencyFinding["flaggedCells"] = []

    for (const cell of cells) {
      if (cell.status === "empty" || !cell.translated.trim()) continue
      // `semanticSourceText`, not `effectiveSourceText`: a `CheckableCell` types
      // `medium` as a plain string (the sync-worker row shape), which the SPA's
      // `SegmentMedium`-typed entry point rejects. Same rule either way — this
      // is the call the shared scan in term-consistency-scan.ts makes.
      if (!sourceRe.test(semanticSourceText(cell))) continue
      totalOccurrences++

      let matchedAny = false
      for (const { rendering, re } of approvedRes) {
        if (re.test(cell.translated)) {
          matchedAny = true
          const list = usage.get(rendering)
          if (list) list.push(cell.id)
          else usage.set(rendering, [cell.id])
        }
      }
      if (matchedAny) consistentCount++
      else flaggedCells.push({ cellId: cell.id, cellLabel: cell.cellLabel })
    }

    if (totalOccurrences === 0) continue
    findings.push({
      conceptId: concept.id,
      sourceTerm: concept.sourceTerm,
      approvedRenderings: approvedRes.map((x) => x.rendering),
      totalOccurrences,
      consistentCount,
      renderingUsage: [...usage.entries()].map(([rendering, cellIds]) => ({
        rendering,
        cellIds,
      })),
      flaggedCells,
    })
  }

  return findings
}

// ---------------------------------------------------------------------------
// Capitalization scan (pure, synchronous — AQU-1734)
// ---------------------------------------------------------------------------

/** Cells whose `type` says the text is a section heading rather than body. */
const HEADING_TYPES = new Set(["heading"])

export interface CapitalizationScanResult {
  findings: CapitalizationFinding[]
  exceptions: CaseExceptionProposal[]
}

/**
 * Corpus-scoped capitalization scan over the checked cells.
 *
 * Exceptions are learned from the cells themselves — a form recurring across
 * the scope, or a lowercase-prefix family (`kiSwahili` / `kiNgozi`), is the
 * project's own spelling and is reported as an exception instead of being
 * flagged in every cell that uses it. Forms the SOURCE already writes that way
 * are excepted outright, and caseless-script cells never produce findings.
 */
export function scanCapitalization(
  cells: readonly { id: string; cellLabel?: string; translated: string; original: string; status: string; type?: string }[],
): CapitalizationScanResult {
  const translated = cells.filter((c) => c.status !== "empty" && c.translated.trim().length > 0)
  if (translated.length === 0) return { findings: [], exceptions: [] }

  const { exceptions, proposals } = learnCaseExceptions(
    translated.map((c) => c.translated),
    translated.map((c) => c.original),
  )

  const byForm = new Map<string, CapitalizationFinding["cells"]>()
  const headingCells: CapitalizationFinding["cells"] = []

  for (const cell of translated) {
    for (const span of findMixedCaseWords(cell.translated, exceptions)) {
      const list = byForm.get(span.matchedText)
      if (list) {
        if (!list.some((c) => c.cellId === cell.id)) list.push({ cellId: cell.id, cellLabel: cell.cellLabel })
      } else {
        byForm.set(span.matchedText, [{ cellId: cell.id, cellLabel: cell.cellLabel }])
      }
    }
    // A heading is its own cell, so "a lowercase letter at the start of a
    // section heading" is only decidable here, where the cell's type is known
    // — a body cell may legitimately continue the previous verse's sentence.
    if (cell.type && HEADING_TYPES.has(cell.type) && hasCasedLetters(cell.translated)) {
      const first = /\p{L}/u.exec(cell.translated)?.[0]
      if (first && first === first.toLowerCase() && first !== first.toUpperCase()) {
        headingCells.push({ cellId: cell.id, cellLabel: cell.cellLabel })
      }
    }
  }

  const findings: CapitalizationFinding[] = [...byForm.entries()]
    .map(([form, cs]): CapitalizationFinding => ({ code: "mixed-case", form, cells: cs }))
    .sort((a, b) => b.cells.length - a.cells.length || a.form.localeCompare(b.form))
  if (headingCells.length > 0) {
    findings.push({ code: "lowercase-heading-start", form: "", cells: headingCells })
  }
  return { findings, exceptions: proposals }
}

// ---------------------------------------------------------------------------
// Rule pass (pure, synchronous per cell)
// ---------------------------------------------------------------------------

/** Enabled, non-terminology rules — the rule pass's working set. */
export function checkableRules(rules: readonly TranslationRule[]): TranslationRule[] {
  return rules.filter((r) => r.enabled && !r.id.startsWith("term:"))
}

/** Group flat infractions by rule for card rendering. Preserves rule order. */
export function groupInfractionsByRule(
  infractions: readonly RuleInfraction[],
  rules: readonly TranslationRule[],
): RuleFindingGroup[] {
  const byRule = new Map<string, RuleInfraction[]>()
  for (const inf of infractions) {
    const list = byRule.get(inf.ruleId)
    if (list) list.push(inf)
    else byRule.set(inf.ruleId, [inf])
  }
  const groups: RuleFindingGroup[] = []
  for (const rule of rules) {
    const list = byRule.get(rule.id)
    if (list && list.length > 0) groups.push({ rule, infractions: list })
  }
  return groups
}

// ---------------------------------------------------------------------------
// Full run (chunked so hundreds of cells never block a frame)
// ---------------------------------------------------------------------------

export interface CheckRunInput {
  fileId: string | null
  cells: readonly CellData[]
  /** Full rule list (enabled flags respected; `term:` rules excluded here). */
  rules: readonly TranslationRule[]
  /** Project term base; only `active` concepts are scanned. */
  concepts: readonly Concept[]
  /** Project-level source matching defaults (AQU-1271). */
  termMatching?: TermMatchingSettings
}

const CHUNK_SIZE = 100

/** Yield to the event loop between chunks so the UI stays responsive. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Run the full deterministic check. Async only for chunked yielding — there
 * is no I/O. Safe to call with hundreds of cells.
 */
export async function runDeterministicCheck(
  input: CheckRunInput,
): Promise<CheckRunResult> {
  const enabledRules = checkableRules(input.rules)
  const activeConcepts = input.concepts.filter((c) => c.status === "active")

  // Rule pass, chunked.
  const infractions: RuleInfraction[] = []
  for (let i = 0; i < input.cells.length; i += CHUNK_SIZE) {
    const chunk = input.cells.slice(i, i + CHUNK_SIZE)
    for (const cell of chunk) {
      infractions.push(...checkRulesForCell(cell, cell.fileId, enabledRules))
    }
    if (i + CHUNK_SIZE < input.cells.length) await nextTick()
  }

  // Term pass (regex over short strings; one pass is cheap, but yield first
  // so the rule pass's last chunk paints).
  await nextTick()
  const termFindings = scanTermConsistency(input.cells, activeConcepts, input.termMatching)

  // Capitalization pass (AQU-1734): two passes over the same short strings —
  // one to learn exceptions, one to flag what is left.
  await nextTick()
  const capitalization = scanCapitalization(input.cells)

  const flaggedTermCells = termFindings.reduce(
    (n, f) => n + f.flaggedCells.length,
    0,
  )

  const capitalizationCells = capitalization.findings.reduce((n, f) => n + f.cells.length, 0)

  return {
    ranAt: new Date().toISOString(),
    fileId: input.fileId,
    checkedCellCount: input.cells.length,
    checkedRuleCount: enabledRules.length,
    checkedTermCount: activeConcepts.length,
    ruleFindings: groupInfractionsByRule(infractions, enabledRules),
    termFindings,
    capitalizationFindings: capitalization.findings,
    caseExceptions: capitalization.exceptions,
    totalFindingCount: infractions.length + flaggedTermCells + capitalizationCells,
  }
}
