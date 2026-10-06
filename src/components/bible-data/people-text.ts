// Who's Who, words for pack ids (AQU-1689).
//
// The pack's enums and the people index's reason codes reach the screen only
// through these typed tables, as the spec's vocabulary mapping requires
// (04-features/bible-knowledge-layer.md: mention explicit / pronoun / subject
// → Named / Pronoun / Implied subject).

import {
  isNamedEntity,
  subjectPronoun,
  type EntityGender,
  type EntityNumber,
  type SubjectPronoun,
} from "@/lib/bible-data/entity-facts"
import { BIBLE_DATA_SOURCE_SHORT_NAME_KEYS } from "@/lib/bible-data/enrichment-labels"
import type { BkpEntity, BkpEntityId, BkpMention, BkpWord } from "@/lib/bible-data/pack-types"
import type { MentionAt, MentionKind, PeopleFlag } from "@/lib/bible-data/people-index"
import type { VoiceLabel } from "@/lib/bible-data/voice-labels"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"

export const MENTION_KIND_KEYS: Readonly<Record<MentionKind, MessageKey>> = {
  explicit: "bibleData.whosWho.kind.explicit",
  pronoun: "bibleData.whosWho.kind.pronoun",
  subject: "bibleData.whosWho.kind.subject",
}

/** The kind's words, or null for a kind this build does not know (shown as nothing). */
export function mentionKindKey(kind: string): MessageKey | null {
  return Object.hasOwn(MENTION_KIND_KEYS, kind) ? MENTION_KIND_KEYS[kind as MentionKind] : null
}

export const SUBJECT_PRONOUN_KEYS: Readonly<Record<SubjectPronoun, MessageKey>> = {
  "first-singular": "bibleData.whosWho.pronoun.firstSingular",
  "first-plural": "bibleData.whosWho.pronoun.firstPlural",
  "second-singular": "bibleData.whosWho.pronoun.secondSingular",
  "second-plural": "bibleData.whosWho.pronoun.secondPlural",
  "third-singular-masculine": "bibleData.whosWho.pronoun.thirdSingularMasculine",
  "third-singular-feminine": "bibleData.whosWho.pronoun.thirdSingularFeminine",
  "third-singular-neuter": "bibleData.whosWho.pronoun.thirdSingularNeuter",
  "third-plural": "bibleData.whosWho.pronoun.thirdPlural",
}

export const GENDER_KEYS: Readonly<Record<EntityGender, MessageKey>> = {
  male: "bibleData.whosWho.gender.male",
  female: "bibleData.whosWho.gender.female",
  masculine: "bibleData.whosWho.gender.masculine",
  feminine: "bibleData.whosWho.gender.feminine",
  neuter: "bibleData.whosWho.gender.neuter",
}

export const NUMBER_KEYS: Readonly<Record<EntityNumber, MessageKey>> = {
  singular: "bibleData.whosWho.number.singular",
  plural: "bibleData.whosWho.number.plural",
}

/** The datasets a mention's `src` names, as source names. */
const MENTION_SOURCE_DATASETS: Readonly<Record<BkpMention["src"], readonly ("acai" | "macula")[]>> = {
  acai: ["acai"],
  macula: ["macula"],
  "acai+macula": ["acai", "macula"],
}

/** "ACAI", "Macula", or both, for the evidence line. Empty for a source this build does not know. */
export function mentionSourceKeys(src: string): MessageKey[] {
  if (!Object.hasOwn(MENTION_SOURCE_DATASETS, src)) return []
  return MENTION_SOURCE_DATASETS[src as BkpMention["src"]].map((id) => BIBLE_DATA_SOURCE_SHORT_NAME_KEYS[id])
}

/** Where the flag sends the translator, and which words say why. */
export function flagKey(flag: PeopleFlag): MessageKey {
  if (flag.code === "possible-ambiguity") return "bibleData.whosWho.flag.ambiguity"
  return flag.at.mention.kind === "subject"
    ? "bibleData.whosWho.flag.reintroduceSubject"
    : "bibleData.whosWho.flag.reintroducePronoun"
}

/**
 * A participant's name through the label chain. A group with members is named
 * by its members, each through the chain ("Andrew, James and Jesus"), so a
 * project's agreed names reach groups too. Null when the pack names nobody.
 */
export function participantName(
  entityId: BkpEntityId,
  entities: Readonly<Record<BkpEntityId, BkpEntity>>,
  labelFor: (entityId: BkpEntityId) => VoiceLabel | null,
  list: (items: string[]) => string,
): string | null {
  const entity = Object.hasOwn(entities, entityId) ? entities[entityId] : undefined
  const members = entity?.members ?? []
  if (members.length > 0) {
    const names = members.map((member) => labelFor(member)?.label).filter((name): name is string => Boolean(name))
    if (names.length === members.length) return list(names)
  }
  return labelFor(entityId)?.label ?? null
}

/**
 * The hint before a verb whose subject is implied: "[he = Jesus]", or
 * "[Jesus]" when the verb's form does not settle the pronoun. Null for a word
 * that is not an implied subject, and, with `namesOnly`, for a subject the
 * data does not name (an unnamed "woman").
 */
export function impliedSubjectHint(
  t: TFunction,
  isolate: (value: string) => string,
  options: {
    at: MentionAt
    word: BkpWord | undefined
    entities: Readonly<Record<BkpEntityId, BkpEntity>>
    name: string
    namesOnly: boolean
  },
): string | null {
  const { at, word, entities, name, namesOnly } = options
  if (at.mention.kind !== "subject") return null
  if (namesOnly && !isNamedEntity(at.mention.entity, entities)) return null
  const entity = Object.hasOwn(entities, at.mention.entity) ? entities[at.mention.entity] : undefined
  const pronoun = subjectPronoun(word, entity)
  return pronoun
    ? t("bibleData.whosWho.hint", { pronoun: t(SUBJECT_PRONOUN_KEYS[pronoun]), name: isolate(name) })
    : t("bibleData.whosWho.hintNameOnly", { name: isolate(name) })
}
