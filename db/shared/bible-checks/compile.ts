// Compile Bible pack facts into per-cell expectations (AQU-1688).
//
// The expectation for a cell says which quotations open, close, continue or
// are interrupted in it, at which quote level, and whether it asks a question.
// It is built from the pack only, never from any cell's text, once per file;
// `evaluateCell` (./evaluate.ts) then checks one cell's text against it. That
// split is what keeps the checks pure per cell.
//
// Relative imports only, no DOM: shared with the workers.

import { expandCellRefs } from './refs'
import type {
  CellExpectation,
  SpeechExpectation,
  SpeechInput,
  StructureLayerInput,
  VoicesLayerInput,
} from './types'

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
  return { runs, refRange, speeches, gaps }
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
}

/**
 * The expectation for one cell, from its `globalReferences` and the book's
 * voices and structure layers. Null when the pack has nothing to say: no verse
 * refs, a verse the voices layer lacks, or refs that are not consecutive.
 * A missing structure layer only means no question facts.
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
    if (!range) return null
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
    const expectation = compileCellExpectation(cell.globalReferences ?? [], voicesLayer, structureLayer, { sharedRefs })
    if (expectation) out.set(cell.id, expectation)
  }
  return out
}
