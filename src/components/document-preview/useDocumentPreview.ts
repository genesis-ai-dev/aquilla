// The document preview's data. The original upload is fetched once per file;
// after that an edit costs one export in the browser, with no request.

import { useEffect, useMemo, useRef, useState } from "react"
import type { CellData } from "@/hooks/useCells"
import { buildPreviewDocument, previewSignature, type DocumentPreviewKind } from "@/lib/document-preview/build"
import { SourceExportError, fetchRemovedCells, fetchSourceSidecar, type RemovedCellRecord } from "@/lib/sync/source-export"

/** How long the cells must stay still before the document is rebuilt. */
const REBUILD_DELAY_MS = 350

export type DocumentPreviewState =
  | { status: "loading" }
  /** "forbidden": this person's role may not export. "missing": the server
   *  holds no original for this file, so there is nothing to draw. */
  | { status: "forbidden" | "missing" | "error" }
  /** `updating`: these bytes are older than the cells; newer ones are on the way.
   *  `behind`: the export refused the cells as they are now, so these bytes
   *  are the last ones it would write (the original, if it never wrote any). */
  | { status: "ready"; bytes: ArrayBuffer; updating: boolean; behind: boolean }

interface Loaded {
  key: string
  outcome: "ready" | "forbidden" | "missing" | "error"
  original: ArrayBuffer | null
  removed: RemovedCellRecord[]
}

interface Built {
  key: string
  signature: string
  bytes: ArrayBuffer
  /** The export threw for this signature; `bytes` are from before it. */
  behind: boolean
}

export function useDocumentPreview(args: {
  kind: DocumentPreviewKind
  projectId: string
  fileId: string
  lane?: string
  targetLanguage?: string | null
  getToken: (fileId: string) => Promise<string | null>
  /** The file's cells. Wait for the whole file: a partial one previews as untranslated. */
  cells: CellData[]
  cellsLoading: boolean
}): DocumentPreviewState {
  const { kind, projectId, fileId, lane, targetLanguage, getToken, cells, cellsLoading } = args
  const key = `${projectId}:${fileId}:${lane ?? ""}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [built, setBuilt] = useState<Built | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [original, removed] = await Promise.all([
          fetchSourceSidecar({ projectId, fileId, getToken, ...(lane ? { targetLang: lane } : {}) }),
          fetchRemovedCells({ projectId, fileId, getToken }),
        ])
        if (!cancelled) setLoaded({ key, outcome: "ready", original, removed })
      } catch (error) {
        if (cancelled) return
        const status = error instanceof SourceExportError ? error.status : undefined
        const outcome = status === 403 ? "forbidden" : status === 404 ? "missing" : "error"
        setLoaded({ key, outcome, original: null, removed: [] })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [key, projectId, fileId, lane, getToken])

  const current = loaded?.key === key ? loaded : null
  const signature = useMemo(() => previewSignature(cells), [cells])
  // The build reads the cells of the moment it runs, and is scheduled by their
  // signature: cells change for reasons that do not change the document.
  const cellsRef = useRef(cells)
  useEffect(() => {
    cellsRef.current = cells
  }, [cells])
  const hasBuilt = built?.key === key

  useEffect(() => {
    const original = current?.original
    if (!original || cellsLoading) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void buildPreviewDocument(kind, original, cellsRef.current, { removedCells: current.removed, targetLanguage })
        .then(
          (bytes) => {
            if (!cancelled) setBuilt({ key, signature, bytes, behind: false })
          },
          () => {
            if (cancelled) return
            setBuilt((prior) => ({ key, signature, bytes: prior?.key === key ? prior.bytes : original, behind: true }))
          },
        )
    }, hasBuilt ? REBUILD_DELAY_MS : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // `hasBuilt` only picks the delay; it must not restart a build in flight.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, cellsLoading, kind, key, signature, targetLanguage])

  if (!current) return { status: "loading" }
  if (current.outcome !== "ready") return { status: current.outcome }
  if (built?.key !== key) return { status: "loading" }
  return { status: "ready", bytes: built.bytes, updating: built.signature !== signature, behind: built.behind }
}
