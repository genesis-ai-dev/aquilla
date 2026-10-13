// Bible data checks (AQU-1688): ids, structural inputs and result shapes.
//
// Shared by the SPA rule engine and, later, the auth-worker's lintSpanDraft
// (AQU-1690). Relative imports only, no DOM and no SPA aliases, so a worker can
// import every file in this folder.
//
// The inputs are STRUCTURAL types: the few fields of the pack layers that the
// checks read. The SPA's BkpVoicesLayer and BkpStructureLayer
// (src/lib/bible-data/pack-types.ts) satisfy them, and so does the pack JSON a
// worker parses.

import type { LanguageProfileSlot } from '../language-profile'

/** The checks so far. Finding codes, `algorithmicChecks` keys and built-in rule ids all use these. */
export const BIBLE_CHECK_IDS = [
  'bkp:V1',
  'bkp:V2',
  'bkp:V3',
  'bkp:V5',
  'bkp:V7',
  'bkp:V8',
  'bkp:V9',
  'bkp:M1',
  // AQU-1697, check pack A: numbers, negation, structure and textual variants.
  'bkp:N1',
  'bkp:N2',
  'bkp:M3',
  'bkp:S1',
  'bkp:S3',
  'bkp:S6',
  'bkp:S7',
  'bkp:S8',
] as const
export type BibleCheckId = (typeof BIBLE_CHECK_IDS)[number]

export function isBibleCheckId(value: string): value is BibleCheckId {
  return (BIBLE_CHECK_IDS as readonly string[]).includes(value)
}

/**
 * Checks that need the whole file in order: headings between passages (S1)
 * and verses the pack and the file number differently (S8). They run in
 * "Check file" (./scans.ts), never on one cell, so they never make a cell's
 * live check worth loading the pack for.
 */
export const BIBLE_SCAN_CHECK_IDS: readonly BibleCheckId[] = ['bkp:S1', 'bkp:S8']

export function isBibleScanCheckId(id: BibleCheckId): boolean {
  return BIBLE_SCAN_CHECK_IDS.includes(id)
}

/** Design doc §7: W and I. The SPA maps them to its "major" and "minor". */
export type BibleCheckSeverity = 'warning' | 'info'

/**
 * Provisional defaults (design doc §7.1, §7.5) until each check's precision
 * is measured (§10). M1 drops to info for a rhetorical question.
 *
 * AQU-1697: pack A starts at info until it is measured on more than one
 * translation (design doc §10 ship gates), except M3: a dropped negator
 * flips the meaning. An M3 finding where the translation has SOME negation,
 * only less of it, is info.
 */
export const BIBLE_CHECK_DEFAULT_SEVERITY: Readonly<Record<BibleCheckId, BibleCheckSeverity>> = {
  'bkp:V1': 'warning',
  'bkp:V2': 'warning',
  'bkp:V3': 'warning',
  'bkp:V5': 'warning',
  'bkp:V7': 'info',
  'bkp:V8': 'info',
  'bkp:V9': 'info',
  'bkp:M1': 'warning',
  'bkp:N1': 'info',
  'bkp:N2': 'info',
  'bkp:M3': 'warning',
  'bkp:S1': 'info',
  'bkp:S3': 'info',
  'bkp:S6': 'info',
  'bkp:S7': 'info',
  'bkp:S8': 'info',
}

/** The Language-profile slots a Bible data check can wait for. */
export type BibleCheckSlot = Extract<
  LanguageProfileSlot,
  'quoteMarks' | 'questionMarkers' | 'numberWords' | 'negators' | 'headings' | 'textualVariants'
>

/** The Language-profile slots each check needs. A check stays dormant while one of them is empty. */
export const BIBLE_CHECK_NEEDS: Readonly<Record<BibleCheckId, readonly BibleCheckSlot[]>> = {
  'bkp:V1': ['quoteMarks'],
  'bkp:V2': ['quoteMarks'],
  'bkp:V3': ['quoteMarks'],
  'bkp:V5': ['quoteMarks'],
  'bkp:V7': ['quoteMarks'],
  'bkp:V8': ['quoteMarks'],
  'bkp:V9': ['quoteMarks'],
  // AQU-1691: M1's own slot. A language that marks questions only with a
  // question mark saves the slot empty, which switches M1 on.
  'bkp:M1': ['questionMarkers'],
  'bkp:N1': ['numberWords'],
  'bkp:N2': ['numberWords'],
  'bkp:M3': ['negators'],
  'bkp:S1': ['headings'],
  // A sentence can also end with a question marker (Japanese か), so S3
  // waits until the profile says whether the language has any.
  'bkp:S3': ['questionMarkers'],
  'bkp:S6': ['textualVariants'],
  'bkp:S7': ['textualVariants'],
  // Pack verses against the file's verses: nothing about the language.
  'bkp:S8': [],
}

// ── Structural pack inputs ──────────────────────────────────────────────────

/** One speech (an OpenText turn of depth ≥ 2) from `voices/{BOOK}.json`. */
export interface SpeechInput {
  /** "sp:{firstWordId}-{lastWordId}". */
  id: string
  /** First and last Macula word ids; they sort in reading order. */
  from: string
  to: string
  depth: number
  /** Effective quote level: depth − 1 − self-projected ancestors. 0 = no marks. */
  level: number
  parent: string | null
  /** A first-person speech verb projects it ("ἐγὼ δὲ λέγω ὑμῖν ὅτι …"); it adds no quote level. */
  selfProjected: boolean
  speakerConf: number
  speakerSources: readonly string[]
}

/** A run of words with one innermost voice: "narrator" or a speech id. */
export interface VoiceRunInput {
  speech: string
  from: string
  to: string
  opens: boolean
  closes: boolean
}

export interface VoicesLayerInput {
  speeches: readonly SpeechInput[]
  verses: Readonly<Record<string, readonly VoiceRunInput[]>>
}

export interface StructureVerseInput {
  question: boolean
  /** AQU-1697: Macula word ids of the verse's negators (M3) and vocatives. */
  negators?: readonly string[]
  vocatives?: readonly string[]
}

export interface StructureLayerInput {
  verses: Readonly<Record<string, StructureVerseInput>>
  /** AQU-1697: OpenText pericopes (S1), first and last word. */
  segments?: readonly { from: string; to: string; title: string }[]
  /** AQU-1697: OpenText moves, the clause complexes (S3), first and last word. */
  moves?: readonly { from: string; to: string }[]
}

/** AQU-1697: the text layer's words, as the number, negation and sentence checks read them. */
export interface TextWordInput {
  lemma?: string
  gloss?: string
  english?: string
  /** Punctuation and space after the word: "·", ";", ",". */
  after?: string
}

/**
 * AQU-1697: the text layer, or a compact copy of it that keeps the words the
 * checks read (the worker's CompactTextLayer). `verses` lists word ids in
 * reading order; a compact copy lists only the words it keeps.
 */
export interface TextLayerInput {
  verses: Readonly<Record<string, readonly string[]>>
  words: Readonly<Record<string, TextWordInput>>
}

// ── Compiled expectation for one cell ───────────────────────────────────────

/** What one speech means for this cell. */
export interface SpeechExpectation {
  id: string
  /** First and last word of the whole speech, which may lie in other verses. */
  from: string
  to: string
  level: number
  depth: number
  selfProjected: boolean
  /** The speech's first word is in this cell. */
  opens: boolean
  /** Its last word is in this cell. */
  closes: boolean
  /** It neither opens nor closes here: the cell sits inside it. */
  continues: boolean
  /** It is open when the cell starts, and still open when the cell ends. */
  openAtStart: boolean
  openAtEnd: boolean
  /** Another voice interrupts it here, so it closes and reopens: how many closes and reopens fall in this cell. */
  interruptCloses: number
  interruptOpens: number
  interrupted: boolean
  speakerSources: readonly string[]
  speakerConf: number
}

export interface CellExpectation {
  /** USFM book code, e.g. "JHN". */
  book: string
  /** The verses the cell covers, in order. A bridge covers several. */
  refs: readonly string[]
  /**
   * Another cell shares one of these verses (a split verse), or the cell's ref
   * names a part ("JHN 4:9a"). Only verse-level facts are checked, never where a
   * mark should fall.
   */
  approximate: boolean
  /** Speeches touching the cell, outermost first. */
  speeches: readonly SpeechExpectation[]
  /** Quote levels open when the cell starts and when it ends. */
  startDepth: number
  endDepth: number
  /** Some quotation opens, closes or is interrupted inside the cell. */
  boundaries: boolean
  /**
   * The cell ends with lower-level text right after a quotation closes, e.g.
   * the narrator's aside after the woman's question in JHN 4:9. The quotation
   * must close before that text.
   */
  trailingNarration: { closeLevel: number; endLevel: number; speechId: string } | null
  question: {
    /** Some verse in the cell asks a question (Macula: the Greek question mark). */
    expected: boolean
    /**
     * TODO(AQU-1685): true when a Translation Note marks the question as
     * rhetorical. The notes layer has no schema yet, so this is always false;
     * M1 already reports at info severity when it is true.
     */
    rhetorical: boolean
  }
  /** AQU-1697: the numbers the source states (N1, N2). Empty without the text layer. */
  numbers: readonly NumberFact[]
  /** AQU-1697: the source's negations (M3); null when it negates nothing. */
  negation: NegationFact | null
  /**
   * AQU-1697: the source's sentence runs on past the cell's last word: an
   * OpenText move spans it and none ends there (S3).
   */
  continuesPast: boolean
  /** AQU-1697: the cell holds a verse the critical text omits or disputes (S6, S7). */
  variant: VariantFact | null
  /**
   * AQU-1697: false when the pack has none of these verses (MAT 17:21, which
   * the critical text omits). Then only the variant checks have facts to go on.
   */
  inPack: boolean
}

/** AQU-1697: one number the source states. */
export interface NumberFact {
  kind: 'cardinal' | 'ordinal'
  /** The verse it is in. */
  ref: string
  value: number
  /** The value as the Greek words build it, for a translation that writes it word by word: 153 → [100, 50, 3]. */
  parts: readonly number[]
  /** First and last Macula word. */
  from: string
  to: string
  /** ὡς/ὡσεί, "about", stands just before it (design doc N3). */
  approximate: boolean
  /** A lone εἷς: "one", but often "a" or "a certain" in a translation. */
  indefinite: boolean
}

/** AQU-1697: the source's negations in one cell. */
export interface NegationFact {
  /** Negations a translation should keep: οὐ μή counts once, εἰ μή "except" not at all. */
  units: number
  /** The Macula negator words those negations use. */
  words: readonly string[]
  /** The verses with a negation. */
  refs: readonly string[]
}

/** AQU-1697: a verse that some manuscripts leave out. */
export interface VariantFact {
  /** absent: the critical text omits the verse (S6); disputed: it prints the passage in brackets (S7). */
  kind: 'absent' | 'disputed'
  /** The cell's verses that are variants. */
  refs: readonly string[]
  /** The variant verses or the disputed passage, as refs: "MAT 17:21", "JHN 7:53–8:11". */
  passage: string
  /** The cell holds the passage's first verse, so a bracket opens here. */
  opens: boolean
  /** The cell holds the passage's last verse, so the bracket closes here. */
  closes: boolean
  /** The cell also holds verses that are not variants (a bridge), so only part of its text is the variant. */
  partial: boolean
}

// ── Findings ────────────────────────────────────────────────────────────────

/** Why a check fired. The SPA renders each through t(); nothing here is a sentence. */
export type BibleCheckReason =
  | 'open-missing'
  | 'close-missing'
  | 'close-after-aside'
  | 'close-in-continuing-speech'
  | 'wrong-level-marks'
  | 'marks-without-speech'
  | 'interruption-not-marked'
  | 'self-projection-adds-level'
  | 'question-mark-missing'
  // AQU-1697
  | 'number-missing'
  | 'ordinal-missing'
  | 'negation-missing'
  | 'negation-fewer'
  | 'sentence-ends-early'
  | 'variant-not-omitted'
  | 'variant-not-bracketed'
  | 'variant-no-footnote'
  | 'heading-missing'
  | 'heading-inside-pericope'
  | 'verse-not-in-pack'
  | 'pack-verse-without-cell'

/** Where the fact behind a finding comes from. */
export type BibleCheckEvidence =
  | {
      kind: 'speech'
      /** The speech, located as start ref + word number and end ref + word number. */
      speechId: string
      startRef: string
      startWord: number
      endRef: string
      endWord: number
      speakerSources: readonly string[]
      speakerConf: number
    }
  | { kind: 'no-speech'; refs: readonly string[] }
  | { kind: 'question'; refs: readonly string[] }
  // AQU-1697. Each names its verses; the extra fields are pack data, never prose.
  | { kind: 'number'; refs: readonly string[]; startWord: number; endWord: number }
  | { kind: 'negation'; refs: readonly string[] }
  | { kind: 'move'; refs: readonly string[] }
  | { kind: 'variant'; refs: readonly string[]; passage: string }
  | { kind: 'pericope'; refs: readonly string[]; title: string }
  | { kind: 'versification'; refs: readonly string[] }

export interface BibleCheckSpan {
  /** Offsets into the target text: start inclusive, end exclusive. */
  start: number
  end: number
}

export interface BibleCheckFinding {
  code: BibleCheckId
  reason: BibleCheckReason
  /** Values for the localized sentence, e.g. { level: "1" }. Strings only. */
  params: Readonly<Record<string, string>>
  severity: BibleCheckSeverity
  /** The marks at fault. Empty when the problem is a missing mark. */
  spans: readonly BibleCheckSpan[]
  /** The cell shares its verse with another cell, so the fact is verse-level only. */
  approximate: boolean
  evidence: BibleCheckEvidence
}
