/**
 * Compile Concept[] → TranslationRule[].
 *
 * Produces rules that feed directly into the existing rule-engine so
 * terminology violations are DERIVED on read — no materialized verdicts.
 *
 * AQU-1230: the compilation itself moved to ./compile-core, which is
 * alias-free and worker-importable, so the Agent API's effective-prompt
 * preview compiles a project's terminology into the SAME rules — and therefore
 * the same injected prompt block — as the editor. This module is the app-facing
 * entry point and the only place that knows about i18n: `name`/`description`
 * are display strings and play no part in prompt injection.
 *
 * Rules produced per active concept:
 *   preferred / admitted renderings → one `source-requires-target` rule
 *     (instance counts add up 1:1: each sourceTerm hit needs a counterpart
 *      approved rendering, and extra renderings in the target are also a miss)
 *   each forbidden rendering → one `target-forbids` rule per rendering
 *     (source contains sourceTerm AND target contains forbidden text ⇒ violation)
 *
 * draft / deprecated concepts are skipped entirely.
 */

import type { TranslationRule } from "@/lib/parsers/types"
import type { Concept } from "./types"
import { compileConceptsToRulesCore, type CompileLabels } from "./compile-core"
import { t } from "@/lib/i18n/standalone"

/** Locale-resolved display labels for the compiled rules. */
const LOCALIZED_LABELS: CompileLabels = {
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
export function compileConceptsToRules(concepts: Concept[]): TranslationRule[] {
  return compileConceptsToRulesCore(concepts, LOCALIZED_LABELS)
}
