/**
 * Compile Concept[] → TranslationRule[].
 *
 * Produces rules that feed directly into the existing rule-engine so
 * terminology violations are DERIVED on read — no materialized verdicts.
 *
 * The compilation itself lives in ./compile-core (AQU-1230), which is
 * alias-free and worker-importable, so the Agent API's effective-prompt
 * preview and autopilot's terminology lint compile a project's terminology
 * into the SAME rules as the editor (AQU-1711). This module is the app-facing
 * entry point and the only place that knows about i18n: `name`/`description`
 * are display strings and play no part in prompt injection.
 *
 * Rules produced per active concept:
 *   preferred / admitted renderings → one `source-requires-target` rule
 *     (instance counts add up 1:1: each sourceTerm hit needs a counterpart
 *      approved rendering, and extra renderings in the target are also a miss)
 *   each forbidden rendering → one `target-forbids` rule per rendering
 *     (target contains the forbidden text ⇒ violation; there is no source
 *      condition yet, see AQU-1712)
 *
 * draft / deprecated concepts are skipped entirely.
 */

import type { TranslationRule } from "@/lib/parsers/types"
import type { Concept, TermMatchingSettings } from "./types"
import { compileConceptsToRulesCore, type CompileLabels } from "./compile-core"
import { t } from "@/lib/i18n/standalone"

const LABELS: CompileLabels = {
  approvedName: (term) => t("terminology.compile.ruleName", { term }),
  approvedDescription: (term, renderings) =>
    t("terminology.compile.approvedRequired", { term, renderings }),
  forbiddenName: (term) => t("terminology.compile.ruleNameForbidden", { term }),
  forbiddenDescription: (rendering, term) =>
    t("terminology.compile.forbiddenRendering", { rendering, term }),
}

/**
 * Compile a list of concepts into TranslationRule instances.
 *
 * Only `active` concepts produce rules. The returned rules use existing
 * TranslationRule check types — no new check kinds are introduced.
 */
export function compileConceptsToRules(
  concepts: Concept[],
  termMatching?: TermMatchingSettings,
): TranslationRule[] {
  return compileConceptsToRulesCore(concepts, LABELS, termMatching)
}
