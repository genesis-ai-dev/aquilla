import { useEffect, useMemo, useState } from "react"
import { loadPericopeIndex } from "@/lib/pericope/dataset"
import type { PericopeIndex } from "@/lib/pericope/sections"
import type { PericopeResumeContext } from "@/lib/pericope/resume"
import {
  DEFAULT_SUGGESTION_LIMIT,
  suggestPericopes,
  type PericopeSuggestion,
} from "@/lib/pericope/suggest"

/**
 * The next few pericope ranges to offer for the open file (AQU-515).
 *
 * `resume` being `null` — a non-scripture file, or a book with nothing left to
 * translate — short-circuits before the dataset is requested, so a project that
 * never opens a Bible never pays for the chunk. A dataset that fails to load
 * yields an empty list; the caller renders nothing rather than an error.
 */
export function usePericopeSuggestions(
  resume: PericopeResumeContext | null,
  limit: number = DEFAULT_SUGGESTION_LIMIT,
): PericopeSuggestion[] {
  const [index, setIndex] = useState<PericopeIndex | null>(null)
  const wanted = Boolean(resume)

  useEffect(() => {
    if (!wanted || index) return
    let cancelled = false
    void loadPericopeIndex().then((loaded) => {
      if (!cancelled) setIndex(loaded)
    })
    return () => { cancelled = true }
  }, [index, wanted])

  return useMemo(() => {
    if (!resume || !index) return []
    return suggestPericopes(index, { book: resume.book, from: resume.from, limit })
  }, [index, limit, resume])
}
