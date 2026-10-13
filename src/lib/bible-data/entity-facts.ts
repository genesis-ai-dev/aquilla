// Who's Who, facts about one participant (AQU-1689).
//
// What kind of thing an entity is, the gender and number a translator needs
// for pronouns, whether the pack names it, and the pronoun an implied subject
// stands for. Pure. Every answer is a reason-code style value; the UI turns
// them into words through typed tables (src/components/bible-data/people-text.ts).
//
// Spec: aquilla-specs 05-user-stories/follow-a-participant-thread.md;
// design doc §6 and the pack contract (bible-wiki pipeline/src/bkp/README.md,
// "people").

import type { BkpEntity, BkpEntityId, BkpWord } from "./pack-types"

/**
 * How the cast treats an entity:
 *   participant — a person, a deity or a group: who a passage is about;
 *   place       — a place, which the Places enrichment covers;
 *   other       — anything else: pack slice 2's `local-thing`, or a type this
 *                 build does not know yet. Listed apart and never flagged.
 */
export type EntityRole = "participant" | "place" | "other"

const ROLE_BY_TYPE: Readonly<Record<string, EntityRole>> = {
  person: "participant",
  deity: "participant",
  group: "participant",
  "local-person": "participant",
  "local-group": "participant",
  place: "place",
}

/** The entity's role. An unknown type (a newer pack) is `other`, never an error. */
export function entityRole(entity: BkpEntity | undefined): EntityRole {
  // A newer pack may send a type this build's union does not list.
  const type: string | undefined = entity?.type
  return type !== undefined && Object.hasOwn(ROLE_BY_TYPE, type) ? ROLE_BY_TYPE[type] : "other"
}

/**
 * Gender as the pack gives it: `male`/`female` from ACAI (people), or the
 * anchor word's grammatical gender for an unnamed participant.
 */
export type EntityGender = "male" | "female" | "masculine" | "feminine" | "neuter"
const GENDERS: readonly EntityGender[] = ["male", "female", "masculine", "feminine", "neuter"]

export function entityGender(entity: BkpEntity | undefined): EntityGender | null {
  const gender = entity?.gender
  return gender !== undefined && (GENDERS as readonly string[]).includes(gender) ? (gender as EntityGender) : null
}

/** Male and masculine agree, as do female and feminine, for pronoun choice. */
export type GenderClass = "m" | "f" | "n"

export function genderClass(gender: EntityGender | null): GenderClass | null {
  switch (gender) {
    case "male":
    case "masculine":
      return "m"
    case "female":
    case "feminine":
      return "f"
    case "neuter":
      return "n"
    default:
      return null
  }
}

export type EntityNumber = "singular" | "plural"

/** Groups are plural; people and deities singular. Places and unknown types have none. */
export function entityNumber(entity: BkpEntity | undefined): EntityNumber | null {
  const type: string | undefined = entity?.type
  if (type === "group" || type === "local-group") return "plural"
  if (type === "person" || type === "local-person" || type === "deity") return "singular"
  return null
}

/** A group's members, in the pack's order. Never the group itself, and never collapsed. */
export function entityMembers(entity: BkpEntity | undefined): readonly BkpEntityId[] {
  return entity?.members ?? []
}

/**
 * The pack names it: an ACAI entity, or a group whose members all are. An
 * unnamed participant ("woman", "Sir") is not named, whatever its label.
 */
export function isNamedEntity(
  entityId: BkpEntityId,
  entities: Readonly<Record<BkpEntityId, BkpEntity>>,
  seen: ReadonlySet<BkpEntityId> = new Set(),
): boolean {
  const entity = Object.hasOwn(entities, entityId) ? entities[entityId] : undefined
  if (!entity) return false
  if (entity.acai) return true
  const members = entityMembers(entity)
  if (members.length === 0 || seen.has(entityId)) return false
  const inside = new Set(seen).add(entityId)
  return members.every((member) => isNamedEntity(member, entities, inside))
}

/**
 * The pronoun an implied subject stands for, from the verb's person and number
 * and the entity's gender: "[he = Jesus]", "[you = Samaritan woman]".
 * Null when the verb carries no person (a participle or an infinitive) or a
 * third-person singular entity has no known gender: the hint then shows the
 * name alone, rather than a guessed pronoun.
 */
export type SubjectPronoun =
  | "first-singular"
  | "first-plural"
  | "second-singular"
  | "second-plural"
  | "third-singular-masculine"
  | "third-singular-feminine"
  | "third-singular-neuter"
  | "third-plural"

export function subjectPronoun(word: BkpWord | undefined, entity: BkpEntity | undefined): SubjectPronoun | null {
  const person = word?.person
  if (person !== "first" && person !== "second" && person !== "third") return null
  const number = word?.number === "singular" || word?.number === "plural" ? word.number : entityNumber(entity)
  if (number === null) return null
  if (person === "first") return number === "singular" ? "first-singular" : "first-plural"
  if (person === "second") return number === "singular" ? "second-singular" : "second-plural"
  if (number === "plural") return "third-plural"
  switch (genderClass(entityGender(entity))) {
    case "m":
      return "third-singular-masculine"
    case "f":
      return "third-singular-feminine"
    case "n":
      return "third-singular-neuter"
    default:
      return null
  }
}
