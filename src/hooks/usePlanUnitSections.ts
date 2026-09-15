// AQU-1098: the chapters (or sections) inside one planning unit.
//
// Reads the file's existing per-section progress and narrows it to the unit in
// hand. A book unit takes the sections belonging to that book; a file-grain
// unit takes all of them. Nothing new is fetched per unit — stepping between
// two books of the same file reuses one cached response.
//
// Media files are deliberately excluded. Their section keys are five-minute
// wall-clock buckets ("t:3"), which nobody plans by and which would read as a
// list of meaningless numbers.

import { useEffect, useRef, useState } from "react"
import { getFileProgress } from "@/lib/progress/file-progress-resource"
import type { PlanUnit } from "@/lib/plan/plan-status"

export interface PlanSection {
  /** The projection's own key, e.g. "GEN 1". */
  key: string
  /** What to show: the chapter number, or the whole key when it isn't one. */
  label: string
  totalCount: number
  filledCount: number
  validatedCount: number
  audioCount: number
  audioValidatedCount: number
}

const TIME_BUCKET_PREFIX = "t:"

/** "GEN 1" → "1"; anything not chapter-shaped keeps its own key. */
function sectionLabel(key: string): string {
  const match = /^\S+\s+(\d+)$/.exec(key)
  return match ? match[1] : key
}

/**
 * Does this section belong to the unit? A one-chapter book makes the section
 * key and the book code identical ("TIT"), so an exact match counts as well as
 * a prefixed one.
 */
export function sectionBelongsToUnit(key: string, sectionKey: string): boolean {
  if (key.startsWith(TIME_BUCKET_PREFIX)) return false
  if (!sectionKey) return true
  return key === sectionKey || key.startsWith(`${sectionKey} `)
}

export interface UsePlanUnitSectionsResult {
  sections: PlanSection[]
  loading: boolean
  error: boolean
}

const EMPTY: PlanSection[] = []

export function usePlanUnitSections(opts: {
  projectId: string | null
  unit: PlanUnit | null
  /** Mints a project-scoped sync token; the progress route ignores its file claim. */
  getToken: (() => Promise<string | null>) | null
  lane: string
}): UsePlanUnitSectionsResult {
  const { projectId, unit, getToken, lane } = opts
  const [sections, setSections] = useState<PlanSection[]>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // Guards against a slow response for a unit the reader has already left.
  const generation = useRef(0)

  const fileId = unit?.fileId ?? null
  const sectionKey = unit?.sectionKey ?? ""

  useEffect(() => {
    if (!projectId || !fileId || !getToken) {
      setSections(EMPTY)
      setLoading(false)
      setError(false)
      return
    }
    let cancelled = false
    const gen = ++generation.current
    setLoading(true)
    setError(false)
    void (async () => {
      try {
        const body = await getFileProgress(projectId, fileId, () => getToken(), lane)
        if (cancelled || generation.current !== gen) return
        setSections(
          body.sections
            .filter((section) => sectionBelongsToUnit(section.key, sectionKey))
            .map((section) => ({
              key: section.key,
              label: sectionLabel(section.key),
              totalCount: section.totalCount,
              filledCount: section.filledCount,
              validatedCount: section.validatedCount,
              // Optional on the wire: an older worker, or the editor's local
              // snapshot, simply does not know. Absent reads as none here,
              // which is the right default for a bar that would draw at zero.
              audioCount: section.audioCount ?? 0,
              audioValidatedCount: section.audioValidatedCount ?? 0,
            })),
        )
        setLoading(false)
      } catch {
        if (cancelled || generation.current !== gen) return
        setSections(EMPTY)
        setError(true)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, fileId, sectionKey, lane, getToken])

  return { sections, loading, error }
}
