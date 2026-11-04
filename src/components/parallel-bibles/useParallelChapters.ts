// Loads the chapter each pinned version needs for the editor's ref.
//
// API kindness: only per-chapter endpoints are used, fetches fire only while
// the panel is open, chapter responses are promise-cached in the helloao client
// (scrolling within a chapter costs zero requests), and the plan is debounced
// so fast scrolling doesn't burst-fetch every chapter passed over. The
// neighbouring chapters are warmed after the visible ones land (AQU-843).
//
// The chapter is per version: a Hebrew-numbered version may need a different
// one (English Malachi 4 is Hebrew Malachi 3), see versification.ts.

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  adjacentChapters,
  fetchHelloaoChapter,
  HelloaoChapterNotFoundError,
  prefetchHelloaoChapter,
  type HelloaoTranslation,
} from "@/lib/parsers/helloao"
import { referencePrefetchAllowed } from "@/lib/net/prefetch-policy"
import { mapEnglishRef, versificationScheme } from "@/lib/parallel-bibles/versification"
import { chapterDataFromResponse, chapterKey, emptyChapterData, type ChapterData } from "./chapter-data"

export interface TrackedRef {
  book: string
  chapter: number
  verse: number | null
}

interface PlanEntry {
  versionId: string
  book: string
  chapter: number
}

function encodePlan(entries: PlanEntry[]): string {
  return entries.map((e) => `${e.versionId}|${e.book}|${e.chapter}`).join(",")
}

function decodePlan(plan: string): PlanEntry[] {
  return (plan ? plan.split(",") : []).map((part) => {
    const [versionId, book, chapter] = part.split("|")
    return { versionId, book, chapter: Number(chapter) }
  })
}

/**
 * The chapters to load: for every pinned version, the chapter each of `refs`
 * falls in under that version's numbering. The panel passes the one tracked
 * verse; the editor passes the first and last verse of every row in view.
 */
export function useParallelChapters(args: {
  open: boolean
  pinned: readonly string[]
  refs: readonly TrackedRef[]
  translationById: ReadonlyMap<string, HelloaoTranslation>
  retryNonce: number
}): {
  chapterData: ReadonlyMap<string, ChapterData>
  forget: (key: string) => void
} {
  const { open, pinned, refs, translationById, retryNonce } = args
  const [chapterData, setChapterData] = useState<Map<string, ChapterData>>(new Map())

  // One "version|BOOK|chapter,…" string, so the debounce and the fetch effect
  // re-run only when some version needs a different chapter.
  const plan = useMemo(() => {
    if (refs.length === 0 || pinned.length === 0) return null
    const seen = new Set<string>()
    const entries: PlanEntry[] = []
    for (const versionId of pinned) {
      const scheme = versificationScheme(translationById.get(versionId)?.language)
      for (const ref of refs) {
        const { chapter } = mapEnglishRef(scheme, ref.book, ref.chapter, ref.verse)
        const key = `${versionId}|${ref.book}|${chapter}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({ versionId, book: ref.book, chapter })
      }
    }
    return encodePlan(entries)
  }, [refs, pinned, translationById])

  const [debouncedPlan, setDebouncedPlan] = useState(plan)
  useEffect(() => {
    if (plan === debouncedPlan) return
    const id = window.setTimeout(() => setDebouncedPlan(plan), 250)
    return () => window.clearTimeout(id)
  }, [plan, debouncedPlan])

  useEffect(() => {
    if (!open || !debouncedPlan) return
    const entries = decodePlan(debouncedPlan)
    let cancelled = false
    const store = (key: string, data: ChapterData) =>
      setChapterData((prev) => {
        // A chapter already loaded stays the same object, so scrolling within
        // loaded chapters re-renders nothing.
        const had = prev.get(key)
        if (had && !had.error && !data.error) return prev
        const next = new Map(prev)
        next.set(key, data)
        return next
      })

    const loads = entries.map(({ versionId, book, chapter }) =>
      fetchHelloaoChapter(versionId, book, chapter)
        .then((res) => {
          if (cancelled) return null
          store(chapterKey(versionId, book, chapter), chapterDataFromResponse(res))
          return { versionId, book, chapter, numberOfChapters: res.book?.numberOfChapters }
        })
        .catch((err) => {
          if (cancelled) return null
          // A version that simply doesn't carry this chapter is an absence, not
          // a failure: it lands as an empty chapter and renders "no text".
          const missing = err instanceof HelloaoChapterNotFoundError
          store(
            chapterKey(versionId, book, chapter),
            emptyChapterData(missing ? undefined : err instanceof Error ? err.message : String(err)),
          )
          return null
        }),
    )

    // AQU-843: warm the chapters either side once the visible ones landed, so
    // crossing a chapter boundary mid-scroll reads from cache. Ordered after
    // the visible fetches: a preload never competes with the text in view.
    void Promise.all(loads).then((results) => {
      if (cancelled || !referencePrefetchAllowed()) return
      for (const res of results) {
        if (!res?.numberOfChapters) continue
        for (const target of adjacentChapters(res.chapter, res.numberOfChapters)) {
          prefetchHelloaoChapter(res.versionId, res.book, target)
        }
      }
    })

    return () => {
      cancelled = true
    }
  }, [open, debouncedPlan, retryNonce])

  const forget = useCallback((key: string) =>
    setChapterData((prev) => {
      const next = new Map(prev)
      next.delete(key)
      return next
    }), [])

  return { chapterData, forget }
}
