// What one Bible column shows on one editor row. Pure: reads the loaded
// chapters and lines the row's verses up through versification.ts.

import type { HelloaoTranslation } from "@/lib/parsers/helloao"
import type { RowScripture } from "@/lib/parallel-bibles/row-verses"
import {
  alignVersion,
  mapEnglishRef,
  versificationScheme,
  type ChapterShape,
  type VersificationNote,
} from "@/lib/parallel-bibles/versification"
import { chapterKey, type ChapterData } from "./chapter-data"

export type BibleCell =
  | { state: "loading" }
  | { state: "error"; message: string; key: string }
  | { state: "text"; verses: { number: number; text: string }[]; note: VersificationNote | null }
  | { state: "missing"; ref: string; note: VersificationNote | null }
  | { state: "continued" }

export type ReferenceShape = ChapterShape & { versionId: string; versionLabel: string }

const usable = (data: ChapterData | undefined): data is ChapterData =>
  !!data && !data.error && data.shape.verseCount > 0

/**
 * The yardstick the psalm-title and verse-count checks compare against: the
 * first English-numbered version that has this chapter (a Greek New
 * Testament pinned first has no Psalms to compare).
 */
export function referenceShape(
  pinned: readonly string[],
  byId: ReadonlyMap<string, HelloaoTranslation>,
  chapterData: ReadonlyMap<string, ChapterData>,
  book: string,
  chapter: number,
  label: (id: string) => string,
): ReferenceShape | undefined {
  for (const id of pinned) {
    if (versificationScheme(byId.get(id)?.language) !== "english") continue
    const data = chapterData.get(chapterKey(id, book, chapter))
    if (usable(data)) return { ...data.shape, versionId: id, versionLabel: label(id) }
  }
  return undefined
}

export function resolveBibleCell(args: {
  versionId: string
  meta: HelloaoTranslation | undefined
  row: RowScripture
  chapterData: ReadonlyMap<string, ChapterData>
  reference: ReferenceShape | undefined
}): BibleCell {
  const { versionId, meta, row, chapterData, reference } = args
  if (row.kind === "continued") return { state: "continued" }
  const scheme = versificationScheme(meta?.language)
  const verses: { number: number; text: string }[] = []
  let note: VersificationNote | null = null
  let lastRef = ""
  for (let v = row.from; v <= row.to; v++) {
    const mapped = mapEnglishRef(scheme, row.book, row.chapter, v)
    const key = chapterKey(versionId, row.book, mapped.chapter)
    const data = chapterData.get(key)
    if (!data) return { state: "loading" }
    if (data.error) return { state: "error", message: data.error, key }
    const alignment = alignVersion({
      scheme,
      book: row.book,
      chapter: row.chapter,
      verse: v,
      loaded: usable(data) ? data.shape : undefined,
      reference: reference && { ...reference, isSelf: reference.versionId === versionId },
    })
    note ??= alignment.note
    lastRef = `${row.book} ${alignment.chapter}:${alignment.verse ?? v}`
    const text = alignment.verse !== null ? data.verses.get(alignment.verse) : undefined
    if (text) verses.push({ number: alignment.verse ?? v, text })
  }
  return verses.length > 0 ? { state: "text", verses, note } : { state: "missing", ref: lastRef, note }
}
