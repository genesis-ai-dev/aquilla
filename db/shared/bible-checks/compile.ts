// Compile Bible pack facts into per-cell expectations (AQU-1688).
//
// The expectation for a cell says which quotations open, close, continue or
// are interrupted in it, at which quote level, and whether it asks a question.
// It is built from the pack only, never from any cell's text, once per file;
// `evaluateCell` (./evaluate.ts) then checks one cell's text against it. That
// split is what keeps the checks pure per cell.
//
// Relative imports only, no DOM: shared with the workers.

import { verseNumbers } from './greek-numbers'
import { cellNegation } from './negation'
import { expandCellRefs, siblingWordId, wordNumber, type CellVerses } from './refs'
import type {
  CellExpectation,
  SpeechExpectation,
  SpeechInput,
  StructureLayerInput,
  TextLayerInput,
  VoicesLayerInput,
} from './types'
import { cellVariant } from './variants'

interface IndexedRun {
  ref: string
  from: string
  to: string
  /** The speeches whose quotation holds this run: its own voice, then each enclosing speech. */
  chain: readonly string[]
}

/** Where another voice cuts into a speech: it closes after `closeAt` and reopens at `reopenAt`. */
interface Gap {
  closeAt: string
  reopenAt: string
}

interface VoicesIndex {
  runs: IndexedRun[]
  refRange: Map<string, { first: number; last: number }>
  speeches: Map<string, SpeechInput>
  gaps: Map<string, Gap[]>
  /** AQU-1697: each speech's first word, where a question's μή can stand (M3). */
  speechStarts: Set<string>
}

const MAX_NESTING = 32

function chainOf(speechId: string, speeches: Map<string, SpeechInput>): string[] {
  const chain: string[] = []
  let current = speeches.get(speechId)
  while (current && chain.length < MAX_NESTING && !chain.includes(current.id)) {
    chain.push(current.id)
    current = current.parent ? speeches.get(current.parent) : undefined
  }
  return chain
}

function buildIndex(voices: VoicesLayerInput): VoicesIndex {
  const speeches = new Map(voices.speeches.map((speech) => [speech.id, speech]))
  const runs: IndexedRun[] = []
  for (const [ref, verseRuns] of Object.entries(voices.verses)) {
    for (const run of verseRuns) {
      // "narrator", or a speech id the layer does not define: no quotation holds it.
      runs.push({ ref, from: run.from, to: run.to, chain: chainOf(run.speech, speeches) })
    }
  }
  // Macula ids sort in reading order within a book.
  runs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))

  const refRange = new Map<string, { first: number; last: number }>()
  const lastCovered = new Map<string, number>()
  const gaps = new Map<string, Gap[]>()
  runs.forEach((run, i) => {
    const range = refRange.get(run.ref)
    if (range) range.last = i
    else refRange.set(run.ref, { first: i, last: i })
    for (const id of run.chain) {
      const previous = lastCovered.get(id)
      // A run of another voice sits between two runs of this speech.
      if (previous !== undefined && previous < i - 1) {
        const list = gaps.get(id) ?? []
        list.push({ closeAt: runs[previous].to, reopenAt: run.from })
        gaps.set(id, list)
      }
      lastCovered.set(id, i)
    }
  })
  return { runs, refRange, speeches, gaps, speechStarts: new Set(voices.speeches.map((speech) => speech.from)) }
}

// Built once per layer object. The pack client hands out one object per file
// and version, so this is the "once per file" cost; a WeakMap lets a dropped
// layer be collected.
const indexCache = new WeakMap<VoicesLayerInput, VoicesIndex>()

function voicesIndex(voices: VoicesLayerInput): VoicesIndex {
  let index = indexCache.get(voices)
  if (!index) {
    index = buildIndex(voices)
    indexCache.set(voices, index)
  }
  return index
}

/** A speech the target marks with quotation marks: not self-projected, and at level 1 or deeper. */
export function isMarkedSpeech(speech: Pick<SpeechInput, 'selfProjected' | 'level'>): boolean {
  return !speech.selfProjected && speech.level >= 1
}

function runLevel(run: IndexedRun, speeches: Map<string, SpeechInput>): number {
  let level = 0
  for (const id of run.chain) {
    const speech = speeches.get(id)
    if (speech && isMarkedSpeech(speech)) level = Math.max(level, speech.level)
  }
  return level
}

export interface CompileOptions {
  /** Verse refs that more than one cell of the file covers (split verses). */
  sharedRefs?: ReadonlySet<string>
  /** AQU-1697: the text layer (or a compact copy) for the numbers (N1, N2) and negation (M3). */
  text?: TextLayerInput | null
}

// ── AQU-1697: moves (S3) ────────────────────────────────────────────────────

interface MovesIndex {
  /** Moves sorted by first word, with the furthest last word of any move so far. */
  froms: string[]
  furthestTo: string[]
  ends: Set<string>
}

const movesCache = new WeakMap<object, MovesIndex>()

function movesIndex(moves: readonly { from: string; to: string }[]): MovesIndex {
  let index = movesCache.get(moves)
  if (!index) {
    const sorted = [...moves].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    const furthestTo: string[] = []
    for (const move of sorted) {
      const previous = furthestTo[furthestTo.length - 1]
      furthestTo.push(previous !== undefined && previous > move.to ? previous : move.to)
    }
    index = { froms: sorted.map((m) => m.from), furthestTo, ends: new Set(moves.map((m) => m.to)) }
    movesCache.set(moves, index)
  }
  return index
}

/** Some move spans `wordId` and runs on past it, and none ends there: the sentence goes on. */
function sentenceRunsPast(structure: StructureLayerInput | null | undefined, wordId: string): boolean {
  if (!structure?.moves) return false
  const index = movesIndex(structure.moves)
  if (index.ends.has(wordId)) return false
  // The last move that starts at or before the word.
  let lo = 0
  let hi = index.froms.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (index.froms[mid] <= wordId) {
      at = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return at >= 0 && index.furthestTo[at] > wordId
}

/** The Greek ends a sentence or a clause at this word: . · ; (Macula's `after`). */
const GREEK_STOP = /[.;\u00B7\u0387\u037E]/u

function greekStopsAt(text: TextLayerInput | null | undefined, wordId: string): boolean {
  if (!text || !Object.hasOwn(text.words, wordId)) return false
  return GREEK_STOP.test(text.words[wordId].after ?? '')
}

/** Where a speech starts or a vocative ends: places a question's μή can open the clause. */
function clauseStarts(index: VoicesIndex, structure: StructureLayerInput | null | undefined, refs: readonly string[]): Set<string> {
  const starts = new Set(index.speechStarts)
  for (const ref of refs) {
    const verse = structure && Object.hasOwn(structure.verses, ref) ? structure.verses[ref] : undefined
    for (const vocative of verse?.vocatives ?? []) starts.add(siblingWordId(vocative, wordNumber(vocative) + 1))
  }
  return starts
}

/**
 * The expectation for a cell whose verses the pack lacks: a verse the
 * critical text omits (MAT 17:21), maybe bridged with one it has. Only the
 * variant checks have facts here; null when none of its verses is a variant.
 */
function outsidePack(verses: CellVerses, sharedRefs: ReadonlySet<string> | undefined): CellExpectation | null {
  const variant = cellVariant(verses.verses)
  if (!variant) return null
  return {
    book: verses.book,
    refs: verses.verses,
    approximate: verses.partial || verses.verses.some((ref) => sharedRefs?.has(ref) === true),
    speeches: [],
    startDepth: 0,
    endDepth: 0,
    boundaries: false,
    trailingNarration: null,
    question: { expected: false, rhetorical: false },
    numbers: [],
    negation: null,
    continuesPast: false,
    variant,
    inPack: false,
  }
}

/**
 * The expectation for one cell, from its `globalReferences` and the book's
 * voices and structure layers. Null when the pack has nothing to say: no verse
 * refs, a verse the voices layer lacks, or refs that are not consecutive.
 * A missing structure layer only means no question, negation or move facts;
 * a missing text layer, no numbers. AQU-1697: a cell with a verse the pack
 * lacks because the critical text omits it gets the variant facts alone.
 */
export function compileCellExpectation(
  cellRefs: readonly string[],
  voicesLayer: VoicesLayerInput,
  structureLayer: StructureLayerInput | null | undefined,
  options: CompileOptions = {},
): CellExpectation | null {
  const verses = expandCellRefs(cellRefs)
  if (!verses) return null
  const index = voicesIndex(voicesLayer)
  const ranges: { first: number; last: number }[] = []
  for (const ref of verses.verses) {
    const range = index.refRange.get(ref)
    if (!range) return outsidePack(verses, options.sharedRefs)
    const previous = ranges[ranges.length - 1]
    if (previous && range.first !== previous.last + 1) return null
    ranges.push(range)
  }
  const first = ranges[0].first
  const last = ranges[ranges.length - 1].last
  const cellFrom = index.runs[first].from
  const cellTo = index.runs[last].to
  const inCell = (wordId: string) => wordId >= cellFrom && wordId <= cellTo

  const touching = new Set<string>()
  for (let i = first; i <= last; i++) for (const id of index.runs[i].chain) touching.add(id)
  const firstChain = index.runs[first].chain
  const lastChain = index.runs[last].chain

  const speeches: SpeechExpectation[] = []
  for (const id of touching) {
    const speech = index.speeches.get(id)
    if (!speech) continue
    const gaps = index.gaps.get(id) ?? []
    const opens = inCell(speech.from)
    const closes = inCell(speech.to)
    const interruptCloses = gaps.filter((gap) => inCell(gap.closeAt)).length
    const interruptOpens = gaps.filter((gap) => inCell(gap.reopenAt)).length
    speeches.push({
      id,
      from: speech.from,
      to: speech.to,
      level: speech.level,
      depth: speech.depth,
      selfProjected: speech.selfProjected,
      opens,
      closes,
      continues: !opens && !closes,
      // Open across the cell's edge, unless the speech was cut off right there.
      openAtStart: !opens && firstChain.includes(id) && !gaps.some((gap) => gap.reopenAt === cellFrom),
      openAtEnd: !closes && lastChain.includes(id) && !gaps.some((gap) => gap.closeAt === cellTo),
      interruptCloses,
      interruptOpens,
      interrupted: interruptCloses + interruptOpens > 0,
      speakerSources: [...speech.speakerSources],
      speakerConf: speech.speakerConf,
    })
  }
  speeches.sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id))

  const marked = speeches.filter(isMarkedSpeech)
  const depthWhere = (open: (s: SpeechExpectation) => boolean) =>
    marked.filter(open).reduce((depth, s) => Math.max(depth, s.level), 0)

  let trailingNarration: CellExpectation['trailingNarration'] = null
  if (last > first) {
    const endLevel = runLevel(index.runs[last], index.speeches)
    const before = index.runs[last - 1]
    const closeLevel = runLevel(before, index.speeches)
    if (closeLevel > endLevel) {
      const closing = before.chain.find((id) => {
        const speech = index.speeches.get(id)
        return speech !== undefined && isMarkedSpeech(speech) && speech.level === closeLevel
      })
      if (closing) trailingNarration = { closeLevel, endLevel, speechId: closing }
    }
  }

  return {
    book: verses.book,
    refs: verses.verses,
    approximate: verses.partial || verses.verses.some((ref) => options.sharedRefs?.has(ref) === true),
    speeches,
    startDepth: depthWhere((s) => s.openAtStart),
    endDepth: depthWhere((s) => s.openAtEnd),
    boundaries: marked.some((s) => s.opens || s.closes || s.interrupted),
    trailingNarration,
    question: {
      expected: verses.verses.some((ref) => structureLayer?.verses[ref]?.question === true),
      rhetorical: false,
    },
    numbers: verses.verses.flatMap((ref) => verseNumbers(ref, options.text)),
    negation: cellNegation(verses.verses, structureLayer, options.text, clauseStarts(index, structureLayer, verses.verses)),
    // A raised dot or full stop there lets a translation end the sentence too.
    continuesPast: sentenceRunsPast(structureLayer, cellTo) && !greekStopsAt(options.text, cellTo),
    variant: cellVariant(verses.verses),
    inPack: true,
  }
}

/** What the file-level compile needs from a cell. A CellSummary or CellData fits. */
export interface CellRefsInput {
  id: string
  globalReferences?: readonly string[]
}

/**
 * Expectations for every cell of a file, keyed by cell id. Cells the pack says
 * nothing about are absent. A verse that two cells share (a split verse) marks
 * both cells approximate.
 */
export function compileFileExpectations(
  cells: readonly CellRefsInput[],
  voicesLayer: VoicesLayerInput,
  structureLayer: StructureLayerInput | null | undefined,
  text?: TextLayerInput | null,
): Map<string, CellExpectation> {
  const cellsPerVerse = new Map<string, number>()
  for (const cell of cells) {
    for (const ref of expandCellRefs(cell.globalReferences ?? [])?.verses ?? []) {
      cellsPerVerse.set(ref, (cellsPerVerse.get(ref) ?? 0) + 1)
    }
  }
  const sharedRefs = new Set([...cellsPerVerse].filter(([, count]) => count > 1).map(([ref]) => ref))
  const out = new Map<string, CellExpectation>()
  for (const cell of cells) {
    const expectation = compileCellExpectation(cell.globalReferences ?? [], voicesLayer, structureLayer, { sharedRefs, text })
    if (expectation) out.set(cell.id, expectation)
  }
  return out
}
