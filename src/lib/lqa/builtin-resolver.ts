import type {
  TranslationRule,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"

const FROZEN_CREATED_AT = "1970-01-01T00:00:00.000Z"

const BUILTIN_PREFIX = "builtin:"

/** The `id` a `resolveBuiltinRules()` record carries is the only thing that
 *  structurally marks it as a built-in rather than a user/org rule — four
 *  renderers (EditorTable, RuleDrawer, ViolationPopover, BuiltinChecksList)
 *  otherwise see the same `TranslationRule` shape either way. */
export function builtinCheckIdFromRuleId(ruleId: string): BuiltinCheckId | null {
  if (!ruleId.startsWith(BUILTIN_PREFIX)) return null
  const checkId = ruleId.slice(BUILTIN_PREFIX.length) as BuiltinCheckId
  return checkId in BUILTIN_CHECKS ? checkId : null
}

const NAME_KEY: Record<BuiltinCheckId, MessageKey> = {
  "empty-target": "rules.builtin.emptyTarget.name",
  "target-equals-source": "rules.builtin.targetEqualsSource.name",
  "placeholder-integrity": "rules.builtin.placeholderIntegrity.name",
  "number-integrity": "rules.builtin.numberIntegrity.name",
  "end-punctuation-mismatch": "rules.builtin.endPunctuationMismatch.name",
  "punctuation-integrity": "rules.builtin.punctuationIntegrity.name",
  "double-space": "rules.builtin.doubleSpace.name",
  "repeated-word": "rules.builtin.repeatedWord.name",
  "unpaired-symbols": "rules.builtin.unpairedSymbols.name",
  "abbreviation-mismatch": "rules.builtin.abbreviationMismatch.name",
}

const DESCRIPTION_KEY: Record<BuiltinCheckId, MessageKey> = {
  "empty-target": "rules.builtin.emptyTarget.description",
  "target-equals-source": "rules.builtin.targetEqualsSource.description",
  "placeholder-integrity": "rules.builtin.placeholderIntegrity.description",
  "number-integrity": "rules.builtin.numberIntegrity.description",
  "end-punctuation-mismatch": "rules.builtin.endPunctuationMismatch.description",
  "punctuation-integrity": "rules.builtin.punctuationIntegrity.description",
  "double-space": "rules.builtin.doubleSpace.description",
  "repeated-word": "rules.builtin.repeatedWord.description",
  "unpaired-symbols": "rules.builtin.unpairedSymbols.description",
  "abbreviation-mismatch": "rules.builtin.abbreviationMismatch.description",
}

/**
 * Display name for any `TranslationRule` — translated for the ten built-in
 * checks (app-authored chrome; resolved off the `builtin:` id prefix),
 * returned verbatim for a user or org rule (their OWN name is content and
 * must never be translated).
 */
export function translateRuleName(rule: Pick<TranslationRule, "id" | "name">, t: TFunction): string {
  const checkId = builtinCheckIdFromRuleId(rule.id)
  return checkId ? t(NAME_KEY[checkId]) : rule.name
}

/** Same split as `translateRuleName`, for `description`. */
export function translateRuleDescription(
  rule: Pick<TranslationRule, "id" | "description">,
  t: TFunction,
): string {
  const checkId = builtinCheckIdFromRuleId(rule.id)
  return checkId ? t(DESCRIPTION_KEY[checkId]) : rule.description
}

export function resolveBuiltinRules(
  overrides: Partial<Record<BuiltinCheckId, AlgorithmicCheckOverride>> | undefined,
): TranslationRule[] {
  return BUILTIN_CHECK_IDS.map((id) => {
    const def = BUILTIN_CHECKS[id]
    const ov = overrides?.[id]
    return {
      id: `builtin:${id}`,
      name: def.name,
      description: def.description,
      severity: ov?.severity ?? def.defaultSeverity,
      source: "algorithmic",
      scope: "project",
      enabled: ov?.enabled ?? def.defaultEnabled,
      createdAt: FROZEN_CREATED_AT,
      check: { type: "builtin", checkId: id },
    }
  })
}
