import { v7 as uuidv7 } from "uuid"
import { proxyOrigin } from "@/lib/net/resource-proxy"
import type { TranslatableString } from "./types"

// Client for the Free Use Bible API (bible.helloao.org) — AO Lab's free,
// keyless, CORS-open JSON API. Two consumers:
//   1. Import: one bulk `complete.json` fetch per translation (never
//      per-chapter fan-out), filtered client-side to the selected books.
//   2. Translator's helps sidebar: per-chapter fetches, cached per
//      (translation, book, chapter) so scrolling within a chapter is free.
// Routed through the same-origin resource proxy when configured (AQU-627);
// transparent no-op when VITE_RESOURCES_BASE is unset.
const API_BASE = `${proxyOrigin("https://bible.helloao.org")}/api`

export interface HelloaoTranslation {
  id: string // e.g. "BSB"
  name: string
  englishName: string
  shortName: string
  language: string // ISO 639-3
  languageName: string
  languageEnglishName: string
  textDirection: string
  licenseUrl: string
  website: string
  numberOfBooks: number
  totalNumberOfChapters: number
  totalNumberOfVerses: number
}

export interface HelloaoBook {
  id: string // USFM book code, e.g. "GEN"
  name: string
  commonName: string
  order: number
  numberOfChapters: number
  totalNumberOfVerses: number
}

// Chapter content nodes per https://bible.helloao.org/docs/reference/.
// Verse/heading content mixes plain strings with formatted-text objects
// ({text, poem?, wordsOfJesus?, ...}), footnote refs ({noteId}) and inline
// line breaks ({lineBreak: true}).
type InlineContent =
  | string
  | { text: string; [key: string]: unknown }
  | { noteId: number }
  | { lineBreak: boolean }
  | { heading: string }

export type HelloaoChapterNode =
  | { type: "verse"; number: number; content: InlineContent[] }
  | { type: "heading"; content: InlineContent[] }
  | { type: "hebrew_subtitle"; content: InlineContent[] }
  | { type: "line_break" }

export interface HelloaoChapter {
  number: number
  content: HelloaoChapterNode[]
}

export interface HelloaoCompleteBook extends HelloaoBook {
  chapters: { chapter: HelloaoChapter }[]
}

export interface HelloaoComplete {
  translation: HelloaoTranslation
  books: HelloaoCompleteBook[]
}

let translationsCache: HelloaoTranslation[] | null = null

export async function fetchHelloaoTranslations(): Promise<HelloaoTranslation[]> {
  if (translationsCache) return translationsCache
  const res = await fetch(`${API_BASE}/available_translations.json`)
  if (!res.ok) {
    throw new Error(`Failed to fetch Hello AO translations list (${res.status})`)
  }
  const data = (await res.json()) as { translations: HelloaoTranslation[] }
  translationsCache = data.translations
  return translationsCache
}

export function __setHelloaoTranslationsCacheForTest(
  cache: HelloaoTranslation[] | null
): void {
  translationsCache = cache
}

export async function fetchHelloaoBooks(
  translationId: string,
  signal?: AbortSignal
): Promise<HelloaoBook[]> {
  const res = await fetch(`${API_BASE}/${translationId}/books.json`, { signal })
  if (!res.ok) {
    throw new Error(`Failed to fetch book list for '${translationId}' (${res.status})`)
  }
  const data = (await res.json()) as { books: HelloaoBook[] }
  return data.books
}

// Streams the whole-translation bulk endpoint with byte progress (mirrors
// ebible.ts fetchTranslationText). totalBytes is 0 without a Content-Length.
export async function fetchHelloaoComplete(
  translationId: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal
): Promise<HelloaoComplete> {
  const res = await fetch(`${API_BASE}/${translationId}/complete.json`, { signal })
  if (!res.ok) {
    throw new Error(`Failed to download translation '${translationId}' (${res.status})`)
  }

  if (!res.body || !onProgress) {
    return (await res.json()) as HelloaoComplete
  }

  const total = Number(res.headers.get("Content-Length") ?? 0)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let received = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    chunks.push(decoder.decode(value, { stream: true }))
    onProgress(received, total)
  }
  chunks.push(decoder.decode())
  return JSON.parse(chunks.join("")) as HelloaoComplete
}

export interface HelloaoChapterResponse {
  translation: HelloaoTranslation
  book: HelloaoBook
  chapter: HelloaoChapter
}

const chapterCache = new Map<string, Promise<HelloaoChapterResponse>>()

// Per-chapter fetch for the helps sidebar. Cached by promise so concurrent
// callers for the same chapter share one request; failed fetches are evicted
// so a transient error doesn't poison the cache.
export function fetchHelloaoChapter(
  translationId: string,
  book: string,
  chapter: number,
  signal?: AbortSignal
): Promise<HelloaoChapterResponse> {
  const key = `${translationId}/${book}/${chapter}`
  const cached = chapterCache.get(key)
  if (cached) return cached

  const promise = (async () => {
    const res = await fetch(`${API_BASE}/${translationId}/${book}/${chapter}.json`, { signal })
    if (!res.ok) {
      throw new Error(`Failed to fetch ${key} (${res.status})`)
    }
    return (await res.json()) as HelloaoChapterResponse
  })()
  chapterCache.set(key, promise)
  promise.catch(() => chapterCache.delete(key))
  return promise
}

/** Flatten a verse/heading content array to plain text: strings pass through,
 *  formatted-text objects contribute their `text`, footnote refs and inline
 *  line breaks are dropped. */
export function flattenHelloaoContent(content: InlineContent[]): string {
  const parts: string[] = []
  for (const piece of content) {
    if (typeof piece === "string") {
      parts.push(piece)
    } else if ("text" in piece && typeof piece.text === "string") {
      parts.push(piece.text)
    }
    // {noteId} and {lineBreak} carry no translatable text.
  }
  return parts.join(" ").replace(/\s+/g, " ").trim()
}

/** Verse refs for the cells of one parsed chapter, in document order. */
export function parseHelloaoChapterStrings(
  bookId: string,
  chapter: HelloaoChapter
): TranslatableString[] {
  const section = `${bookId} ${chapter.number}`
  const out: TranslatableString[] = []
  for (const node of chapter.content) {
    if (node.type === "verse") {
      const text = flattenHelloaoContent(node.content)
      if (!text) continue
      const ref = `${bookId} ${chapter.number}:${node.number}`
      out.push({
        id: uuidv7(),
        original: text,
        translated: "",
        context: ref,
        group: ref,
        section,
        globalReferences: [ref],
        type: "verse",
      })
    } else if (node.type === "heading" || node.type === "hebrew_subtitle") {
      const text = flattenHelloaoContent(node.content)
      if (!text) continue
      out.push({
        id: uuidv7(),
        original: text,
        translated: "",
        context: section,
        group: section,
        section,
        type: "heading",
      })
    }
    // line_break nodes carry no text.
  }
  return out
}

/**
 * Convert a bulk `complete.json` payload to translatable cells, restricted to
 * `selectedBooks` (USFM codes; null/empty = all books). Books keep API order.
 */
export function parseHelloaoComplete(
  complete: HelloaoComplete,
  selectedBooks?: ReadonlySet<string> | null
): TranslatableString[] {
  const out: TranslatableString[] = []
  const books = [...complete.books].sort((a, b) => a.order - b.order)
  for (const book of books) {
    if (selectedBooks && selectedBooks.size > 0 && !selectedBooks.has(book.id)) continue
    for (const entry of book.chapters) {
      out.push(...parseHelloaoChapterStrings(book.id, entry.chapter))
    }
  }
  return out
}
