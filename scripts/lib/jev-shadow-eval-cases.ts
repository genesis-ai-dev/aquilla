/**
 * The Jev shadow eval's cases (AQU-1701): for each per-cell question, pairs
 * of a published verse (the World English Bible, where a "yes" is right) and
 * the same verse with a planted error (where a "no" is right), chosen where
 * the pack says the question applies. The generators are the evals' shared
 * mutations (./bible-mutations.ts). Pure: the production wording of each
 * question is passed in by the CLI (scripts/jev-shadow-eval.ts), which is
 * also where C1's Translation Questions are built.
 *
 *   speaker      the speaker's name swapped for another's (Peter ↔ John)
 *   question     the question made a statement ("?" → ".")
 *   negation     every negator dropped
 *   you_number   Tok Pisin "yu" / "yupela" planted for "you", then swapped
 *                (a language that marks the number; English does not)
 *   referent     the implied subject's "he" made a look-alike's name
 *   we_inclusive Tok Pisin "yumi" / "mipela" planted for "we", then swapped
 *   introduced   the newly introduced participant's name made a pronoun
 */

import { buildNameTable } from "../../db/shared/bible-checks/agreed-names"
import { compileFileExpectations } from "../../db/shared/bible-checks/compile"
import type { CellParticipants, Clusivity, PeopleLayerInput } from "../../db/shared/bible-checks/participant-types"
import { lookAlikeKey } from "../../db/shared/bible-checks/reference-tracking"
import type { CellExpectation, StructureLayerInput, TextLayerInput, VoicesLayerInput } from "../../db/shared/bible-checks/types"
import { computeCellFacts, renderFactsLine } from "../../db/shared/bible-facts/facts"
import type { CellFacts, FactsVoicesInput } from "../../db/shared/bible-facts/types"
import {
  dropNegation,
  ENGLISH_WE,
  ENGLISH_YOU,
  hasNegator,
  nameInApposition,
  nameToPronoun,
  plantForm,
  pronounToName,
  removeQuestion,
  sample,
  swapNames,
} from "./bible-mutations"
import type { EvalCase } from "./jev-shadow-eval"

export const CELL_QUESTIONS = ["speaker", "question", "negation", "you_number", "referent", "we_inclusive", "introduced"] as const
export type CellQuestion = (typeof CELL_QUESTIONS)[number]

/** One verse as the eval reads it. */
export interface EvalVerse {
  ref: string
  /** The World English Bible's text: the "translation". */
  text: string
  /** The Greek, from the pack's text layer: the source the state carries. */
  source: string
  expectation: CellExpectation
  facts: CellFacts
  factsLine: string
}

export interface CellCase extends EvalCase {
  question: CellQuestion
  source: string
  text: string
  factsLine: string
  /** The question as production words it. */
  prompt: string
}

/** Production's wording (auth-worker contextual/judge-expectations.ts, judge-participants.ts) and its way of naming a participant. */
export interface Prompts {
  speaker: (name: string) => string
  question: string
  negation: string
  you_number: string
  referent: (name: string, verb: string) => string
  we_inclusive: string
  introduced: (name: string) => string
  name: (p: CellParticipants, entity: string, refs: readonly string[]) => string
}

export interface BookLayers {
  voices: VoicesLayerInput
  structure: StructureLayerInput
  people: PeopleLayerInput
  text: TextLayerInput & { words: Readonly<Record<string, { text?: string; after?: string }>> }
}

/** A book's verses with the WEB text, their compiled facts, and the Greek. */
export function evalVerses(layers: BookLayers, web: readonly { ref: string; text: string }[]): EvalVerse[] {
  const names = buildNameTable({ people: layers.people, text: layers.text, sourceLanguage: "en" })
  const cells = web.map(({ ref }) => ({ id: ref, globalReferences: [ref] }))
  const expectations = compileFileExpectations(cells, layers.voices, layers.structure, layers.text, { people: layers.people, names })
  const factsLayers = {
    voices: layers.voices as FactsVoicesInput,
    structure: layers.structure,
    people: layers.people,
    text: layers.text as unknown as Parameters<typeof computeCellFacts>[1]["text"],
  }
  return web.flatMap(({ ref, text }) => {
    const expectation = expectations.get(ref)
    if (!expectation?.inPack) return []
    const facts = computeCellFacts(expectation, factsLayers)
    const source = (layers.text.verses[ref] ?? [])
      .map((id) => `${layers.text.words[id]?.text ?? ""}${layers.text.words[id]?.after ?? " "}`)
      .join("")
      .trim()
    return [{ ref, text, source, expectation, facts, factsLine: renderFactsLine(facts, "draft") }]
  })
}

/** "John (the Baptist)" → "John": the name as a translation writes it. */
function bareLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/u, "")
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u").test(text)
}

/** "m:one", "f:one" or "many": the English pronoun set a participant takes; null when the pack does not say. */
function pronounKind(p: CellParticipants, entity: string): string | null {
  const key = lookAlikeKey(Object.hasOwn(p.names.entities, entity) ? p.names.entities[entity] : undefined)
  if (!key) return null
  return key.endsWith(":many") ? "many" : key === "n:one" ? null : key
}

/** A label for a named person in the pack (ACAI), else null: local participants have no name to swap in. */
function personName(p: CellParticipants, entity: string): string | null {
  if (!entity.startsWith("person:") || !Object.hasOwn(p.names.entities, entity)) return null
  const label = p.names.entities[entity].labels.eng
  return label ? bareLabel(label) : null
}

interface Pair {
  correct: CellCase
  planted: CellCase
}

function pair(
  v: EvalVerse,
  question: CellQuestion,
  prompt: string,
  texts: { correct: string; planted: string },
  passWhenYes = true,
): Pair {
  const base = { question, ref: v.ref, source: v.source, factsLine: v.factsLine, prompt, passWhenYes }
  return {
    correct: { ...base, kind: "correct", text: texts.correct },
    planted: { ...base, kind: "planted", text: texts.planted },
  }
}

type PairBuilder = (v: EvalVerse, prompts: Prompts) => Pair | null

const BUILDERS: Readonly<Record<CellQuestion, PairBuilder>> = {
  speaker: (v, prompts) => {
    const speaker = v.facts.speeches.find((s) => s.opens && !s.selfProjected && s.speaker)?.speaker
    if (!speaker?.id.startsWith("person:")) return null
    const name = bareLabel(speaker.label)
    if (!hasWord(v.text, name)) return null
    const planted = swapNames(v.text, name, name === "Peter" ? "John" : "Peter")
    return planted === v.text ? null : pair(v, "speaker", prompts.speaker(speaker.label), { correct: v.text, planted })
  },
  question: (v, prompts) => {
    const planted = v.expectation.question.expected ? removeQuestion(v.text) : null
    return planted ? pair(v, "question", prompts.question, { correct: v.text, planted }) : null
  },
  negation: (v, prompts) => {
    if (v.facts.negators === 0 || !hasNegator(v.text)) return null
    const planted = dropNegation(v.text)
    return planted ? pair(v, "negation", prompts.negation, { correct: v.text, planted }) : null
  },
  you_number: (v, prompts) => {
    const number = v.facts.secondPerson
    const explicit = v.expectation.participants?.secondPerson?.explicit === true
    if ((number !== "singular" && number !== "plural") || !explicit || !hasWord(v.text.toLowerCase(), "you")) return null
    const [right, wrong] = number === "singular" ? ["yu", "yupela"] : ["yupela", "yu"]
    return pair(
      v,
      "you_number",
      prompts.you_number,
      { correct: plantForm(v.text, ENGLISH_YOU, right), planted: plantForm(v.text, ENGLISH_YOU, wrong) },
      number === "singular",
    )
  },
  referent: (v, prompts) => {
    const p = v.expectation.participants
    const subject = p?.ambiguousSubjects[0]
    if (!p || !subject) return null
    const kind = pronounKind(p, subject.entity)
    const own = personName(p, subject.entity) ?? bareLabel(p.names.entities[subject.entity]?.labels.eng ?? "")
    const peer = subject.peers.map((id) => personName(p, id)).find((name): name is string => !!name && name !== own)
    if (!kind || !peer || (own && hasWord(v.text, own))) return null
    // The pronoun of the subject's own verb ("He brought"): without a word alignment, the only one known to be theirs.
    const planted = pronounToName(v.text, kind, peer, subject.gloss)
    if (!planted) return null
    const prompt = prompts.referent(prompts.name(p, subject.entity, v.expectation.refs), subject.gloss)
    return pair(v, "referent", prompt, { correct: v.text, planted })
  },
  we_inclusive: (v, prompts) => {
    const kinds = new Set((v.expectation.participants?.firstPlural ?? []).flatMap((m): Clusivity[] => (m.clusivity ? [m.clusivity] : [])))
    if (kinds.size !== 1 || !hasWord(v.text.toLowerCase(), "we")) return null
    const inclusive = kinds.has("inclusive")
    const [right, wrong] = inclusive ? ["yumi", "mipela"] : ["mipela", "yumi"]
    return pair(
      v,
      "we_inclusive",
      prompts.we_inclusive,
      { correct: plantForm(v.text, ENGLISH_WE, right), planted: plantForm(v.text, ENGLISH_WE, wrong) },
      inclusive,
    )
  },
  introduced: (v, prompts) => {
    const p = v.expectation.participants
    if (!p) return null
    for (const intro of p.introduced) {
      const name = personName(p, intro.entity)
      const kind = pronounKind(p, intro.entity)
      // "John the Baptizer" made "He the Baptizer" is still identified: no clean planted error there.
      const planted = name && kind && !nameInApposition(v.text, name) ? nameToPronoun(v.text, name, kind) : null
      if (planted) return pair(v, "introduced", prompts.introduced(prompts.name(p, intro.entity, v.expectation.refs)), { correct: v.text, planted })
    }
    return null
  },
}

/** Every verse where the pack says `question` applies and its error can be planted cleanly. */
export function casePairs(question: CellQuestion, verses: readonly EvalVerse[], prompts: Prompts): Pair[] {
  return verses.flatMap((v) => BUILDERS[question](v, prompts) ?? [])
}

/** `n` pairs drawn at random (seeded): `n` published cases and their `n` planted twins. */
export function sampleCases(pairs: readonly Pair[], n: number, rand: () => number): CellCase[] {
  return sample(pairs, n, rand).flatMap((p) => [p.correct, p.planted])
}
