// Translation helps, words for pack ids (AQU-1695).
//
// The pack's slugs and enums reach the screen only through these typed
// tables, as people-text.ts and voice-text.ts do for Who's Who and Voices.

import type { KinRelation } from "@/lib/bible-data/entity-facts"
import type { BkpTerm } from "@/lib/bible-data/pack-types"
import type { MessageKey } from "@/lib/i18n/messages/en"

/**
 * Names for the unfoldingWord Translation Academy topics that NT notes cite
 * most. Measured on pack 1.1.0: these 22 slugs cover 25,511 of its 35,657
 * notes (76% of those with a topic).
 */
export const TA_CATEGORY_KEYS: Readonly<Record<string, MessageKey>> = {
  "figs-explicit": "bibleHelps.category.figsExplicit",
  "figs-metaphor": "bibleHelps.category.figsMetaphor",
  "figs-activepassive": "bibleHelps.category.figsActivePassive",
  "figs-abstractnouns": "bibleHelps.category.figsAbstractNouns",
  "figs-idiom": "bibleHelps.category.figsIdiom",
  "figs-metonymy": "bibleHelps.category.figsMetonymy",
  "writing-pronouns": "bibleHelps.category.writingPronouns",
  "grammar-connect-logic-result": "bibleHelps.category.grammarConnectLogicResult",
  "translate-unknown": "bibleHelps.category.translateUnknown",
  "grammar-connect-words-phrases": "bibleHelps.category.grammarConnectWordsPhrases",
  "figs-possession": "bibleHelps.category.figsPossession",
  "figs-ellipsis": "bibleHelps.category.figsEllipsis",
  "figs-rquestion": "bibleHelps.category.figsRquestion",
  "figs-nominaladj": "bibleHelps.category.figsNominalAdj",
  "figs-gendernotations": "bibleHelps.category.figsGenderNotations",
  "translate-names": "bibleHelps.category.translateNames",
  "figs-doublet": "bibleHelps.category.figsDoublet",
  "writing-quotations": "bibleHelps.category.writingQuotations",
  "figs-synecdoche": "bibleHelps.category.figsSynecdoche",
  "figs-exclusive": "bibleHelps.category.figsExclusive",
  "figs-pastforfuture": "bibleHelps.category.figsPastForFuture",
  "guidelines-sonofgodprinciples": "bibleHelps.category.guidelinesSonOfGod",
}

/** The chip on a note: its topic, or "Translation note" for a topic the table does not name, or none. */
export function noteCategoryKey(category: string | undefined): MessageKey {
  return category && Object.hasOwn(TA_CATEGORY_KEYS, category)
    ? TA_CATEGORY_KEYS[category]
    : "bibleHelps.category.other"
}

const TERM_SOURCE_KEYS: Readonly<Record<BkpTerm["source"], MessageKey>> = {
  tw: "bibleHelps.terms.fromTw",
  acai: "bibleHelps.terms.fromAcai",
}

/** Where a key term comes from, or null for a source this build does not know (then nothing is said). */
export function termSourceKey(source: string): MessageKey | null {
  return Object.hasOwn(TERM_SOURCE_KEYS, source) ? TERM_SOURCE_KEYS[source as BkpTerm["source"]] : null
}

/** Each takes `count` (how many relatives it lists) for its plural form. */
export const KIN_KEYS: Readonly<Record<KinRelation, MessageKey>> = {
  father: "bibleHelps.kin.father",
  mother: "bibleHelps.kin.mother",
  siblings: "bibleHelps.kin.siblings",
  partners: "bibleHelps.kin.partners",
  offspring: "bibleHelps.kin.offspring",
}
