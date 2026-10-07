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
import { buildNameTable, readinessFromDecisions } from "../../../../db/shared/bible-checks/agreed-names"
import { compileFileExpectations } from "../../../../db/shared/bible-checks/compile"
import { bibleChecksReadText } from "../../../../db/shared/bible-checks/evaluate"
import type { BibleCheckReadiness, NameTable } from "../../../../db/shared/bible-checks/participant-types"
import { expandCellRefs } from "../../../../db/shared/bible-checks/refs"
import type { CellExpectation } from "../../../../db/shared/bible-checks/types"
import { computeCellFacts, renderFactsLine } from "../../../../db/shared/bible-facts/facts"
import type { CellFacts } from "../../../../db/shared/bible-facts/types"
import type { LanguageProfile } from "../../../../db/shared/language-profile"
import type { ProjectFact } from "../../../../db/shared/project-facts"
import type { BkpFailureReason, BkpResult, BookPack } from "../bkp/pack-loader"
import type { Concept } from "./project-context"
import type { BibleJudgeDeps } from "./bible-span"
import type { TraceInput } from "./traces"

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
  /** Jev for the Bible data questions. Omitted → only code decides; nothing is asked. */
  judge?: BibleJudgeDeps
  /** Fact-question keys this run has raised (./bible-fact-questions.ts). Omitted → none are raised. */
  raisedFactKeys?: Set<string>
  /** Record a code-only trace row: a span's facts and its metrics (./span-metrics.ts). */
  trace?: (row: TraceInput) => void
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
 * The text layer is several MB. It feeds "you" singular/plural, worth loading
 * while the profile has not said whether "you" has number (a fact question
 * may ask) or says it does (the facts state the number); and (AQU-1697) the
 * Bible data checks that read it: numbers, negation, run-on sentences, and
 * (AQU-1699) the names, "we" and κύριος of check pack B.
 */
export function needsTextLayer(profile: LanguageProfile, readiness?: BibleCheckReadiness): boolean {
  const second = profile.pronouns?.secondPerson
  return second === undefined || second.numberDistinction || bibleChecksReadText(profile, readiness)
}

/** AQU-1699: what decides each name: the project's decisions, terminology, source language and lanes. */
export interface NameInputs {
  concepts: readonly Concept[]
  facts?: readonly ProjectFact[]
  sourceLanguage?: string | null
  multiLane?: boolean
}

function nameTable(pack: BookPack, names: NameInputs): NameTable {
  return buildNameTable({ people: pack.people, text: pack.text, ...names })
}

/**
 * Entity id → the project's agreed rendering, for the facts lines. AQU-1699:
 * the same agreed names the participant checks use
 * (db/shared/bible-checks/agreed-names.ts): a `render.<entity>` decision, else
 * a terminology entry whose source term is the entity's label in the project's
 * source language (English when it has none). A decision for one book or
 * passage is left out of a line that rides every cell; a name nothing decides
 * keeps its pack label.
 */
export function agreedRenderings(pack: BookPack, concepts: readonly Concept[], names: Omit<NameInputs, "concepts"> = {}): Map<string, string> {
  return renderingMap(nameTable(pack, { concepts, ...names }))
}

function renderingMap(table: NameTable): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, list] of table.names) {
    const name = list.find((n) => !n.fact || (!n.fact.scope.book && !n.fact.scope.passage))
    if (name) out.set(id, name.renderings[0])
  }
  return out
}

export async function prepareBibleRun(input: {
  pairs: readonly CellPair[]
  profile: LanguageProfile
  concepts: readonly Concept[]
  /** AQU-1699: the decision log, the source language and the lanes, for the agreed names. */
  facts?: readonly ProjectFact[]
  sourceLanguage?: string | null
  multiLane?: boolean
  flags: BibleFlags
  loadPack: LoadBookPack
}): Promise<BibleRun> {
  if (!input.flags.autopilot) return { state: "off" }
  const book = bookOfPairs(input.pairs)
  // A file with no verse refs (a glossary, a prose doc) has no Bible data to use.
  if (!book) return { state: "off" }
  const readiness = readinessFromDecisions(input.facts ?? [], input.concepts)
  const loaded = await input.loadPack(book, { text: needsTextLayer(input.profile, readiness) })
  if (!loaded.ok) return { state: "unavailable", reason: loaded.reason }
  const pack = loaded.value

  const names = nameTable(pack, {
    concepts: input.concepts,
    facts: input.facts,
    sourceLanguage: input.sourceLanguage,
    multiLane: input.multiLane,
  })
  const expectations = compileFileExpectations(
    input.pairs.map((pair) => ({ id: pair.cellId, globalReferences: pair.canonicalRef ? [pair.canonicalRef] : [] })),
    pack.voices,
    pack.structure,
    pack.text,
    { people: pack.people, names },
  )
  const renderings = renderingMap(names)
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
  input: { pairs: readonly CellPair[]; profile: LanguageProfile } & NameInputs,
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
