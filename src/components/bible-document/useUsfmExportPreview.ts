// The live export preview's data (AQU-2559). The original upload is fetched
// once per file; after that every keystroke costs one walk over the book's
// verse spans, in the browser, with no request.

import { useDeferredValue, useEffect, useMemo, useState } from "react"
import type { CellData } from "@/hooks/useCells"
import { buildClientUsfmPlan, parsePreviewSource, renderUsfmPreview, type UsfmPreview } from "@/lib/bible-document/export-plan"
import type { UsfmDocument } from "@/lib/parsers/usfm-lossless"
import { SourceExportError, fetchRawOriginalSource, fetchRemovedCells } from "@/lib/sync/source-export"

export type ExportPreviewState =
  | { status: "idle" | "loading" }
  /** "forbidden": this person's role may not export. "unsupported": the stored
   *  original is not USFM text this preview can read. */
  | { status: "forbidden" | "unsupported" | "error" }
  | { status: "ready"; preview: UsfmPreview }

interface Loaded {
  key: string
  outcome: "ready" | "forbidden" | "unsupported" | "error"
  doc: UsfmDocument | null
  removedRefs: string[]
}

export function useUsfmExportPreview(args: {
  enabled: boolean
  projectId: string
  fileId: string
  lane: string | undefined
  getToken: (fileId: string) => Promise<string | null>
  cells: readonly CellData[]
  unsaved: ReadonlyMap<string, string>
}): ExportPreviewState {
  const { enabled, projectId, fileId, lane, getToken } = args
  const key = `${projectId}:${fileId}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void (async () => {
      try {
        const [source, removed] = await Promise.all([
          fetchRawOriginalSource({ projectId, fileId, getToken, ...(lane ? { targetLang: lane } : {}) }),
          fetchRemovedCells({ projectId, fileId, getToken }),
        ])
        if (cancelled) return
        // Decoded exactly as the export route decodes it, so both sides
        // serialize the same string.
        const doc = parsePreviewSource(new TextDecoder().decode(source.bytes))
        const removedRefs = removed.map((r) => r.canonicalRef).filter((r): r is string => Boolean(r))
        setLoaded({ key, outcome: doc.verses.length > 0 ? "ready" : "unsupported", doc, removedRefs })
      } catch (error) {
        if (cancelled) return
        const forbidden = error instanceof SourceExportError && error.status === 403
        setLoaded({ key, outcome: forbidden ? "forbidden" : "error", doc: null, removedRefs: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, key, projectId, fileId, lane, getToken])

  const cells = useDeferredValue(args.cells)
  const unsaved = useDeferredValue(args.unsaved)
  const current = enabled && loaded?.key === key ? loaded : null
  const preview = useMemo(() => {
    if (!current?.doc || current.outcome !== "ready") return null
    return renderUsfmPreview(current.doc, buildClientUsfmPlan(cells, current.removedRefs, unsaved))
  }, [current, cells, unsaved])

  if (!enabled) return { status: "idle" }
  if (!current) return { status: "loading" }
  if (current.outcome !== "ready" || !preview) return { status: current.outcome === "ready" ? "error" : current.outcome }
  return { status: "ready", preview }
}
