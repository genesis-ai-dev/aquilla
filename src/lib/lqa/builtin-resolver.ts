import type {
  TranslationRule,
  AlgorithmicCheckOverride,
  BuiltinCheckId,
} from "@/lib/parsers/types"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { BUILTIN_CHECKS, BUILTIN_CHECK_IDS } from "./builtin-registry"
import { BIBLE_BUILTIN_CHECK_IDS } from "./bible-builtin-checks"

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
  "bkp:V1": "bibleData.check.v1.name",
  "bkp:V2": "bibleData.check.v2.name",
  "bkp:V3": "bibleData.check.v3.name",
  "bkp:V5": "bibleData.check.v5.name",
  "bkp:V7": "bibleData.check.v7.name",
  "bkp:V8": "bibleData.check.v8.name",
  "bkp:V9": "bibleData.check.v9.name",
  "bkp:M1": "bibleData.check.m1.name",
  "bkp:N1": "bibleChecks.n1.name",
  "bkp:N2": "bibleChecks.n2.name",
  // AQU-1697: the name autopilot already shows for this check.
  "bkp:M3": "agent.finding.bibleCheck.negation",
  "bkp:S1": "bibleChecks.s1.name",
  "bkp:S3": "bibleChecks.s3.name",
  "bkp:S6": "bibleChecks.s6.name",
  "bkp:S7": "bibleChecks.s7.name",
  "bkp:S8": "bibleChecks.s8.name",
  // AQU-1699: check pack B. P8 keeps the name autopilot already shows for it.
  "bkp:P1": "bibleParticipants.p1.name",
  "bkp:P2": "bibleParticipants.p2.name",
  "bkp:P3": "bibleParticipants.p3.name",
  "bkp:P4": "bibleParticipants.p4.name",
  "bkp:P5": "bibleParticipants.p5.name",
  "bkp:P6": "bibleParticipants.p6.name",
  "bkp:P8": "agent.finding.bibleCheck.youNumber",
  "bkp:P9": "bibleParticipants.p9.name",
  "bkp:P10": "bibleParticipants.p10.name",
  "bkp:P14": "bibleParticipants.p14.name",
  "bkp:P15": "bibleParticipants.p15.name",
  "bkp:X3": "bibleParticipants.x3.name",
  "bkp:X4": "bibleParticipants.x4.name",
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
  "bkp:V1": "bibleData.check.v1.description",
  "bkp:V2": "bibleData.check.v2.description",
  "bkp:V3": "bibleData.check.v3.description",
  "bkp:V5": "bibleData.check.v5.description",
  "bkp:V7": "bibleData.check.v7.description",
  "bkp:V8": "bibleData.check.v8.description",
  "bkp:V9": "bibleData.check.v9.description",
  "bkp:M1": "bibleData.check.m1.description",
  "bkp:N1": "bibleChecks.n1.description",
  "bkp:N2": "bibleChecks.n2.description",
  "bkp:M3": "bibleChecks.m3.description",
  "bkp:S1": "bibleChecks.s1.description",
  "bkp:S3": "bibleChecks.s3.description",
  "bkp:S6": "bibleChecks.s6.description",
  "bkp:S7": "bibleChecks.s7.description",
  "bkp:S8": "bibleChecks.s8.description",
  "bkp:P1": "bibleParticipants.p1.description",
  "bkp:P2": "bibleParticipants.p2.description",
  "bkp:P3": "bibleParticipants.p3.description",
  "bkp:P4": "bibleParticipants.p4.description",
  "bkp:P5": "bibleParticipants.p5.description",
  "bkp:P6": "bibleParticipants.p6.description",
  "bkp:P8": "bibleParticipants.p8.description",
  "bkp:P9": "bibleParticipants.p9.description",
  "bkp:P10": "bibleParticipants.p10.description",
  "bkp:P14": "bibleParticipants.p14.description",
  "bkp:P15": "bibleParticipants.p15.description",
  "bkp:X3": "bibleParticipants.x3.description",
  "bkp:X4": "bibleParticipants.x4.description",
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

export interface ResolveBuiltinRulesOptions {
  /**
   * AQU-1688: the project's Bible data checks enrichment is on
   * (`resolveBibleEnrichment(project, "checks", …)`). Only then do the Bible
   * data checks exist as rules, so a project without Bible data never sees,
   * counts or evaluates them.
   */
  bibleChecks?: boolean
}

export function resolveBuiltinRules(
  overrides: Partial<Record<BuiltinCheckId, AlgorithmicCheckOverride>> | undefined,
  options: ResolveBuiltinRulesOptions = {},
): TranslationRule[] {
  const ids: readonly BuiltinCheckId[] = options.bibleChecks
    ? [...BUILTIN_CHECK_IDS, ...BIBLE_BUILTIN_CHECK_IDS]
    : BUILTIN_CHECK_IDS
  return ids.map((id) => {
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
