// What the Language profile card edits, slot by slot (AQU-1691).
//
// Each row of the card edits a DRAFT: plain strings and choices, the way a
// person types them ("ne, pas", "12 = twelve"). These functions turn a stored
// slot into a draft and a draft back into the value to store. The card checks
// that value with languageProfileSlotProblem before it saves, so a draft that
// cannot become a valid slot is reported, never stored half-right.
//
// Pure: no React, no network.

import type {
  DivineNamesProfile,
  KinTermsProfile,
  NumberWordsProfile,
  PronounsProfile,
  QuestionMarkersProfile,
} from "../../../db/shared/language-profile"

/** A yes/no question that may not be answered yet. */
export type TriState = "unset" | "yes" | "no"

/** Split a typed list on commas (including Arabic ، and ideographic 、), semicolons and new lines. */
export function splitList(text: string): string[] {
  const items = text.split(/[,،、;\n]/u).map((item) => item.trim()).filter((item) => item !== "")
  return [...new Set(items)]
}

export function joinList(items: readonly string[] | undefined): string {
  return (items ?? []).join(", ")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined
}

function tri(value: unknown): TriState {
  return value === true ? "yes" : value === false ? "no" : "unset"
}

function triValue(state: TriState): boolean | undefined {
  return state === "unset" ? undefined : state === "yes"
}

/** `{ key: list }` for each list that has entries, so an empty field stores nothing. */
function lists(entries: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, text] of Object.entries(entries)) {
    const items = splitList(text)
    if (items.length > 0) out[key] = items
  }
  return out
}

// ── Question markers ────────────────────────────────────────────────────────

export interface QuestionMarkersDraft {
  particles: string
  suffix: string
}

export function questionMarkersDraft(stored: unknown): QuestionMarkersDraft {
  const value = isRecord(stored) ? stored : {}
  return { particles: joinList(strings(value.particles)), suffix: joinList(strings(value.suffix)) }
}

/** Both fields empty is a real answer: questions are marked with a question mark only. */
export function questionMarkersValue(draft: QuestionMarkersDraft): QuestionMarkersProfile {
  return lists({ particles: draft.particles, suffix: draft.suffix })
}

// ── Pronouns ────────────────────────────────────────────────────────────────

export interface PronounsDraft {
  secondPerson: TriState
  singular: string
  plural: string
  firstPersonPlural: TriState
  inclusive: string
  exclusive: string
  dual: boolean
  trial: boolean
  paucal: boolean
  dualForms: string
  trialForms: string
  paucalForms: string
  thirdPerson: TriState
  thirdPersonForms: string
  /** One level per line, "name: forms". */
  honorifics: string
}

export function pronounsDraft(stored: unknown): PronounsDraft {
  const value = isRecord(stored) ? stored : {}
  const part = (key: string) => (isRecord(value[key]) ? value[key] : {})
  const second = part("secondPerson")
  const first = part("firstPersonPlural")
  const extra = part("extraNumbers")
  const third = part("thirdPerson")
  const levels = Array.isArray(part("honorifics").levels) ? (part("honorifics").levels as unknown[]) : []
  return {
    secondPerson: tri(second.numberDistinction),
    singular: joinList(strings(second.singular)),
    plural: joinList(strings(second.plural)),
    firstPersonPlural: tri(first.clusivity),
    inclusive: joinList(strings(first.inclusive)),
    exclusive: joinList(strings(first.exclusive)),
    dual: extra.dual === true,
    trial: extra.trial === true,
    paucal: extra.paucal === true,
    dualForms: joinList(strings(extra.dualForms)),
    trialForms: joinList(strings(extra.trialForms)),
    paucalForms: joinList(strings(extra.paucalForms)),
    thirdPerson: tri(third.genderOrClass),
    thirdPersonForms: joinList(strings(third.forms)),
    honorifics: levels
      .filter(isRecord)
      .map((level) => {
        const forms = joinList(strings(level.forms))
        return forms ? `${String(level.name)}: ${forms}` : String(level.name)
      })
      .join("\n"),
  }
}

/** The pronoun inventory to store. A question left "not set" stores nothing for its part. */
export function pronounsValue(draft: PronounsDraft): PronounsProfile {
  const out: PronounsProfile = {}
  const second = triValue(draft.secondPerson)
  if (second !== undefined) {
    out.secondPerson = { numberDistinction: second, ...(second ? lists({ singular: draft.singular, plural: draft.plural }) : {}) }
  }
  const first = triValue(draft.firstPersonPlural)
  if (first !== undefined) {
    out.firstPersonPlural = {
      clusivity: first,
      ...(first ? lists({ inclusive: draft.inclusive, exclusive: draft.exclusive }) : {}),
    }
  }
  if (draft.dual || draft.trial || draft.paucal) {
    out.extraNumbers = {
      ...(draft.dual ? { dual: true } : {}),
      ...(draft.trial ? { trial: true } : {}),
      ...(draft.paucal ? { paucal: true } : {}),
      ...lists({
        ...(draft.dual ? { dualForms: draft.dualForms } : {}),
        ...(draft.trial ? { trialForms: draft.trialForms } : {}),
        ...(draft.paucal ? { paucalForms: draft.paucalForms } : {}),
      }),
    }
  }
  const third = triValue(draft.thirdPerson)
  if (third !== undefined) {
    out.thirdPerson = { genderOrClass: third, ...(third ? lists({ forms: draft.thirdPersonForms }) : {}) }
  }
  const levels = draft.honorifics
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const colon = line.indexOf(":")
      const name = (colon === -1 ? line : line.slice(0, colon)).trim()
      const forms = colon === -1 ? [] : splitList(line.slice(colon + 1))
      return forms.length > 0 ? { name, forms } : { name }
    })
  if (levels.length > 0) out.honorifics = { levels }
  return out
}

// ── Number words ────────────────────────────────────────────────────────────

export interface NumberWordsDraft {
  mode: "unset" | "cldr" | "explicit"
  /** One "number = word" pair per line. */
  words: string
}

export function numberWordsDraft(stored: unknown): NumberWordsDraft {
  if (stored === "cldr") return { mode: "cldr", words: "" }
  if (!isRecord(stored)) return { mode: "unset", words: "" }
  return {
    mode: "explicit",
    words: Object.entries(stored)
      .map(([number, word]) => `${number} = ${String(word)}`)
      .join("\n"),
  }
}

/** Null when there is nothing to store yet. A malformed line stays in the map and fails validation. */
export function numberWordsValue(draft: NumberWordsDraft): NumberWordsProfile | null {
  if (draft.mode === "unset") return null
  if (draft.mode === "cldr") return "cldr"
  const map: Record<string, string> = {}
  for (const line of draft.words.split("\n")) {
    if (!line.trim()) continue
    const equals = line.indexOf("=")
    const number = (equals === -1 ? line : line.slice(0, equals)).trim()
    map[number] = equals === -1 ? "" : line.slice(equals + 1).trim()
  }
  return map
}

// ── Kin terms ───────────────────────────────────────────────────────────────

export interface KinTermsDraft {
  relativeAge: TriState
  notes: string
}

export function kinTermsDraft(stored: unknown): KinTermsDraft {
  const value = isRecord(stored) ? stored : {}
  return { relativeAge: tri(value.relativeAgeDistinction), notes: typeof value.notes === "string" ? value.notes : "" }
}

/** Null until the yes/no question is answered: it is the slot's one required field. */
export function kinTermsValue(draft: KinTermsDraft): KinTermsProfile | null {
  const relativeAgeDistinction = triValue(draft.relativeAge)
  if (relativeAgeDistinction === undefined) return null
  const notes = draft.notes.trim()
  return { relativeAgeDistinction, ...(notes ? { notes } : {}) }
}

// ── Divine names ────────────────────────────────────────────────────────────

export interface DivineNamesDraft {
  yhwh: string
  kyriosGod: string
  kyriosJesus: string
  capitalization: TriState
}

export function divineNamesDraft(stored: unknown): DivineNamesDraft {
  const value = isRecord(stored) ? stored : {}
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : "")
  return {
    yhwh: text("yhwh"),
    kyriosGod: text("kyriosGod"),
    kyriosJesus: text("kyriosJesus"),
    capitalization: tri(value.deityPronounCapitalization),
  }
}

export function divineNamesValue(draft: DivineNamesDraft): DivineNamesProfile {
  const out: DivineNamesProfile = {}
  for (const key of ["yhwh", "kyriosGod", "kyriosJesus"] as const) {
    const value = draft[key].trim()
    if (value) out[key] = value
  }
  const capitalization = triValue(draft.capitalization)
  if (capitalization !== undefined) out.deityPronounCapitalization = capitalization
  return out
}
