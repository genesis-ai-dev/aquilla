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

/** The checks in this slice. Finding codes, `algorithmicChecks` keys and built-in rule ids all use these. */
export const BIBLE_CHECK_IDS = [
  'bkp:V1',
  'bkp:V2',
  'bkp:V3',
  'bkp:V5',
  'bkp:V7',
  'bkp:V8',
  'bkp:V9',
  'bkp:M1',
] as const
export type BibleCheckId = (typeof BIBLE_CHECK_IDS)[number]

export function isBibleCheckId(value: string): value is BibleCheckId {
  return (BIBLE_CHECK_IDS as readonly string[]).includes(value)
}

/** Design doc §7: W and I. The SPA maps them to its "major" and "minor". */
export type BibleCheckSeverity = 'warning' | 'info'

/**
 * Provisional defaults (design doc §7.1, §7.5) until each check's precision
 * is measured (§10). M1 drops to info for a rhetorical question.
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
}

/** The Language-profile slots each check needs. A check stays dormant while one of them is empty. */
export const BIBLE_CHECK_NEEDS: Readonly<Record<BibleCheckId, readonly LanguageProfileSlot[]>> = {
  'bkp:V1': ['quoteMarks'],
  'bkp:V2': ['quoteMarks'],
  'bkp:V3': ['quoteMarks'],
  'bkp:V5': ['quoteMarks'],
  'bkp:V7': ['quoteMarks'],
  'bkp:V8': ['quoteMarks'],
  'bkp:V9': ['quoteMarks'],
  // TODO(AQU-1691): M1's own slot is the question markers. Until that slot
  // exists, M1 waits for the quotation marks like the rest of this family, so
  // a project that has not set up its Language profile sees none of them.
  'bkp:M1': ['quoteMarks'],
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

export interface StructureLayerInput {
  verses: Readonly<Record<string, { question: boolean }>>
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
