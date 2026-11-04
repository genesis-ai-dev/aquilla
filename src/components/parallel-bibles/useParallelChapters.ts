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

import { useEffect, useMemo, useState } from "react"
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
  chapter: number
}

function encodePlan(book: string, entries: PlanEntry[]): string {
  return `${book}|${entries.map((e) => `${e.versionId}:${e.chapter}`).join(",")}`
}

function decodePlan(plan: string): { book: string; entries: PlanEntry[] } {
  const [book, rest] = plan.split("|")
  const entries = (rest ? rest.split(",") : []).map((part) => {
    const at = part.lastIndexOf(":")
    return { versionId: part.slice(0, at), chapter: Number(part.slice(at + 1)) }
  })
  return { book, entries }
}

export function useParallelChapters(args: {
  open: boolean
  pinned: readonly string[]
  tracked: TrackedRef | null
  translationById: ReadonlyMap<string, HelloaoTranslation>
  retryNonce: number
}): {
  chapterData: ReadonlyMap<string, ChapterData>
  forget: (key: string) => void
} {
  const { open, pinned, tracked, translationById, retryNonce } = args
  const [chapterData, setChapterData] = useState<Map<string, ChapterData>>(new Map())

  // One "BOOK|version:chapter,…" string, so the debounce and the fetch effect
  // re-run only when some version needs a different chapter.
  const plan = useMemo(() => {
    if (!tracked || pinned.length === 0) return null
    const entries = pinned.map((versionId) => {
      const scheme = versificationScheme(translationById.get(versionId)?.language)
      const mapped = mapEnglishRef(scheme, tracked.book, tracked.chapter, tracked.verse)
      return { versionId, chapter: mapped.chapter }
    })
    return encodePlan(tracked.book, entries)
  }, [tracked, pinned, translationById])

  const [debouncedPlan, setDebouncedPlan] = useState(plan)
  useEffect(() => {
    if (plan === debouncedPlan) return
    const id = window.setTimeout(() => setDebouncedPlan(plan), 250)
    return () => window.clearTimeout(id)
  }, [plan, debouncedPlan])

  useEffect(() => {
    if (!open || !debouncedPlan) return
    const { book, entries } = decodePlan(debouncedPlan)
    let cancelled = false
    const store = (key: string, data: ChapterData) =>
      setChapterData((prev) => {
        const next = new Map(prev)
        next.set(key, data)
        return next
      })

    const loads = entries.map(({ versionId, chapter }) =>
      fetchHelloaoChapter(versionId, book, chapter)
        .then((res) => {
          if (cancelled) return null
          store(chapterKey(versionId, book, chapter), chapterDataFromResponse(res))
          return { versionId, chapter, numberOfChapters: res.book?.numberOfChapters }
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
          prefetchHelloaoChapter(res.versionId, book, target)
        }
      }
    })

    return () => {
      cancelled = true
    }
  }, [open, debouncedPlan, retryNonce])

  const forget = (key: string) =>
    setChapterData((prev) => {
      const next = new Map(prev)
      next.delete(key)
      return next
    })

  return { chapterData, forget }
}
