// Worker-safe core of Concept → TranslationRule compilation (AQU-1230).
//
// `compile.ts` is the app-facing entry point and stays the only place that
// knows about i18n; it passes a `CompileLabels` bundle backed by `t()`. This
// module holds the compilation itself so workers compile a project's
// terminology into the SAME rules the editor compiles: the Agent API's
// effective-prompt preview (sync-worker/src/external/prompt-preview.ts) and
// autopilot's terminology lint (lintTerminology in
// auth-worker/src/lib/contextual/project-context.ts, AQU-1711) — without
// dragging the 2.9 MB i18n catalogs into the worker bundle. Keep it the only
// compiler: a second copy is how the editor and the workers drifted apart.
//
// Same constraints as src/lib/completion/prompt-build.ts: no `@/` aliases
// (transitively), no DOM, no storage, no i18n. Parameter/return types are
// structural — `Concept` satisfies `CompiledConcept`, and `CompiledTermRule`
// satisfies `TranslationRule`.
//
// Rules produced per active concept:
//   preferred / admitted renderings → one `source-requires-target` rule
//     (instance counts add up 1:1: each sourceTerm hit needs a counterpart
//      approved rendering, and extra renderings in the target are also a miss)
//   each forbidden rendering → one `target-forbids` rule per rendering
//     (the source bears the concept AND the target contains the forbidden
//      text ⇒ violation. The source condition rides on the check as
//      `sourcePattern` — AQU-1712; before it the editor flagged the rendering
//      in every cell, while lintTerminology and the worker's project scan
//      already required the source to bear the concept)
//
// draft / deprecated concepts are skipped entirely.
//
// Every rule also carries a `term` payload (AQU-2209): the concept id, the
// plain source term and renderings, and the source pattern. Prompt injection
// reads ONLY that — `buildRulesBlock` narrows terminology to the concepts
// present in the cell being drafted and renders them as `Moses → Moisés`,
// instead of spelling every concept's match regex into every draft call. The
// `check` patterns remain the rule engine's and nobody else's.

import { conceptToRegexSource, termToRegexSource } from "./match"
import type { TermMatchOptions, TermMatchingSettings } from "./model"
import type { PromptTermInfo } from "../completion/prompt-build"

/** Structural echo of `TermRendering` (./types). */
export interface CompiledRendering {
  rendering: string
  status: string
}

/** Structural echo of `Concept` (./types) — only the fields compilation reads. */
export interface CompiledConcept {
  id: string
  sourceTerm: string
  renderings: CompiledRendering[]
  status: string
  caseSensitive?: boolean
  match?: TermMatchOptions
  /** The termbase entry's note. Carried into prompts (clipped) with the
   *  renderings — AQU-2342: every drafting path shows term notes. */
  notes?: string
}

/** Structural echo of `TranslationRule` (../parsers/types) for the two check
 *  shapes terminology compiles to. */
export interface CompiledTermRule {
  id: string
  name: string
  description: string
  severity: "major" | "minor"
  source: "user"
  scope: "project"
  enabled: boolean
  createdAt: string
  check:
    | { type: "source-requires-target"; sourcePattern: string; targetPattern: string; caseSensitive?: boolean }
    | { type: "target-forbids"; targetPattern: string; sourcePattern: string; caseSensitive?: boolean }
  /** Regex-free data for prompt injection (AQU-2209) — the plain source term
   *  and renderings, plus the source pattern injection narrows on. Derived on
   *  read with the rest of the rule; nothing persists it. */
  term: PromptTermInfo
}

/**
 * Display strings for the compiled rules. `name`/`description` are shown in the
 * rules UI and violation popovers — they are NOT part of prompt injection
 * (buildRulesBlock reads only `check`), so a caller with no locale available
 * (the worker) may pass plain-English stand-ins without changing what the
 * copilot receives.
 */
export interface CompileLabels {
  approvedName(term: string): string
  approvedDescription(term: string, renderings: string): string
  forbiddenName(term: string): string
  forbiddenDescription(rendering: string, term: string): string
}

/**
 * Escape a string for safe use inside a RegExp literal. Only used to build the
 * STABLE rule `id` discriminator for forbidden renderings (other code groups by
 * id, so the scheme must not change) — NOT for match patterns, which go through
 * the shared wildcard-aware matcher in ./match.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Compile a list of concepts into rule instances.
 *
 * Only `active` concepts produce rules. The returned rules use existing
 * TranslationRule check types — no new check kinds are introduced.
 *
 * `termMatching` is the consuming project's affix inventory
 * (ProjectWideSettings.termMatching); without it the source pattern still
 * applies the concept's own match options and script-derived mark folding.
 */
export function compileConceptsToRulesCore(
  concepts: CompiledConcept[],
  labels: CompileLabels,
  termMatching?: TermMatchingSettings,
): CompiledTermRule[] {
  const rules: CompiledTermRule[] = []
  const now = new Date().toISOString()

  for (const concept of concepts) {
    if (concept.status !== "active") continue

    const approved = concept.renderings.filter(
      (r) => r.status === "preferred" || r.status === "admitted",
    )
    const forbidden = concept.renderings.filter((r) => r.status === "forbidden")

    // AQU-1271: the SOURCE side goes through the concept matcher, so the rule
    // engine sees the same surface forms as chips, stats and the term page —
    // wildcards plus mark-folding, project affixes, extra forms and exclusions.
    // Returns null for empty/whitespace terms → skip concept.
    const sourcePattern = conceptToRegexSource(
      { sourceTerm: concept.sourceTerm, match: concept.match },
      termMatching,
    )
    if (sourcePattern === null) continue

    // Shared by this concept's rules, so injection tests one pattern per
    // concept rather than one per rule (AQU-2209).
    const term: PromptTermInfo = {
      conceptId: concept.id,
      sourceTerm: concept.sourceTerm,
      sourcePattern,
      ...(concept.caseSensitive ? { caseSensitive: true } : {}),
      ...(concept.notes?.trim() ? { notes: concept.notes.trim() } : {}),
    }

    // source-requires-target: each source instance needs a counterpart rendering.
    if (approved.length > 0) {
      // Alternation of all approved renderings, each wildcard-aware. Drop any
      // empty rendering pattern. rule-engine compiles this with /i (+/u for
      // term: rules) so \p{L} wildcards resolve.
      const targetAlts = approved
        .map((r) => termToRegexSource(r.rendering))
        .filter((p): p is string => p !== null)
        .join("|")
      const targetPattern = targetAlts

      // Guard: if every approved rendering was empty/whitespace the alternation
      // is "" (which would match anything). Emit no rule in that degenerate case.
      if (targetPattern) rules.push({
        id: `term:${concept.id}:approved`,
        name: labels.approvedName(concept.sourceTerm),
        description: labels.approvedDescription(
          concept.sourceTerm,
          approved.map((r) => r.rendering).join(", "),
        ),
        severity: "minor",
        source: "user",
        scope: "project",
        enabled: true,
        createdAt: now,
        check: {
          type: "source-requires-target",
          sourcePattern,
          targetPattern,
          ...(concept.caseSensitive ? { caseSensitive: true } : {}),
        },
        term: { ...term, approved: approved.map((r) => r.rendering) },
      })
    }

    // target-forbids: source has the term AND target contains a forbidden rendering.
    // One rule per forbidden rendering so the violation message names the exact form.
    for (const f of forbidden) {
      // AQU-1712: "forbidden rendering in the target when the source bears the
      // concept". The source condition rides on the check as `sourcePattern` —
      // the SAME pattern the concept's approved rule matches its source side
      // with, so both rules of a concept apply to exactly the same cells.
      // Without it the editor flagged every cell whose translation contained
      // the rendering, including cells whose source never mentions the
      // concept: a forbidden rendering is usually an ordinary word that is
      // wrong only as a rendering of this one concept.
      const forbiddenPattern = termToRegexSource(f.rendering)
      if (forbiddenPattern === null) continue
      rules.push({
        // id discriminator keeps the EXACT escapeRegex scheme — other code groups by it.
        id: `term:${concept.id}:forbidden:${escapeRegex(f.rendering)}`,
        name: labels.forbiddenName(concept.sourceTerm),
        description: labels.forbiddenDescription(f.rendering, concept.sourceTerm),
        severity: "major",
        source: "user",
        scope: "project",
        enabled: true,
        createdAt: now,
        check: {
          type: "target-forbids",
          targetPattern: forbiddenPattern,
          sourcePattern,
          ...(concept.caseSensitive ? { caseSensitive: true } : {}),
        },
        term: { ...term, forbidden: f.rendering },
      })
    }
  }

  return rules
}
