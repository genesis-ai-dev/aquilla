// Project facts (AQU-1691): the decision log.
//
// A project's answers to one-off questions — "Andrew is Peter's younger
// brother", how to render "the Twelve", whether "we" in ACT 16:10–17 includes
// the reader — kept as keyed entries in the `projectFacts` project setting,
// so an answer outlives the autopilot wave that asked for it. Autopilot loads
// them with the Language profile for every later draft
// (auth-worker/src/lib/contextual/project-context.ts).
//
// A key whose first segment names a Language-profile slot ("measures",
// "pronouns.firstPersonPlural") is NOT stored as an entry: it updates that
// slot (`applyProfileFact`), so the Language profile stays the one place a
// slot's value lives. Every other key is a free-form entry, one per key.
//
// Pure: no database, no DOM, relative imports only. Both workers and the SPA
// import it. The in-transaction writer is ./project-facts-write.ts.

import { isLanguageProfileSlot, languageProfileSlotProblem, type LanguageProfileSlot } from './language-profile'
import { isPlainObject } from './language-profile-slots'

/** Most entries a project keeps. Each answer replaces the entry for its key, so this bounds distinct keys. */
export const MAX_PROJECT_FACTS = 300
export const MAX_FACT_KEY_CHARS = 120
/** Same bound as a decision answer (DECISION_ANSWER_MAX_BYTES): the value IS that answer. */
export const MAX_FACT_VALUE_BYTES = 2000
export const MAX_FACT_NOTE_CHARS = 500
export const MAX_FACT_ENTITY_CHARS = 120

export interface FactPassage {
  /** First verse, e.g. "ACT 16:10". */
  from: string
  /** Last verse, in the same book, e.g. "ACT 16:17". */
  to: string
}

/** Where a fact applies. Empty means the whole project. */
export interface FactScope {
  /** USFM book code, e.g. "ACT". */
  book?: string
  passage?: FactPassage
  /** Who or what the fact is about, e.g. "Andrew". A label only: it does not narrow where the fact applies. */
  entity?: string
}

export interface ProjectFact {
  id: string
  /** Dotted key, e.g. "kin.andrew-peter.relative-age". One entry per key. */
  key: string
  value: string
  scope: FactScope
  note?: string
  /** Username of the person who decided it. */
  author: string
  /** When it was decided, as an ISO timestamp. */
  at: string
  /** The contextual decision this answered, when it came from a DecisionCard. */
  sourceDecisionId?: string
}

const FACT_KEY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/
const BOOK = /^[1-4]?[A-Z]{2,3}$/
/** A verse ref in a fact scope: "ACT 16:10". */
const SCOPE_VERSE = /^([1-4]?[A-Z]{2,3}) (\d{1,3}):(\d{1,3})$/
/** A cell's canonical ref: "MRK 1:2", "MRK 1:1-2", "JHN 4:7a", or a chapter heading "JHN 4". */
const CELL_REF = /^([1-4]?[A-Z]{2,3})\s+(\d{1,3})(?::(\d{1,3})[a-z]?(?:-(\d{1,3})[a-z]?)?)?$/

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function charCount(value: string): number {
  return Array.from(value).length
}

// ── Keys and values ─────────────────────────────────────────────────────────

/** Null when `key` is a well-formed fact key, else what is wrong with it. */
export function factKeyProblem(key: unknown): string | null {
  if (typeof key !== 'string' || key === '') return 'a fact key must be non-empty text'
  if (charCount(key) > MAX_FACT_KEY_CHARS) return `a fact key must be at most ${MAX_FACT_KEY_CHARS} characters`
  if (!FACT_KEY.test(key)) {
    return `fact key "${key}" must be dot-separated words of letters, digits, "-" and "_"`
  }
  return null
}

/** The Language-profile slot a key updates ("pronouns.firstPersonPlural" → "pronouns"), or null for a free-form key. */
export function profileSlotOfFactKey(key: string): LanguageProfileSlot | null {
  const slot = key.split('.')[0]
  return isLanguageProfileSlot(slot) ? slot : null
}

/**
 * An answer as a JSON value when it parses as JSON ("true", "[\"ne\"]",
 * "{\"clusivity\":true}"), else as the text itself ("the LORD", "convert").
 */
export function parseFactValue(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Why an answer cannot become a fact. The SPA renders each through t(). */
export type FactAnswerRejection =
  | 'answer-empty'
  | 'answer-too-long'
  | 'profile-key-too-deep'
  | 'profile-slot-not-an-object'
  | 'profile-value-invalid'
  | 'too-many-facts'

export type ProfileFactResult =
  | { ok: true; slot: LanguageProfileSlot; profile: Record<string, unknown> }
  | { ok: false; reason: FactAnswerRejection; detail?: string }

/**
 * Apply an answer whose key names a Language-profile slot to the STORED
 * profile. The whole slot ("measures" = "convert") or one field of it
 * ("divineNames.yhwh" = "the LORD"). Merges over the stored object as it is,
 * so slots this version does not know survive, and validates only the slot it
 * changes: each slot validates on its own.
 */
export function applyProfileFact(storedProfile: unknown, key: string, rawValue: string): ProfileFactResult {
  const segments = key.split('.')
  const slot = profileSlotOfFactKey(key)
  if (!slot) return { ok: false, reason: 'profile-value-invalid', detail: `"${key}" names no Language-profile slot` }
  if (segments.length > 2) return { ok: false, reason: 'profile-key-too-deep' }
  const stored: Record<string, unknown> = isPlainObject(storedProfile) ? { ...storedProfile } : {}
  const value = parseFactValue(rawValue)
  let next: unknown = value
  if (segments.length === 2) {
    const base = stored[slot]
    if (base !== undefined && !isPlainObject(base)) return { ok: false, reason: 'profile-slot-not-an-object' }
    next = { ...(base ?? {}), [segments[1]]: value }
  }
  const problem = languageProfileSlotProblem(slot, next)
  if (problem) return { ok: false, reason: 'profile-value-invalid', detail: problem }
  return { ok: true, slot, profile: { ...stored, [slot]: next } }
}

/**
 * Null when `raw` can be stored under `key`, else why not. A profile key is
 * checked against the stored profile: a field ("kinTerms.notes") may be valid
 * only beside the fields the slot already holds.
 */
export function factAnswerProblem(key: string, raw: string, storedProfile: unknown): FactAnswerRejection | null {
  const value = raw.trim()
  if (!value) return 'answer-empty'
  if (byteLength(value) > MAX_FACT_VALUE_BYTES) return 'answer-too-long'
  if (!profileSlotOfFactKey(key)) return null
  const applied = applyProfileFact(storedProfile, key, value)
  return applied.ok ? null : applied.reason
}

// ── Scope ───────────────────────────────────────────────────────────────────

interface VersePoint {
  book: string
  chapter: number
  verse: number
}

function compareVerse(a: VersePoint, b: VersePoint): number {
  return a.chapter - b.chapter || a.verse - b.verse
}

function scopeVerse(ref: string): VersePoint | null {
  const match = SCOPE_VERSE.exec(ref)
  return match ? { book: match[1], chapter: Number(match[2]), verse: Number(match[3]) } : null
}

/** Null when `scope` is a valid fact scope, else what is wrong with it. */
export function factScopeProblem(scope: unknown): string | null {
  if (!isPlainObject(scope)) return 'a fact scope must be an object'
  for (const key of Object.keys(scope)) {
    if (key !== 'book' && key !== 'passage' && key !== 'entity') return `a fact scope has an unknown field "${key}"`
  }
  const { book, passage, entity } = scope
  if (book !== undefined && (typeof book !== 'string' || !BOOK.test(book))) {
    return 'scope.book must be a USFM book code such as "ACT"'
  }
  if (entity !== undefined && (typeof entity !== 'string' || !entity.trim() || charCount(entity) > MAX_FACT_ENTITY_CHARS)) {
    return `scope.entity must be text of 1 to ${MAX_FACT_ENTITY_CHARS} characters`
  }
  if (passage === undefined) return null
  if (!isPlainObject(passage) || Object.keys(passage).some((key) => key !== 'from' && key !== 'to')) {
    return 'scope.passage must be { from, to }'
  }
  const from = typeof passage.from === 'string' ? scopeVerse(passage.from) : null
  const to = typeof passage.to === 'string' ? scopeVerse(passage.to) : null
  if (!from || !to) return 'scope.passage.from and .to must be verse refs such as "ACT 16:10"'
  if (from.book !== to.book || compareVerse(from, to) > 0) {
    return 'scope.passage must run forwards within one book'
  }
  if (book !== undefined && book !== from.book) return 'scope.book and scope.passage name different books'
  return null
}

/** Every verse a span's cells cover, from their canonical refs. Refs that are not Bible refs are ignored. */
function spanPoints(refs: readonly (string | null | undefined)[]): VersePoint[] {
  const points: VersePoint[] = []
  for (const ref of refs) {
    const match = ref ? CELL_REF.exec(ref.trim()) : null
    if (!match) continue
    const [, book, chapter, first, last] = match
    const from = first === undefined ? 0 : Number(first)
    // A bridge ("MRK 1:1-2") covers each verse; a long one is clamped, not expanded without bound.
    const to = Math.min(last === undefined ? from : Number(last), from + 200)
    for (let verse = from; verse <= to; verse++) points.push({ book, chapter: Number(chapter), verse })
  }
  return points
}

function factApplies(fact: ProjectFact, points: readonly VersePoint[]): boolean {
  const { book, passage } = fact.scope
  if (passage) {
    const from = scopeVerse(passage.from)
    const to = scopeVerse(passage.to)
    if (!from || !to) return false
    return points.some((p) => p.book === from.book && compareVerse(p, from) >= 0 && compareVerse(p, to) <= 0)
  }
  if (book) return points.some((p) => p.book === book)
  return true
}

/** 0 for a passage, 1 for a book, 2 for the whole project: the most specific fact wins a clipped prompt. */
function specificity(fact: ProjectFact): number {
  return fact.scope.passage ? 0 : fact.scope.book ? 1 : 2
}

/**
 * The facts that apply to a span, given its cells' canonical refs: project-wide
 * facts, facts for a book the span is in, and facts for a passage the span
 * touches. Most specific first, then newest first. A span with no Bible refs
 * (a prose file) gets the project-wide facts only.
 */
export function factsInScope(
  facts: readonly ProjectFact[],
  refs: readonly (string | null | undefined)[],
): ProjectFact[] {
  const points = spanPoints(refs)
  return facts
    .filter((fact) => factApplies(fact, points))
    .sort((a, b) => specificity(a) - specificity(b) || b.at.localeCompare(a.at))
}

// ── The `projectFacts` setting ──────────────────────────────────────────────

/** Null when `fact` is a valid stored fact, else what is wrong with it. */
export function projectFactProblem(fact: unknown, index = 0): string | null {
  const path = `projectFacts[${index}]`
  if (!isPlainObject(fact)) return `${path} must be an object`
  const allowed = ['id', 'key', 'value', 'scope', 'note', 'author', 'at', 'sourceDecisionId']
  for (const key of Object.keys(fact)) {
    if (!allowed.includes(key)) return `${path} has an unknown field "${key}"`
  }
  if (typeof fact.id !== 'string' || !fact.id || fact.id.length > 80) return `${path}.id must be text of 1 to 80 characters`
  const keyProblem = factKeyProblem(fact.key)
  if (keyProblem) return `${path}: ${keyProblem}`
  if (profileSlotOfFactKey(fact.key as string)) {
    return `${path}.key "${String(fact.key)}" names a Language-profile slot; write it in languageProfile instead`
  }
  if (typeof fact.value !== 'string' || !fact.value.trim() || byteLength(fact.value) > MAX_FACT_VALUE_BYTES) {
    return `${path}.value must be text of 1 to ${MAX_FACT_VALUE_BYTES} bytes`
  }
  const scopeProblem = factScopeProblem(fact.scope)
  if (scopeProblem) return `${path}: ${scopeProblem}`
  if (fact.note !== undefined && (typeof fact.note !== 'string' || charCount(fact.note) > MAX_FACT_NOTE_CHARS)) {
    return `${path}.note must be text of at most ${MAX_FACT_NOTE_CHARS} characters`
  }
  if (typeof fact.author !== 'string' || !fact.author.trim() || fact.author.length > 120) {
    return `${path}.author must be a username`
  }
  if (typeof fact.at !== 'string' || Number.isNaN(Date.parse(fact.at))) return `${path}.at must be an ISO timestamp`
  if (fact.sourceDecisionId !== undefined && (typeof fact.sourceDecisionId !== 'string' || !fact.sourceDecisionId)) {
    return `${path}.sourceDecisionId must be text`
  }
  return null
}

/** Validator for the `projectFacts` settings key (agent writes through PatchSettings). */
export function projectFactsProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return 'projectFacts must be a list'
  if (value.length > MAX_PROJECT_FACTS) return `projectFacts holds at most ${MAX_PROJECT_FACTS} facts`
  const keys = new Set<string>()
  for (const [index, fact] of value.entries()) {
    const problem = projectFactProblem(fact, index)
    if (problem) return problem
    const key = (fact as ProjectFact).key
    if (keys.has(key)) return `projectFacts has two facts for "${key}"`
    keys.add(key)
  }
  return null
}

export const PROJECT_FACTS_TYPE_NAME =
  '{ id: string, key: string, value: string, scope: { book?: string, passage?: { from: string, to: string }, ' +
  'entity?: string }, note?: string, author: string, at: string, sourceDecisionId?: string }[]'

/**
 * Read a stored `projectFacts` value (parsed JSON). Keeps each valid fact and
 * drops a damaged one, and keeps the newest fact for a key that appears twice.
 */
export function readProjectFacts(raw: unknown): ProjectFact[] {
  if (!Array.isArray(raw)) return []
  const byKey = new Map<string, ProjectFact>()
  raw.forEach((item, index) => {
    if (projectFactProblem(item, index) !== null) return
    const fact = JSON.parse(JSON.stringify(item)) as ProjectFact
    const held = byKey.get(fact.key)
    if (!held || held.at < fact.at) byKey.set(fact.key, fact)
  })
  return [...byKey.values()]
}

// The writers below work on the STORED list as it is, not on what
// readProjectFacts keeps: an entry this version cannot read is left alone
// rather than deleted by an unrelated save.

function storedList(stored: unknown): unknown[] {
  return Array.isArray(stored) ? stored : []
}

function heldKey(item: unknown): unknown {
  return isPlainObject(item) ? item.key : undefined
}

export type UpsertFactResult = { ok: true; facts: unknown[] } | { ok: false; reason: 'too-many-facts' }

/** Replace the entry for `fact.key`, or add it. A new key past MAX_PROJECT_FACTS is refused. */
export function upsertProjectFact(stored: unknown, fact: ProjectFact): UpsertFactResult {
  const held = storedList(stored)
  if (held.some((item) => heldKey(item) === fact.key)) {
    return { ok: true, facts: held.map((item) => (heldKey(item) === fact.key ? fact : item)) }
  }
  if (held.length >= MAX_PROJECT_FACTS) return { ok: false, reason: 'too-many-facts' }
  return { ok: true, facts: [...held, fact] }
}

/** The stored list without the entry whose id is `id`. */
export function removeProjectFact(stored: unknown, id: string): unknown[] {
  return storedList(stored).filter((item) => !(isPlainObject(item) && item.id === id))
}

/**
 * Every fact key a project has decided: its entries' keys, each filled
 * Language-profile slot, and each field of a filled object slot
 * ("pronouns.firstPersonPlural"). A question for one of these is already answered.
 */
export function decidedFactKeys(facts: readonly ProjectFact[], storedProfile: unknown): Set<string> {
  const keys = new Set(facts.map((fact) => fact.key))
  if (!isPlainObject(storedProfile)) return keys
  for (const [slot, value] of Object.entries(storedProfile)) {
    if (!isLanguageProfileSlot(slot) || value === undefined || languageProfileSlotProblem(slot, value)) continue
    keys.add(slot)
    if (isPlainObject(value)) for (const field of Object.keys(value)) keys.add(`${slot}.${field}`)
  }
  return keys
}
