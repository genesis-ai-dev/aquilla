// AQU-2426: find a recording's lines from its words — "at sentence ends and real
// pauses" (board 58, Split into lines… › At sentences, with words, and Import
// and transcribe…).
//
// The words come back from transcription with their times. A line ends after a
// word that ends a sentence, or at a real pause even mid-sentence (a reader who
// stops for a second and a half has ended a line), and a line that would run
// longer than half a minute is cut at its longest pause between words, so no
// line is too long to dub. Each cut sits halfway through the gap between the
// two words, and the lines tile the whole recording ("cuts, not deletions",
// tile-segments.ts): the first starts at 0 and the last ends at its end.

export interface TimedWord {
  text: string
  /** Seconds from the start of the recording (or the line being split). */
  start: number
  end: number
  /** AQU-2426 (review, Nov 9): the word as the transcription heard it, when a
   *  learned correction changed it. Absent: `text` is what was heard. */
  heard?: string
}

export interface WordLine {
  startSec: number
  endSec: number
  text: string
  words: TimedWord[]
}

export interface LinesFromWordsOptions {
  /** A gap this long ends a line even mid-sentence. */
  longPauseSec?: number
  /** A line longer than this is cut again at its longest gap. */
  maxLineSec?: number
}

const DEFAULTS = { longPauseSec: 1.5, maxLineSec: 30 }

/** Sentence-final punctuation across scripts, before closing quotes/brackets. */
const SENTENCE_END = /[.!?…。！？؟۔।॥።፧]["'”’»)\]」』]*$/u

export function endsSentence(word: string): boolean {
  return SENTENCE_END.test(word.trim())
}

/** Scripts written without spaces between words. */
const NO_SPACE_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u

/** Join words into a line's text, with spaces where the script uses them. */
export function joinWords(words: readonly { text: string }[]): string {
  let out = ""
  for (const w of words) {
    const raw = w.text
    const text = raw.trim()
    if (!text) continue
    if (!out) { out = text; continue }
    const leadingSpace = /^\s/.test(raw)
    const noSpace = NO_SPACE_SCRIPT.test(out.slice(-1)) && NO_SPACE_SCRIPT.test(text[0])
    const attachesLeft = /^[,.;:!?…)\]」』'"”’»%،؛。、！？]/u.test(text)
    out += (leadingSpace || (!noSpace && !attachesLeft)) ? ` ${text}` : text
  }
  return out.replace(/\s+/g, " ").trim()
}

/**
 * Lines from timed words over a recording `durationSec` long. No words → one
 * line covering it all, with no text.
 */
export function linesFromWords(
  input: readonly TimedWord[],
  durationSec: number,
  opts: LinesFromWordsOptions = {},
): WordLine[] {
  const o = { ...DEFAULTS, ...opts }
  const words = input
    .filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ ...w, end: Math.max(w.start, w.end) }))
    .sort((a, b) => a.start - b.start)
  const total = Math.max(durationSec, words.length ? words[words.length - 1].end : 0)
  if (words.length === 0) return [{ startSec: 0, endSec: total, text: "", words: [] }]

  // Group the words: a group ends after a sentence end or before a long pause.
  const groups: TimedWord[][] = [[]]
  for (const [i, w] of words.entries()) {
    groups[groups.length - 1].push(w)
    const next = words[i + 1]
    if (!next) break
    const gap = next.start - w.end
    if (endsSentence(w.text) || gap >= o.longPauseSec) groups.push([])
  }
  // A group longer than the longest line is cut at its longest gap, again and
  // again, until every part fits (or is one word).
  const fitted: TimedWord[][] = []
  const fit = (group: TimedWord[]) => {
    const span = group[group.length - 1].end - group[0].start
    if (span <= o.maxLineSec || group.length < 2) {
      fitted.push(group)
      return
    }
    let at = 1
    let widest = -Infinity
    for (let i = 1; i < group.length; i++) {
      const gap = group[i].start - group[i - 1].end
      if (gap > widest) { widest = gap; at = i }
    }
    fit(group.slice(0, at))
    fit(group.slice(at))
  }
  for (const group of groups) if (group.length) fit(group)

  return fitted.map((group, i) => {
    const prev = fitted[i - 1]
    const next = fitted[i + 1]
    const startSec = prev ? (prev[prev.length - 1].end + group[0].start) / 2 : 0
    const endSec = next ? (group[group.length - 1].end + next[0].start) / 2 : total
    return { startSec, endSec, text: joinWords(group), words: group }
  })
}
