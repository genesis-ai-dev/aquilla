/**
 * TaBiThA verse briefs for the Verse Resources panel.
 *
 * A cold verse can take ~35s upstream (warm ~3s), so briefs are promise-cached
 * for the tab's lifetime — scrolling back to a verse never refetches — and a
 * rejected fetch is evicted so the next visit retries.
 */

import { tabithaVerseBrief, type TabithaVerseBrief } from "@/lib/aquifer/client"

export interface VerseRef {
  book: string
  chapter: number
  verse: number
}

/** Aquifer passage path ("/en/passages/ACT/10/9/") → { book, chapter, verse }. */
export function verseRefFromPassagePath(path: string): VerseRef | null {
  const m = /\/passages\/([A-Z0-9]{2,4})\/(\d+)\/(\d+)\/?$/.exec(path)
  if (!m) return null
  return { book: m[1], chapter: Number(m[2]), verse: Number(m[3]) }
}

const briefCache = new Map<string, Promise<TabithaVerseBrief>>()

export function loadVerseBrief(
  jwt: string,
  projectId: string,
  ref: VerseRef,
): Promise<TabithaVerseBrief> {
  const key = `${ref.book} ${ref.chapter}:${ref.verse}`
  const cached = briefCache.get(key)
  if (cached) return cached
  const promise = tabithaVerseBrief(jwt, projectId, ref).catch((err) => {
    briefCache.delete(key)
    throw err
  })
  briefCache.set(key, promise)
  return promise
}

/** Test seam. */
export function __resetVerseBriefCache(): void {
  briefCache.clear()
}
