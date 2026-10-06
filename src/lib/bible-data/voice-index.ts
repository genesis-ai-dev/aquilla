// Voices, the per-verse index (AQU-1687).
//
// Who speaks in each verse, in reading order, built from the Bible Knowledge
// Pack's `voices` layer (contract: ./pack-types.ts). Pure: no React, no i18n,
// no network. The layer arrives already moved into the project's
// versification by the pack client's hook (./versification.ts), so the refs
// here are project refs and cells look them up by their own canonical ref.
//
// Spec: aquilla-specs 05-user-stories/see-who-is-speaking.md and
// 04-features/bible-knowledge-layer.md (Edge cases); design doc §5.2 step 7.

import { isStructuralCell } from "@/lib/cells/structural"
import { parseScriptureReference } from "@/lib/scripture-reference"
import type { BibleVoiceOverrides } from "../../../db/shared/bible-voice-overrides"
import type { BkpEntityId, BkpRef, BkpSpeech, BkpVoicesLayer, BkpWordId } from "./pack-types"
import { applyVoiceOverrides, voiceOverridesKey, type AppliedVoiceOverride } from "./voice-overrides"

/** The pack's speech id for the narrator's (or, in letters, the author's) runs. */
const NARRATOR = "narrator"

/** One run of one voice inside one verse. */
export interface VoiceRun {
  /** The verse the run is in. */
  ref: BkpRef
  /** The speech, or null for the narrator (the author, in letters). */
  speech: BkpSpeech | null
  from: BkpWordId
  to: BkpWordId
  /** The run holds the speech's first word. Always false for the narrator. */
  opens: boolean
  /** The run holds the speech's last word. Always false for the narrator. */
  closes: boolean
}

export interface VoiceIndex {
  book: string
  narrator: BkpVoicesLayer["narrator"]
  /** Each verse's runs, in reading order. */
  runs: ReadonlyMap<BkpRef, readonly VoiceRun[]>
  speeches: ReadonlyMap<string, BkpSpeech>
  /** The first and last word of each verse. Word ids sort as strings within a book. */
  wordRange: ReadonlyMap<BkpRef, readonly [BkpWordId, BkpWordId]>
  /** Per verse, every speech whose span touches it, including speeches with no run there. */
  touching: ReadonlyMap<BkpRef, readonly BkpSpeech[]>
  /** AQU-1692: the project's corrections, by speech id. The speeches above already carry them. */
  overrides: ReadonlyMap<string, AppliedVoiceOverride>
  /** AQU-1692: this book's corrections whose speech the pack no longer has. */
  orphanedOverrides: readonly string[]
}

/** Verses sorted by first word, so a speech finds the verses it spans by binary search. */
function speechesByVerse(
  speeches: readonly BkpSpeech[],
  wordRange: ReadonlyMap<BkpRef, readonly [BkpWordId, BkpWordId]>,
): Map<BkpRef, BkpSpeech[]> {
  const verses = [...wordRange.entries()].sort(([, a], [, b]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  const out = new Map<BkpRef, BkpSpeech[]>()
  for (const speech of speeches) {
    let lo = 0
    let hi = verses.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (verses[mid][1][1] < speech.from) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < verses.length && verses[i][1][0] <= speech.to; i++) {
      const ref = verses[i][0]
      const list = out.get(ref)
      if (list) list.push(speech)
      else out.set(ref, [speech])
    }
  }
  return out
}

/** The index of `source`, with the project's corrections (AQU-1692) applied to its speeches. */
export function buildVoiceIndex(source: BkpVoicesLayer, overrides?: BibleVoiceOverrides): VoiceIndex {
  const corrected = applyVoiceOverrides(source, overrides)
  const layer = corrected.layer
  const speeches = new Map<string, BkpSpeech>()
  for (const speech of layer.speeches) speeches.set(speech.id, speech)

  const runs = new Map<BkpRef, VoiceRun[]>()
  const wordRange = new Map<BkpRef, readonly [BkpWordId, BkpWordId]>()
  for (const [ref, units] of Object.entries(layer.verses)) {
    if (units.length === 0) continue
    let first = units[0].from
    let last = units[0].to
    const verseRuns: VoiceRun[] = []
    for (const unit of units) {
      if (unit.from < first) first = unit.from
      if (unit.to > last) last = unit.to
      const speech = unit.speech === NARRATOR ? null : speeches.get(unit.speech)
      // A unit naming a speech the file does not have: drop the run rather
      // than show its words as someone else's.
      if (speech === undefined) continue
      verseRuns.push({ ref, speech, from: unit.from, to: unit.to, opens: unit.opens, closes: unit.closes })
    }
    wordRange.set(ref, [first, last])
    if (verseRuns.length > 0) runs.set(ref, verseRuns)
  }

  return {
    book: layer.book,
    narrator: layer.narrator,
    runs,
    speeches,
    wordRange,
    touching: speechesByVerse(layer.speeches, wordRange),
    overrides: corrected.applied,
    orphanedOverrides: corrected.orphaned,
  }
}

// ── Memo: one index per (pack version, book, corrections) ──────────────────

/** The open book's only (AQU-1700): an entry holds its layers, and an OT book's are several MB. */
const INDEX_CACHE_LIMIT = 1
const indexCache = new Map<string, { layer: BkpVoicesLayer; index: VoiceIndex }>()

/**
 * The index for one book of one pack version, built once. The layer object is
 * kept with it, so a different file under the same key (a test, a refetch) is
 * never answered with the old index. AQU-1692: the key also holds a hash of
 * the book's corrections, so a changed correction rebuilds it and an equal
 * one, refetched with the settings, does not.
 */
export function voiceIndexFor(version: string, layer: BkpVoicesLayer, overrides?: BibleVoiceOverrides): VoiceIndex {
  const key = `${version}/${layer.book}/${voiceOverridesKey(layer, overrides)}`
  const hit = indexCache.get(key)
  if (hit && hit.layer === layer) return hit.index
  const index = buildVoiceIndex(layer, overrides)
  indexCache.delete(key)
  indexCache.set(key, { layer, index })
  if (indexCache.size > INDEX_CACHE_LIMIT) {
    const oldest = indexCache.keys().next()
    if (!oldest.done) indexCache.delete(oldest.value)
  }
  return index
}

// ── Cells → verses ──────────────────────────────────────────────────────────

/** A cell as Voices sees it: its canonical ref and its type. */
export interface VoiceCellInput {
  ref: string | null | undefined
  type?: string | null
}

export interface CellVerses {
  book: string
  /** The verses the cell covers, in order: one, or each verse of a bridge. */
  refs: BkpRef[]
  /** The cell holds part of a verse ("JHN 4:7a"). */
  partial: boolean
}

/** A longer "bridge" is a malformed ref, not a passage. */
const MAX_BRIDGE_VERSES = 200
const VERSE_PART_RE = /^(\d+)([a-z]?)(?:-(\d+)([a-z]?))?$/

/** The verses a cell covers, or null for a cell that is not a verse (a heading, a title, paratext). */
export function cellVerses(cell: VoiceCellInput): CellVerses | null {
  if (isStructuralCell(cell.type)) return null
  const parsed = parseScriptureReference(cell.ref)
  if (!parsed?.verse) return null
  const match = VERSE_PART_RE.exec(parsed.verse)
  if (!match) return null
  const first = Number(match[1])
  const last = match[3] ? Number(match[3]) : first
  if (last < first || last - first > MAX_BRIDGE_VERSES) return null
  const chapter = Number(parsed.chapter)
  const refs: BkpRef[] = []
  for (let verse = first; verse <= last; verse++) refs.push(`${parsed.bookCode} ${chapter}:${verse}`)
  return { book: parsed.bookCode, refs, partial: Boolean(match[2] || match[4]) }
}

/** The verses that more than one cell covers: a verse split across cells. */
export function sharedVerseRefs(cells: Iterable<VoiceCellInput>): Set<BkpRef> {
  const seen = new Set<BkpRef>()
  const shared = new Set<BkpRef>()
  for (const cell of cells) {
    for (const ref of cellVerses(cell)?.refs ?? []) {
      if (seen.has(ref)) shared.add(ref)
      else seen.add(ref)
    }
  }
  return shared
}

/** The book of the first verse cell, or null when there is none. */
export function firstVerseBook(cells: Iterable<VoiceCellInput>): string | null {
  for (const cell of cells) {
    const verses = cellVerses(cell)
    if (verses) return verses.book
  }
  return null
}

export interface CellVoices {
  /** The verses the cell covers that the pack has voices for, in order. */
  refs: readonly BkpRef[]
  /** Their runs, in reading order: a bridge cell has the union of its verses'. */
  runs: readonly VoiceRun[]
  /** The first and last word the cell covers. */
  range: readonly [BkpWordId, BkpWordId]
  /**
   * The voices are the whole verse's, not just this cell's share: the cell
   * holds part of a verse, or another cell covers the same verse.
   */
  approximate: boolean
}

/** One cell's voices, or null for a non-verse cell and for verses the pack has no voices for. */
export function cellVoicesFor(
  index: VoiceIndex,
  cell: VoiceCellInput,
  shared: ReadonlySet<BkpRef>,
): CellVoices | null {
  const verses = cellVerses(cell)
  if (!verses || verses.book !== index.book) return null
  const refs: BkpRef[] = []
  const runs: VoiceRun[] = []
  let first: BkpWordId | null = null
  let last: BkpWordId | null = null
  for (const ref of verses.refs) {
    const verseRuns = index.runs.get(ref)
    const range = index.wordRange.get(ref)
    if (!verseRuns || !range) continue
    refs.push(ref)
    runs.push(...verseRuns)
    if (first === null || range[0] < first) first = range[0]
    if (last === null || range[1] > last) last = range[1]
  }
  if (first === null || last === null) return null
  return {
    refs,
    runs,
    range: [first, last],
    approximate: verses.partial || verses.refs.some((ref) => shared.has(ref)),
  }
}

// ── Voices as people see them ───────────────────────────────────────────────

/** A voice as the chip and its popover show it: the narrator, or one speech. */
export type Voice = { kind: "narrator" } | { kind: "speech"; speech: BkpSpeech }

/**
 * The speech a run shows as. A self-projected speech ("I tell you that …") is
 * its speaker framing their own words, so it shows as the speech around it,
 * or as the narrator when nothing is around it.
 */
export function shownSpeech(
  speech: BkpSpeech | null,
  speeches: ReadonlyMap<string, BkpSpeech>,
): BkpSpeech | null {
  let current = speech
  // The guard only stops a parent cycle in a broken file.
  for (let hops = 0; current?.selfProjected && hops < speeches.size; hops++) {
    current = current.parent ? (speeches.get(current.parent) ?? null) : null
  }
  return current?.selfProjected ? null : current
}

function voiceKey(voice: Voice): string {
  return voice.kind === "narrator" ? NARRATOR : voice.speech.id
}

/** The cell's voices in reading order. Runs of one voice next to each other merge. */
export function voiceSequence(index: VoiceIndex, cell: CellVoices): Voice[] {
  const out: Voice[] = []
  for (const run of cell.runs) {
    const speech = shownSpeech(run.speech, index.speeches)
    const voice: Voice = speech ? { kind: "speech", speech } : { kind: "narrator" }
    const previous = out[out.length - 1]
    if (previous && voiceKey(previous) === voiceKey(voice)) continue
    out.push(voice)
  }
  return out
}

/** Each voice once, in order of first appearance. */
export function distinctVoices(sequence: readonly Voice[]): Voice[] {
  const seen = new Set<string>()
  return sequence.filter((voice) => {
    const key = voiceKey(voice)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export interface VoiceChipModel {
  /** What the chip shows, in reading order. */
  voices: Voice[]
  /** How many more speeches the cell has than the chip shows. */
  more: number
}

/**
 * What the row-corner chip shows. With one speech, every voice in reading
 * order ("Narrator · Samaritan woman → Jesus · Narrator"). With more, the
 * voices up to the first speech, and a count of the other speeches
 * ("Narrator · Jesus → Samaritan woman +1").
 */
export function voiceChipModel(index: VoiceIndex, cell: CellVoices): VoiceChipModel {
  const sequence = voiceSequence(index, cell)
  const speeches = distinctVoices(sequence).filter((voice) => voice.kind === "speech")
  if (speeches.length <= 1) return { voices: sequence, more: 0 }
  const firstSpeech = sequence.findIndex((voice) => voice.kind === "speech")
  return { voices: sequence.slice(0, firstSpeech + 1), more: speeches.length - 1 }
}

/** True when `speaker` speaks anywhere in the cell, quoted speech included. */
export function speaksIn(cell: CellVoices, speaker: BkpEntityId): boolean {
  return cell.runs.some((run) => run.speech?.speaker === speaker)
}
