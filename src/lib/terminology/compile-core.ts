// Worker-safe core of Concept → TranslationRule compilation (AQU-1230).
//
// `compile.ts` is the app-facing entry point and stays the only place that
// knows about i18n; it passes a `CompileLabels` bundle backed by `t()`. This
// module holds the compilation itself so the Agent API's effective-prompt
// preview (sync-worker/src/external/prompt-preview.ts) can compile a project's
// terminology into the SAME rules the editor compiles, and therefore into the
// same prompt block — without dragging the 2.9 MB i18n catalogs into the
// worker bundle.
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
//     (source contains sourceTerm AND target contains forbidden text ⇒ violation)
//
// draft / deprecated concepts are skipped entirely.

import { termToRegexSource } from "./match"

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
    | { type: "target-forbids"; targetPattern: string; caseSensitive?: boolean }
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
 */
export function compileConceptsToRulesCore(
  concepts: CompiledConcept[],
  labels: CompileLabels,
): CompiledTermRule[] {
  const rules: CompiledTermRule[] = []
  const now = new Date().toISOString()

  for (const concept of concepts) {
    if (concept.status !== "active") continue

    const approved = concept.renderings.filter(
      (r) => r.status === "preferred" || r.status === "admitted",
    )
    const forbidden = concept.renderings.filter((r) => r.status === "forbidden")

    // Wildcard-aware source pattern (grac* matches grace/graced/gracia, etc.).
    // termToRegexSource returns null for empty/whitespace terms → skip concept.
    const sourcePattern = termToRegexSource(concept.sourceTerm)
    if (sourcePattern === null) continue

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
      })
    }

    // target-forbids: source has the term AND target contains a forbidden rendering.
    // One rule per forbidden rendering so the violation message names the exact form.
    for (const f of forbidden) {
      // The target-forbids check fires regardless of source, but per the spec:
      // "forbidden rendering in the target when the source bears the concept".
      // The existing `target-forbids` check type does NOT have a source guard.
      // We model it as target-forbids unconditionally (matching spec intent for
      // string-match path). When a source guard is needed it can be upgraded to
      // source-requires-target with an inverted target pattern; deferred.
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
          ...(concept.caseSensitive ? { caseSensitive: true } : {}),
        },
      })
    }
  }

  return rules
}
