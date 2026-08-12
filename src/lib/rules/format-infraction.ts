/**
 * Render-time composition for `RuleInfraction` (AQU-832 rules i18n).
 *
 * `rule-engine.ts` is pure and locale-less — it returns a `reason` code +
 * `reasonParams`, never a sentence (see `RuleInfractionReason`). Every
 * caller that displays an infraction goes through this module instead of
 * reading a `message` field.
 *
 * The user's OWN rule name is never translated — it's passed in as `ruleName`
 * and only ever interpolated as a `{ruleName}` var, never looked up in the
 * catalog. Same for `reasonParams.tokens` (placeholder-integrity): raw
 * `matchedText` lifted from cell content.
 */
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { RuleInfraction, RuleInfractionReason } from "@/lib/parsers/types"

const STATIC_REASON_KEY: Partial<Record<RuleInfractionReason, MessageKey>> = {
  "target-forbids": "rules.infraction.targetForbids",
  "source-requires-target": "rules.infraction.sourceRequiresTarget",
  "source-target-match": "rules.infraction.sourceTargetMatch",
  "builtin:empty-target": "rules.infraction.builtin.emptyTarget",
  "builtin:target-equals-source": "rules.infraction.builtin.targetEqualsSource",
  "builtin:number-integrity": "rules.infraction.builtin.numberIntegrity",
  "builtin:end-punctuation-mismatch": "rules.infraction.builtin.endPunctuationMismatch",
  "builtin:punctuation-integrity": "rules.infraction.builtin.punctuationIntegrity",
  "builtin:double-space": "rules.infraction.builtin.doubleSpace",
  "builtin:repeated-word": "rules.infraction.builtin.repeatedWord",
  "builtin:unpaired-symbols": "rules.infraction.builtin.unpairedSymbols",
  "builtin:abbreviation-mismatch": "rules.infraction.builtin.abbreviationMismatch",
}

/** Just the predicate — "target contains forbidden pattern", "Placeholder {age} missing…". */
export function formatInfractionReason(infraction: RuleInfraction, t: TFunction): string {
  if (infraction.reason === "builtin:placeholder-integrity") {
    const tokens = infraction.reasonParams?.tokens ?? ""
    const count = infraction.reasonParams?.count ?? "0"
    return t("rules.infraction.builtin.placeholderIntegrity", { tokens, count })
  }
  const key = STATIC_REASON_KEY[infraction.reason]
  return key ? t(key) : infraction.reason
}

/** The predicate prefixed with the rule's own (never-translated) name, for
 *  compact single-line surfaces that don't render the name separately. */
export function formatInfractionMessage(
  infraction: RuleInfraction,
  ruleName: string,
  t: TFunction,
): string {
  return t("rules.infraction.withRuleName", {
    ruleName,
    message: formatInfractionReason(infraction, t),
  })
}
