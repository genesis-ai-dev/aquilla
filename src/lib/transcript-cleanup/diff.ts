// What a cleanup changed, drawn over what speech recognition heard.
//
// The Transcribe lens used to say "Cleaned up · 5 changes" and leave the
// person to find them. This is the diff the row draws instead: the heard text
// with what was taken out struck through and what was put in beside it.
//
// Two views of one comparison:
//   - `diffWriting` — a finished transcript against the heard text.
//   - `diffWhileWriting` — the same while the cleanup is still streaming. A
//     plain diff of half a reply against the whole heard text would show every
//     word the model has not reached yet as deleted, so the first token would
//     strike the whole line out. Instead the reply so far is lined up with
//     only as much of the heard text as it has covered, and the rest is handed
//     back as `pending`, untouched.
//
// Words are compared exactly: a capital letter, an accent or a full stop is a
// change, because orthography is what a cleanup is for.

/** A run of characters inside a changed word; `changed` marks the characters
 *  that actually differ, so "kitsi → kitsí" points at the one letter. */
export interface DiffPiece {
  text: string
  changed: boolean
}

export type DiffChunk =
  | { kind: "same"; text: string }
  /** Words taken out (`del`) and the words put in their place (`ins`). Either
   *  side may be empty: a pure deletion or a pure insertion. */
  | { kind: "change"; del: DiffPiece[]; ins: DiffPiece[] }

const wordsOf = (s: string): string[] => s.trim().split(/\s+/).filter(Boolean)

/** Longest-common-subsequence table for two sequences. */
function lcsTable<T>(a: readonly T[], b: readonly T[]): Uint16Array[] {
  const table: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  return table
}

/** Characters two words share in order, as a share of their combined length. */
function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const x = [...a.toLowerCase()]
  const y = [...b.toLowerCase()]
  return (2 * lcsTable(x, y)[0][0]) / (x.length + y.length)
}

/** Below this, two runs of words are simply different words: marking the odd
 *  shared letter inside them would be noise. */
const CHAR_DETAIL_MIN_SIMILARITY = 0.5

/** Split a replaced run into the characters that changed and the ones kept. */
function pieces(del: string, ins: string): { del: DiffPiece[]; ins: DiffPiece[] } {
  if (!del) return { del: [], ins: [{ text: ins, changed: true }] }
  if (!ins) return { del: [{ text: del, changed: true }], ins: [] }
  if (similarity(del, ins) < CHAR_DETAIL_MIN_SIMILARITY) {
    return { del: [{ text: del, changed: true }], ins: [{ text: ins, changed: true }] }
  }
  const a = [...del]
  const b = [...ins]
  const table = lcsTable(a, b)
  const outDel: DiffPiece[] = []
  const outIns: DiffPiece[] = []
  const push = (out: DiffPiece[], text: string, changed: boolean) => {
    const last = out[out.length - 1]
    if (last && last.changed === changed) last.text += text
    else out.push({ text, changed })
  }
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      push(outDel, a[i++], false)
      push(outIns, b[j++], false)
    } else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) {
      push(outIns, b[j++], true)
    } else {
      push(outDel, a[i++], true)
    }
  }
  return { del: outDel, ins: outIns }
}

function diffWordLists(before: readonly string[], after: readonly string[]): DiffChunk[] {
  const table = lcsTable(before, after)
  const chunks: DiffChunk[] = []
  let same: string[] = []
  let del: string[] = []
  let ins: string[] = []
  const flushSame = () => {
    if (same.length) chunks.push({ kind: "same", text: same.join(" ") })
    same = []
  }
  const flushChange = () => {
    if (del.length > 0 && del.length === ins.length) {
      // Word for word: each respelled word is its own change, so the eye
      // pairs "yesu" with "Yesu" rather than one long run with another.
      del.forEach((word, k) => chunks.push({ kind: "change", ...pieces(word, ins[k]) }))
    } else if (del.length || ins.length) {
      chunks.push({ kind: "change", ...pieces(del.join(" "), ins.join(" ")) })
    }
    del = []
    ins = []
  }
  let i = 0
  let j = 0
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      flushChange()
      same.push(before[i])
      i++
      j++
    } else if (j < after.length && (i === before.length || table[i][j + 1] >= table[i + 1][j])) {
      flushSame()
      ins.push(after[j++])
    } else {
      flushSame()
      del.push(before[i++])
    }
  }
  flushSame()
  flushChange()
  return chunks
}

/** The finished comparison: what was heard against what is written now. */
export function diffWriting(heard: string, written: string): DiffChunk[] {
  return diffWordLists(wordsOf(heard), wordsOf(written))
}

/** Whether a diff shows any change at all. */
export function hasChanges(chunks: readonly DiffChunk[]): boolean {
  return chunks.some((chunk) => chunk.kind === "change")
}

const DETAILED_PAIRS_MAX = 6_000

export interface StreamingDiff {
  chunks: DiffChunk[]
  /** The heard words the reply has not reached yet, to draw unmarked. */
  pending: string
}

/**
 * How many heard words the reply so far has covered: the prefix of the heard
 * text that is cheapest to turn into what has been written (edit distance,
 * where a respelled word costs less than an unrelated one). A tie goes to the
 * prefix closest in length to the reply, so a reply that has only repeated the
 * heard words so far covers exactly that many.
 */
function coveredWords(heard: readonly string[], written: readonly string[]): number {
  if (written.length === 0) return 0
  // Comparing letters for every pair of words is fine for a take (a sentence
  // or two, redone on every token) and too much for a long recording.
  const detailed = heard.length * written.length <= DETAILED_PAIRS_MAX
  const cost = (a: string, b: string) => (detailed ? 1 - similarity(a, b) : a === b ? 0 : 1)
  let prev = Float64Array.from({ length: heard.length + 1 }, (_, j) => j)
  for (let i = 1; i <= written.length; i++) {
    const row = new Float64Array(heard.length + 1)
    row[0] = i
    for (let j = 1; j <= heard.length; j++) {
      const swap = prev[j - 1] + cost(written[i - 1], heard[j - 1])
      row[j] = Math.min(swap, prev[j] + 1, row[j - 1] + 1)
    }
    prev = row
  }
  let best = 0
  for (let j = 1; j <= heard.length; j++) {
    const better = prev[j] < prev[best] - 1e-9
    const tied = Math.abs(prev[j] - prev[best]) <= 1e-9
    if (better || (tied && Math.abs(j - written.length) < Math.abs(best - written.length))) best = j
  }
  return best
}

/**
 * The comparison while the cleanup is still being written. `written` is the
 * reply so far. Its last word is left out until the next one starts: it may be
 * half a word, and half a word would flash as a change and then heal.
 */
export function diffWhileWriting(heard: string, written: string): StreamingDiff {
  const heardWords = wordsOf(heard)
  const writtenWords = wordsOf(written)
  if (writtenWords.length > 0 && !/\s$/.test(written)) writtenWords.pop()
  const covered = coveredWords(heardWords, writtenWords)
  return {
    chunks: diffWordLists(heardWords.slice(0, covered), writtenWords),
    pending: heardWords.slice(covered).join(" "),
  }
}
