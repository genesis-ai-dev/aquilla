// Agreed names (AQU-1699): how the project renders each person, group, place
// and deity the pack knows, for the participant checks (P1–P6, P14, X4).
//
// In order of precedence:
//   1. a decision (project fact) keyed `render.<entity>`: the entity id with
//      ":" written as ".", because a fact key is dotted words of letters,
//      digits, "-" and "_" (../project-facts.ts). person:Jesus.2 is
//      `render.person.Jesus.2`. The value is the rendering; "|" separates
//      aliases ("Peter|Simon Peter"). A decision applies only in its scope.
//   2. an active terminology entry whose source term is the entity's pack label
//      in the project's SOURCE language (labels are keyed by ISO 639-3); a
//      Greek-source project matches the Greek name itself. Preferred renderings
//      first, then admitted; a forbidden one is only a known variant (P2). In a
//      project with several target lanes the termbase does not say which lane a
//      rendering is for, so an entry counts only when it has one rendering.
//   3. an entry linked to the entity by `externalIds.acai` (AQU-1693 fills it).
// An entity with none of these has no agreed name, and its name checks stay
// dormant.
//
// Name-form decisions (P4) are `render.<entity>.form.<form>`, the form being
// the lemma in Latin letters (./name-forms.ts): `render.person.Peter.form.kephas`.
// κύριος and πνεῦμα (P14) are `render.kyrios-jesus`, `render.kyrios-god` and
// `render.holy-spirit`; clusivity decisions (X4) are `clusivity.*`.
//
// Pure. Relative imports only, no DOM: shared with the workers.

import { factsInScope, type ProjectFact } from '../project-facts'
import type {
  AgreedName,
  BibleCheckReadiness,
  ConceptInput,
  DivineNameKind,
  NameTable,
  PeopleLayerInput,
  ScopedName,
} from './participant-types'
import type { TextLayerInput, TextWordInput } from './types'

export interface AgreedNameInputs {
  people: PeopleLayerInput
  /** Which mentions are names, and each name's lemma (homonyms, Greek-source labels, name forms). */
  text?: TextLayerInput | null
  facts?: readonly ProjectFact[]
  concepts?: readonly ConceptInput[]
  /** The project's source language: "en", "eng", "es-419", "grc". Missing reads as English. */
  sourceLanguage?: string | null
  /** The project has more than one target lane. */
  multiLane?: boolean
}

export const DIVINE_NAME_FACT_KEYS: Readonly<Record<DivineNameKind, string>> = {
  'kyrios-jesus': 'render.kyrios-jesus',
  'kyrios-god': 'render.kyrios-god',
  'holy-spirit': 'render.holy-spirit',
}

/** The decision key for an entity's name: "person:Jesus.2" → "render.person.Jesus.2". */
export function entityNameFactKey(entityId: string): string {
  return `render.${entityId.replace(/:/g, '.')}`
}

/** The decision key for one form of an entity's name: "render.person.Peter.form.kephas". */
export function nameFormFactKey(entityId: string, form: string): string {
  return `${entityNameFactKey(entityId)}.form.${form}`
}

/** A decision's renderings: its value split at "|". */
export function factRenderings(value: string): string[] {
  return dedupe(value.split('|').map((part) => part.trim()))
}

function dedupe(values: readonly string[]): string[] {
  const out: string[] = []
  for (const value of values) if (value && !out.includes(value)) out.push(value)
  return out
}

// ── Source language → pack label key ───────────────────────────────────────

/** The pack labels its entities in these languages (ISO 639-3), plus Greek through the names themselves. */
const LABEL_LANGUAGE: Readonly<Record<string, string>> = {
  en: 'eng', eng: 'eng', english: 'eng',
  ar: 'arb', ara: 'arb', arb: 'arb', arabic: 'arb',
  zh: 'cmn', zho: 'cmn', chi: 'cmn', cmn: 'cmn', chinese: 'cmn',
  fr: 'fra', fra: 'fra', fre: 'fra', french: 'fra',
  ha: 'hau', hau: 'hau', hausa: 'hau',
  hi: 'hin', hin: 'hin', hindi: 'hin',
  id: 'ind', ind: 'ind', indonesian: 'ind',
  pt: 'por', por: 'por', portuguese: 'por',
  ru: 'rus', rus: 'rus', russian: 'rus',
  es: 'spa', spa: 'spa', spanish: 'spa',
  sw: 'swh', swa: 'swh', swh: 'swh', swahili: 'swh',
  tpi: 'tpi', 'tok pisin': 'tpi',
  grc: 'grc',
}

/** The pack label key for a source language code; null when the pack has no labels in it. */
export function packLabelLanguage(code: string | null | undefined): string | null {
  const value = (code ?? '').trim().toLowerCase()
  if (!value) return 'eng'
  return LABEL_LANGUAGE[value] ?? LABEL_LANGUAGE[value.split(/[-_]/)[0]] ?? null
}

// ── Names in the source ─────────────────────────────────────────────────────

/** A proper noun: Macula type "proper", or a capitalised lemma (Ἰουδαῖος, Χριστός). θεός and κύριος are not. */
export function isNameWord(word: TextWordInput | undefined): word is TextWordInput & { lemma: string } {
  if (!word?.lemma) return false
  return word.type === 'proper' || /^\p{Lu}/u.test(word.lemma)
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** Each entity's name lemmas, from its explicit mentions that are proper nouns. */
function nameLemmas(people: PeopleLayerInput, text: TextLayerInput | null | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (!text) return out
  for (const [wordId, mention] of Object.entries(people.mentions)) {
    if (mention.kind !== 'explicit') continue
    const word = own(text.words, wordId)
    if (!isNameWord(word)) continue
    const set = out.get(mention.entity) ?? new Set<string>()
    set.add(word.lemma)
    out.set(mention.entity, set)
  }
  return out
}

/** ACAI's own entities. The pack's local ones are labelled with glosses ("disciples", "water"), not names. */
const ACAI_TYPES: ReadonlySet<string> = new Set(['person', 'group', 'deity', 'place'])

/** A local entity the pack minted for a person or a group: its label can be a name ("Abraham"). */
const LOCAL_BEING_TYPES: ReadonlySet<string> = new Set(['local-person', 'local-group'])

/**
 * Namesakes: entities that share a name lemma in this book (Μαρία names six
 * women; Γαλιλαία is Galilee and the Sea of Galilee), or the same bare label
 * ("Mary (Mother of Jesus)", "Mary (of Bethany)"), which links them in a book
 * that never names one of them. A person's label also counts by its first word
 * ("Mary Magdalene", "Herod Antipas").
 */
function homonyms(people: PeopleLayerInput, lemmas: Map<string, Set<string>>, language: string | null): Map<string, string[]> {
  const byKey = new Map<string, Set<string>>()
  const add = (key: string, entity: string) => byKey.set(key, (byKey.get(key) ?? new Set()).add(entity))
  for (const [entity, set] of lemmas) for (const lemma of set) add(`lemma:${lemma}`, entity)
  for (const [entity, record] of Object.entries(people.entities)) {
    if (!ACAI_TYPES.has(record.type) && !LOCAL_BEING_TYPES.has(record.type)) continue
    for (const key of new Set(['eng', language ?? 'eng'])) {
      const label = own(record.labels, key)
      if (!label) continue
      const bare = termKey(bareLabel(label))
      add(`label:${bare}`, entity)
      const first = bare.split(' ')[0]
      if (record.type === 'person' && first !== bare) add(`label:${first}`, entity)
    }
  }
  const out = new Map<string, string[]>()
  for (const entities of byKey.values()) {
    if (entities.size < 2) continue
    for (const entity of entities) {
      const siblings = out.get(entity) ?? []
      for (const other of entities) if (other !== entity && !siblings.includes(other)) siblings.push(other)
      out.set(entity, siblings)
    }
  }
  return out
}

// ── Terminology ─────────────────────────────────────────────────────────────

function termKey(value: string): string {
  return value.normalize('NFC').trim().toLowerCase().replace(/\s+/gu, ' ')
}

/** "Mary (Mother of Jesus)" → "Mary": ACAI tells homonyms apart in brackets. */
function bareLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/u, '').trim()
}

function conceptName(entity: string, concept: ConceptInput, source: 'terminology' | 'acai', multiLane: boolean): ScopedName | null {
  const ranked = [
    ...concept.renderings.filter((r) => r.status === 'preferred'),
    ...concept.renderings.filter((r) => r.status === 'admitted'),
  ]
  const renderings = dedupe(ranked.map((r) => r.rendering.trim()))
  if (renderings.length === 0) return null
  // Several target lanes: which lane a rendering is for is unknown unless there is only one.
  if (multiLane && renderings.length > 1) return null
  return {
    entity,
    renderings,
    variants: dedupe([...renderings, ...concept.renderings.map((r) => r.rendering.trim())]),
    source,
    from: concept.id,
  }
}

// ── The table ───────────────────────────────────────────────────────────────

function factName(entity: string, fact: ProjectFact, also: readonly string[]): ScopedName | null {
  const renderings = factRenderings(fact.value)
  if (renderings.length === 0) return null
  return { entity, renderings, variants: dedupe([...renderings, ...also]), source: 'fact', from: fact.key, fact }
}

const CLUSIVITY_VALUES = new Set(['inclusive', 'exclusive'])

/** A `clusivity.*` decision the checks can enforce: its value says inclusive or exclusive. */
export function isClusivityDecision(fact: ProjectFact): boolean {
  return fact.key.startsWith('clusivity.') && CLUSIVITY_VALUES.has(fact.value.trim().toLowerCase())
}

const tables = new WeakMap<AgreedNameInputs, NameTable>()

/** Every agreed name, name-form decision and clusivity decision for one book. Cached per inputs object. */
export function buildNameTable(inputs: AgreedNameInputs): NameTable {
  const cached = tables.get(inputs)
  if (cached) return cached
  const { people } = inputs
  const facts = inputs.facts ?? []
  const factByKey = new Map(facts.map((fact) => [fact.key, fact]))
  const lemmas = nameLemmas(people, inputs.text)
  const language = packLabelLanguage(inputs.sourceLanguage)
  const multiLane = inputs.multiLane === true

  const byTerm = new Map<string, ConceptInput>()
  const byAcai = new Map<string, ConceptInput>()
  for (const concept of inputs.concepts ?? []) {
    if (concept.status !== 'active') continue
    const key = termKey(concept.sourceTerm)
    if (key && !byTerm.has(key)) byTerm.set(key, concept)
    const acai = concept.externalIds?.acai
    if (acai && !byAcai.has(acai)) byAcai.set(acai, concept)
  }

  const names = new Map<string, ScopedName[]>()
  const forms = new Map<string, Map<string, ScopedName[]>>()
  for (const [entity, record] of Object.entries(people.entities)) {
    // Terminology names ACAI's people, groups, places and deities; a local entity's label is a gloss.
    const named = ACAI_TYPES.has(record.type)
    const labels = !named
      ? []
      : language === 'grc'
        ? [...(lemmas.get(entity) ?? [])]
        : language && own(record.labels, language)
          ? [own(record.labels, language) ?? '', bareLabel(own(record.labels, language) ?? '')]
          : []
    const concept = labels.map((label) => byTerm.get(termKey(label))).find(Boolean)
    const terminology = concept ? conceptName(entity, concept, 'terminology', multiLane) : null
    const linked = named ? byAcai.get(entity) : undefined
    const acai = linked ? conceptName(entity, linked, 'acai', multiLane) : null
    const fact = factByKey.get(entityNameFactKey(entity))
    const decided = fact ? factName(entity, fact, [...(terminology?.variants ?? []), ...(acai?.variants ?? [])]) : null
    const list = [decided, terminology, acai].filter((name): name is ScopedName => name !== null)
    if (list.length > 0) names.set(entity, list)

    const prefix = `${entityNameFactKey(entity)}.form.`
    for (const candidate of facts) {
      if (!candidate.key.startsWith(prefix)) continue
      const form = candidate.key.slice(prefix.length)
      const name = /^[a-z0-9]+$/.test(form) ? factName(entity, candidate, []) : null
      if (!name) continue
      const byForm = forms.get(entity) ?? new Map<string, ScopedName[]>()
      byForm.set(form, [name])
      forms.set(entity, byForm)
    }
  }

  const divine = new Map<DivineNameKind, ScopedName>()
  for (const [kind, key] of Object.entries(DIVINE_NAME_FACT_KEYS) as [DivineNameKind, string][]) {
    const fact = factByKey.get(key)
    const name = fact ? factName(kind, fact, []) : null
    if (name) divine.set(kind, name)
  }

  const clusivity = facts.filter(isClusivityDecision)
  const table: NameTable = {
    names,
    forms,
    siblings: homonyms(people, lemmas, language),
    divine,
    clusivity,
    entities: people.entities,
    readiness: {
      agreedNames: names.size > 0,
      // P4 needs a distinct rendering per form, so two forms of one name.
      nameForms: [...forms.values()].some((byForm) => byForm.size >= 2),
      divineNameFacts: divine.size > 0,
      clusivityFacts: clusivity.length > 0,
      pronounSpans: false,
    },
  }
  tables.set(inputs, table)
  return table
}

// ── Resolving for one cell ──────────────────────────────────────────────────

/** The first name in `list` that applies in `refs`: a decision only in its scope, terminology everywhere. */
export function firstInScope(list: readonly ScopedName[] | undefined, refs: readonly string[] | undefined): ScopedName | null {
  for (const name of list ?? []) {
    if (!name.fact || !refs || factsInScope([name.fact], refs).length > 0) return name
  }
  return null
}

/**
 * The agreed name of `entityId` where `refs` are (every verse, when omitted),
 * or null when the project has none. Pure: the table is a cache of `inputs`.
 */
export function agreedRenderings(
  entityId: string,
  inputs: AgreedNameInputs,
  refs?: readonly string[],
): AgreedName | null {
  const name = firstInScope(buildNameTable(inputs).names.get(entityId), refs)
  if (!name) return null
  return { entity: name.entity, renderings: name.renderings, variants: name.variants, source: name.source, from: name.from }
}

/** The name-form decisions for `entity` that apply in `refs`, by form key. */
export function formsInScope(table: NameTable, entity: string, refs: readonly string[]): Map<string, ScopedName> {
  const out = new Map<string, ScopedName>()
  for (const [form, list] of table.forms.get(entity) ?? []) {
    const name = firstInScope(list, refs)
    if (name) out.set(form, name)
  }
  return out
}

/** What counts as the entity's name in `refs`: its agreed renderings and every form's. */
export function acceptedRenderings(table: NameTable, entity: string, refs: readonly string[]): string[] {
  const name = firstInScope(table.names.get(entity), refs)
  const formNames = [...formsInScope(table, entity, refs).values()]
  return dedupe([...(name?.renderings ?? []), ...formNames.flatMap((form) => form.renderings)])
}

/** The clusivity decision that applies in `refs`, most specific first (X4). */
export function clusivityDecisionFor(table: NameTable, refs: readonly string[]): ProjectFact | null {
  return factsInScope(table.clusivity, refs)[0] ?? null
}

/** The entity's label for a finding: English, else any, else its id. Data, never translated. */
export function entityLabel(table: NameTable, entity: string): string {
  const labels = own(table.entities, entity)?.labels
  return (labels && (own(labels, 'eng') ?? Object.values(labels)[0])) || entity
}

/**
 * What a project's decisions and terminology switch on, without the pack:
 * the Rules list says which check still waits for what. Coarser than the
 * table's own readiness (any active terminology entry may name someone).
 */
export function readinessFromDecisions(
  facts: readonly ProjectFact[],
  concepts: readonly Pick<ConceptInput, 'status'>[],
): BibleCheckReadiness {
  const entityKey = /^render\.(?:person|group|deity|place|local|grp)\..+$/
  const formsPerName = new Map<string, number>()
  for (const fact of facts) {
    const match = /^(render\..+)\.form\.[a-z0-9]+$/.exec(fact.key)
    if (match) formsPerName.set(match[1], (formsPerName.get(match[1]) ?? 0) + 1)
  }
  const divineKeys = new Set(Object.values(DIVINE_NAME_FACT_KEYS))
  return {
    agreedNames:
      facts.some((fact) => entityKey.test(fact.key) && !fact.key.includes('.form.')) ||
      concepts.some((concept) => concept.status === 'active'),
    nameForms: [...formsPerName.values()].some((count) => count >= 2),
    divineNameFacts: facts.some((fact) => divineKeys.has(fact.key)),
    clusivityFacts: facts.some(isClusivityDecision),
    pronounSpans: false,
  }
}
