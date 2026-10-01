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
import { numberedBookCodes, planSectionLabel } from "@/lib/plan/plan-section"
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

/**
 * AQU-1493: the file's lines that no chapter holds — a line added in the
 * editor carries no verse reference — and where the plan counts them.
 */
export interface PlanUnplacedLines {
  count: number
  /**
   * True on a file of ONE book: the projection counts them toward that book
   * (`unitBookKeyExpr`), so they are in this unit's bars without being in any
   * chapter. False on a file of several, where no book counts them at all.
   */
  inUnit: boolean
}

export interface UsePlanUnitSectionsResult {
  sections: PlanSection[]
  /** Null on a file-grain unit, which holds every line of its file anyway. */
  unplaced: PlanUnplacedLines | null
  loading: boolean
  error: boolean
}

/**
 * How many of a Scripture file's lines sit in no chapter: the file's own count
 * less every chapter's. Time buckets are not chapters — a timed line with no
 * reference has no verse either — so they are left out of the subtraction.
 */
export function unplacedLines(
  fileTotal: number,
  sections: ReadonlyArray<{ key: string; totalCount: number }>,
): PlanUnplacedLines {
  const chapters = sections.filter((s) => !s.key.startsWith(TIME_BUCKET_PREFIX))
  const placed = chapters.reduce((sum, s) => sum + s.totalCount, 0)
  const books = new Set(chapters.map((s) => s.key.split(" ")[0]))
  return { count: Math.max(0, fileTotal - placed), inUnit: books.size === 1 }
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
  const [unplaced, setUnplaced] = useState<PlanUnplacedLines | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // Guards against a slow response for a unit the reader has already left.
  const generation = useRef(0)

  const fileId = unit?.fileId ?? null
  const sectionKey = unit?.sectionKey ?? ""

  useEffect(() => {
    if (!projectId || !fileId || !getToken) {
      setSections(EMPTY)
      setUnplaced(null)
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
        const mine = body.sections.filter((s) => sectionBelongsToUnit(s.key, sectionKey))
        setUnplaced(sectionKey ? unplacedLines(body.file.totalCount, body.sections) : null)
        // AQU-1278: labels come from the shared classifier, over THIS unit's
        // keys — a bare book code is "1" for a one-chapter book and keeps its
        // code for front matter, and that answer depends on the other keys.
        // This file used to carry a looser rule of its own that read "Scene 4"
        // as "4", which is the wrong label and, on the grid, the wrong square.
        const numbered = numberedBookCodes(mine.map((s) => s.key))
        setSections(
          mine
            .map((section) => ({
              key: section.key,
              label: planSectionLabel(section.key, numbered),
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
        setUnplaced(null)
        setError(true)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projectId, fileId, sectionKey, lane, getToken])

  return { sections, unplaced, loading, error }
}
