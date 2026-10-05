// AQU-1573: shared shapes for the reference Bible feature.
//
// Everything under src/lib/reference-bible/ is written WITHOUT the `@/` path
// alias so the SPA, sync-worker and auth-worker (which has no alias at all)
// import the same files: the reference finder, the quote check and the lane
// resolver must agree byte for byte between the editor, the agent and the
// Agent API.

/**
 * One contiguous passage: a verse, a range inside a chapter, or a range that
 * crosses into a later chapter. A verse list ("John 3:16, 18") becomes one
 * ScriptureRef per contiguous run, so every consumer deals with simple ranges.
 * `endChapter === chapter` for a range inside one chapter.
 */
export interface ScriptureRef {
  /** USFM book code, e.g. "ISA", "1CO". */
  book: string
  chapter: number
  verseStart: number
  endChapter: number
  verseEnd: number
}

/** A reference found in prose, with where it sits in the text. */
export interface FoundReference {
  ref: ScriptureRef
  /** Wire form, e.g. "ISA 40:25", "JHN 3:16-18", "JHN 3:16-4:2". */
  canonical: string
  /** Reader form, e.g. "Isaiah 40:25", "John 3:16–18". */
  label: string
  /** UTF-16 offsets of the reference text in the source (end exclusive). */
  start: number
  end: number
  /** True when a long range was cut to the per-reference verse cap. */
  truncated?: boolean
}

export interface ReferenceVerse {
  chapter: number
  verse: number
  text: string
}

/** The verses of one reference, as looked up in one Bible. */
export interface ReferencePassage {
  canonical: string
  label: string
  verses: ReferenceVerse[]
  /** True when the passage holds more verses than were returned. */
  truncated?: boolean
}

/** One installed Bible, as listed to the Settings card and the Agent API. */
export interface ReferenceBibleSummary {
  id: string
  name: string
  fullName: string
  /** BCP-47 code ("ar", "en"), comparable with the project's lane languages. */
  languageCode: string
  languageName: string
  direction: "ltr" | "rtl"
  /** Verse numbering scheme. Every built-in text so far uses "eng" (KJV). */
  versification: string
  printing: string | null
  license: string
  source: string
  verseCount: number
}

/** One verse row as it is stored and as the loader takes it. */
export interface ReferenceVerseRow {
  book: string
  chapter: number
  verse: number
  text: string
}
