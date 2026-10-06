// bible-run — the Bible data one autopilot wave uses (AQU-1690).
//
// Loaded once per wave, beside loadProjectContext, and shared by every span:
// the file's book, its pack layers, each cell's compiled expectation (the
// checks' input) and each cell's facts (the prompts' input).
//
// Gated twice, both in the caller's flags:
//   autopilot — Bible data is on and the "Use Bible data in autopilot"
//               enrichment is on. Without it nothing loads: no facts, no
//               checks, no Jev questions.
//   checks    — the Bible data checks enrichment is ALSO on. Only then do the
//               bkp: gates, the Jev questions and the fact questions run.
// A pack that does not load is a typed `unavailable`: the run continues
// without Bible data and the tick records the reason on each span.

import type { CellPair } from "../agent/tools/select-cells"
import { compileFileExpectations } from "../../../../db/shared/bible-checks/compile"
import { expandCellRefs } from "../../../../db/shared/bible-checks/refs"
import type { CellExpectation } from "../../../../db/shared/bible-checks/types"
import { computeCellFacts, renderFactsLine } from "../../../../db/shared/bible-facts/facts"
import type { CellFacts } from "../../../../db/shared/bible-facts/types"
import type { LanguageProfile } from "../../../../db/shared/language-profile"
import type { BkpFailureReason, BkpResult, BookPack } from "../bkp/pack-loader"
import type { Concept } from "./project-context"

export interface BibleFlags {
  /** Bible data on and the `autopilot` enrichment on. */
  autopilot: boolean
  /** The `checks` enrichment on as well. */
  checks: boolean
}

export interface BibleRunData {
  packVersion: string
  book: string
  /** The checks enrichment is on too: bkp: gates, Jev questions and fact questions run. */
  checks: boolean
  profile: LanguageProfile
  expectations: ReadonlyMap<string, CellExpectation>
  facts: ReadonlyMap<string, CellFacts>
  /** One full facts line per cell id, for the drafter and the verifiers. */
  draftLines: ReadonlyMap<string, string>
  /** One short facts line per cell id, for scene construal. */
  construeLines: ReadonlyMap<string, string>
}

export type BibleRun =
  | { state: "off" }
  | { state: "unavailable"; reason: BkpFailureReason }
  | { state: "ready"; data: BibleRunData }

export type LoadBookPack = (book: string, opts: { text: boolean }) => Promise<BkpResult<BookPack>>

/** What the run driver injects into each tick (routes/contextual.ts builds it). */
export interface BibleTickDeps {
  /** The project's effective Bible data switches, read once per wave. */
  flags: () => Promise<BibleFlags>
  loadPack: LoadBookPack
}

/** The book of the first cell with a verse ref, e.g. "JHN"; null for a file with none. */
export function bookOfPairs(pairs: readonly CellPair[]): string | null {
  for (const pair of pairs) {
    const verses = pair.canonicalRef ? expandCellRefs([pair.canonicalRef]) : null
    if (verses) return verses.book
  }
  return null
}

/**
 * The text layer is several MB, and only feeds "you" singular/plural. It is
 * worth loading while the profile has not said whether "you" has number (a
 * fact question may ask) or says it does (the facts state the number).
 */
export function needsTextLayer(profile: LanguageProfile): boolean {
  const second = profile.pronouns?.secondPerson
  return second === undefined || second.numberDistinction
}

/**
 * Entity id → the project's agreed rendering, for names the termbase decides:
 * a concept whose source term is the entity's English label, with a preferred
 * (else admitted) rendering. Cheap, and exact-match only; a name the termbase
 * does not hold keeps its pack label.
 */
export function agreedRenderings(pack: BookPack, concepts: readonly Concept[]): Map<string, string> {
  const byTerm = new Map<string, string>()
  for (const concept of concepts) {
    if (concept.status !== "active") continue
    const rendering =
      concept.renderings.find((r) => r.status === "preferred")?.rendering ??
      concept.renderings.find((r) => r.status === "admitted")?.rendering
    if (rendering) byTerm.set(concept.sourceTerm.trim().toLowerCase(), rendering)
  }
  const out = new Map<string, string>()
  if (byTerm.size === 0) return out
  for (const [id, entity] of Object.entries(pack.people.entities)) {
    const label = entity.labels.eng?.trim().toLowerCase()
    const rendering = label ? byTerm.get(label) : undefined
    if (rendering) out.set(id, rendering)
  }
  return out
}

export async function prepareBibleRun(input: {
  pairs: readonly CellPair[]
  profile: LanguageProfile
  concepts: readonly Concept[]
  flags: BibleFlags
  loadPack: LoadBookPack
}): Promise<BibleRun> {
  if (!input.flags.autopilot) return { state: "off" }
  const book = bookOfPairs(input.pairs)
  // A file with no verse refs (a glossary, a prose doc) has no Bible data to use.
  if (!book) return { state: "off" }
  const loaded = await input.loadPack(book, { text: needsTextLayer(input.profile) })
  if (!loaded.ok) return { state: "unavailable", reason: loaded.reason }
  const pack = loaded.value

  const expectations = compileFileExpectations(
    input.pairs.map((pair) => ({ id: pair.cellId, globalReferences: pair.canonicalRef ? [pair.canonicalRef] : [] })),
    pack.voices,
    pack.structure,
  )
  const renderings = agreedRenderings(pack, input.concepts)
  const layers = { voices: pack.voices, structure: pack.structure, people: pack.people, text: pack.text }
  const facts = new Map<string, CellFacts>()
  const draftLines = new Map<string, string>()
  const construeLines = new Map<string, string>()
  for (const [cellId, expectation] of expectations) {
    const cellFacts = computeCellFacts(expectation, layers, renderings)
    facts.set(cellId, cellFacts)
    draftLines.set(cellId, renderFactsLine(cellFacts, "draft"))
    construeLines.set(cellId, renderFactsLine(cellFacts, "construe"))
  }
  return {
    state: "ready",
    data: {
      packVersion: pack.version,
      book,
      checks: input.flags.checks,
      profile: input.profile,
      expectations,
      facts,
      draftLines,
      construeLines,
    },
  }
}

/**
 * The tick's entry point. Never throws: the loader returns typed failures, and
 * a layer whose envelope passed but whose insides are malformed (the loader
 * checks envelopes only) surfaces here as `invalid`, so the wave still runs.
 */
export async function prepareBibleWave(
  deps: BibleTickDeps | undefined,
  input: { pairs: readonly CellPair[]; profile: LanguageProfile; concepts: readonly Concept[] },
): Promise<BibleRun> {
  if (!deps) return { state: "off" }
  try {
    return await prepareBibleRun({ ...input, flags: await deps.flags(), loadPack: deps.loadPack })
  } catch (err) {
    console.warn("[contextual] Bible data unusable; this wave runs without it:", err instanceof Error ? err.message : err)
    return { state: "unavailable", reason: "invalid" }
  }
}

/** The span reason code for a wave that ran without Bible data because the pack failed. */
export function bibleReasonCode(
  bible: BibleRun,
): "bible_data_offline" | "bible_data_not_found" | "bible_data_invalid" | null {
  if (bible.state !== "unavailable") return null
  if (bible.reason === "offline") return "bible_data_offline"
  return bible.reason === "not-found" ? "bible_data_not_found" : "bible_data_invalid"
}
