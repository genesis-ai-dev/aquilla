// Pull one verse (or a verse range) out of a USFM book (AQU-1573).
//
// The reference-Bible resolver stores each version as per-book USFM in R2 (see
// db/shared/reference-bibles.ts). To quote Isaiah 40:25 from Van Dyck we need
// exactly that verse's text out of ISA.usfm — not the chapter, not the markers.
//
// This is NOT a USFM parser. src/lib/parsers/usfm.ts is, and it is the right
// tool for importing a book into cells: it carries structure, alignment, cell
// ids and the whole TranslatableString contract. Here the job is the opposite
// shape — read-only, one verse, in a Worker, from a file that may be megabytes —
// so this walks the `\c` / `\v` markers directly and returns plain text.
//
// Constraints for anything added here — SAME contract as ./prompt-build.ts (the
// resolver that calls it runs in sync-worker):
//   - NO `@/` path aliases, transitively.
//   - NO DOM, no `import.meta.env`, no storage access, no i18n.
//   - Pure functions only.

/** Character-level markers whose CONTENT is part of the verse text. */
const INLINE_CONTENT_MARKERS = /\\\+?(?:nd|add|wj|qt|bk|tl|k|w|sls|pn|sig|em|bd|it|bdit|no|sc|ord)\*?/g

/** Markers whose content is NOT verse text — notes, cross-refs, figures. */
const NOTE_SPANS = /\\(?:f|fe|x|ef|ex|fig)\b[\s\S]*?\\(?:f|fe|x|ef|ex|fig)\*/g

/** Milestones and attribute payloads (`\zaln-s |x-strong="…"\*`, `|lemma="…"`). */
const MILESTONES = /\\[a-z]+-[se]\b[^\\]*?\\\*/gi

/** Any remaining paragraph/character marker left over after the above. */
const RESIDUAL_MARKERS = /\\\+?[a-z][a-z0-9]*\*?/gi

/**
 * Strip USFM markup from one verse's raw text, leaving the words a reader sees.
 *
 * Order matters: notes and milestones are removed WITH their content first, then
 * the markers whose content survives, then anything left. Attribute payloads
 * after a `|` inside a word span (`\w grace|strong="G5485"\w*`) are dropped —
 * they are metadata, never reading text.
 */
export function stripUsfmMarkup(raw: string): string {
  return raw
    .replace(NOTE_SPANS, " ")
    .replace(MILESTONES, " ")
    .replace(/\|[^\\]*?(?=\\)/g, "")
    .replace(INLINE_CONTENT_MARKERS, " ")
    .replace(RESIDUAL_MARKERS, " ")
    .replace(/[\s\u00a0]+/g, " ")
    .trim()
}

export interface ExtractVerseArgs {
  /** The whole book's USFM. */
  usfm: string
  chapter: number
  /** First verse to collect. */
  verseStart: number
  /** Last verse to collect; equal to `verseStart` for a single verse. */
  verseEnd?: number
}

/**
 * The reading text of `chapter:verseStart[-verseEnd]`, or null when the book
 * does not carry it.
 *
 * Verse numbers in the wild are not plain integers: `\v 25a`, `\v 25-26` and
 * `\v 25,26` all occur. A marker is taken to cover every verse number it names,
 * so a range request collects a bridged verse once and a request for either half
 * of `\v 25-26` gets the bridge. Partial-verse letters are ignored for matching
 * (`25a` IS verse 25) because a citation never names them.
 */
export function extractVerseText(args: ExtractVerseArgs): string | null {
  const { usfm, chapter, verseStart } = args
  const verseEnd = Math.max(verseStart, args.verseEnd ?? verseStart)
  if (!usfm || chapter < 1 || verseStart < 1) return null

  const chapterText = extractChapterText(usfm, chapter)
  if (chapterText === null) return null

  const collected: string[] = []
  const verseRe = /\\v[\s\u00a0]+([0-9]+[a-z]?(?:[-,\u2013][0-9]+[a-z]?)*)[\s\u00a0]*/g
  let match = verseRe.exec(chapterText)
  while (match) {
    const numbers = verseNumbers(match[1])
    const bodyStart = match.index + match[0].length
    const next = verseRe.exec(chapterText)
    const body = chapterText.slice(bodyStart, next ? next.index : undefined)
    if (numbers.some((n) => n >= verseStart && n <= verseEnd)) {
      const text = stripUsfmMarkup(body)
      if (text) collected.push(text)
    }
    match = next
  }

  if (!collected.length) return null
  return collected.join(" ")
}

/** Every verse number a `\v` argument names: "25" → [25]; "25-27" → [25,26,27]. */
function verseNumbers(argument: string): number[] {
  const parts = argument.split(/[,\u2013-]/).map((p) => Number.parseInt(p, 10))
  const clean = parts.filter((n) => Number.isFinite(n) && n > 0)
  if (clean.length < 2) return clean
  const [first, last] = [clean[0], clean[clean.length - 1]]
  if (last <= first) return clean
  const all: number[] = []
  for (let n = first; n <= last; n++) all.push(n)
  return all
}

/**
 * The slice of `usfm` belonging to `chapter` — from its `\c` marker to the next
 * one. Returns null when the book has no such chapter, so a citation of a
 * chapter the version does not carry reads as "no text" rather than as the
 * wrong chapter's text.
 */
export function extractChapterText(usfm: string, chapter: number): string | null {
  const chapterRe = /\\c[\s\u00a0]+([0-9]+)/g
  let match = chapterRe.exec(usfm)
  while (match) {
    const number = Number.parseInt(match[1], 10)
    const bodyStart = match.index + match[0].length
    const next = chapterRe.exec(usfm)
    if (number === chapter) {
      return usfm.slice(bodyStart, next ? next.index : undefined)
    }
    match = next
  }
  return null
}
