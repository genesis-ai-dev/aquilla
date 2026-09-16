// AQU-1278: one chapter's verses, fetched when a reader opens that chapter.
//
// ON CLICK ONLY, never on render and never on hover. `cells.canonical_ref` is
// unindexed, so the chapter-detail query narrows on (project, file, side) and
// then filters — on a 31k-cell Bible every chapter fetch is a full-file scan.
// A grid that prefetched its fifty tiles would be fifty of those, to draw chips
// nobody asked for. Opening a chapter is a deliberate act and pays for one.
//
// Results are kept per section key for the life of the panel, so stepping back
// to a chapter already opened is free. Nothing invalidates them: a reader who
// wants fresher numbers than the minute they have been sitting here reopens the
// unit, which remounts this.

import { useCallback, useRef, useState } from "react"
import { getFileSectionProgress } from "@/lib/progress/file-progress-resource"
import type { ShortVerse } from "./verse-chips"

export type SectionVersesState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; verses: ShortVerse[] }

export interface UseSectionVerses {
  /** What is known about one section, or undefined if nobody has asked. */
  get: (sectionKey: string) => SectionVersesState | undefined
  /** Fetch a section's verses. A no-op once it is loading or loaded. */
  load: (sectionKey: string) => void
}

export function useSectionVerses({
  projectId,
  fileId,
  getToken,
  lane,
}: {
  projectId: string | null
  fileId: string
  getToken: (() => Promise<string | null>) | null
  lane: string
}): UseSectionVerses {
  const [entries, setEntries] = useState<ReadonlyMap<string, SectionVersesState>>(
    () => new Map(),
  )
  // A generation counter, bumped by nothing here — the panel remounts per unit,
  // so the only staleness to defend against is a response arriving after the
  // component is gone. A ref rather than state: reading it must not re-render.
  const alive = useRef(true)

  const load = useCallback(
    (sectionKey: string) => {
      if (!projectId || !getToken) return
      setEntries((prev) => {
        if (prev.has(sectionKey)) return prev
        const next = new Map(prev)
        next.set(sectionKey, { status: "loading" })
        return next
      })
      void (async () => {
        try {
          const body = await getFileSectionProgress(
            projectId, fileId, sectionKey, () => getToken(), lane,
          )
          if (!alive.current) return
          setEntries((prev) => {
            const next = new Map(prev)
            next.set(sectionKey, { status: "ready", verses: body.verses })
            return next
          })
        } catch {
          if (!alive.current) return
          // One unreadable chapter draws no chips. The bars above them are
          // still true, and the counts line still says what is outstanding —
          // so there is nothing to apologise for and nothing to retry into.
          setEntries((prev) => {
            const next = new Map(prev)
            next.set(sectionKey, { status: "error" })
            return next
          })
        }
      })()
    },
    [projectId, fileId, getToken, lane],
  )

  const get = useCallback(
    (sectionKey: string) => entries.get(sectionKey),
    [entries],
  )

  return { get, load }
}
