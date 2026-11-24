// The frame a document preview is drawn in.
//
// A sandboxed iframe, like the Bible reading preview (ReadingPreviewPane): the
// file's own styles cannot touch the app's and the app's cannot touch the
// page. The sandbox allows no scripts; `allow-same-origin` only lets this
// component reach into the frame to draw the page.

import { useEffect, useRef, useState } from "react"
import { useT } from "@/lib/i18n/I18nProvider"
import type { DocumentPreviewKind } from "@/lib/document-preview/build"
import { createDocumentPreviewRenderer, type DocumentPreviewRenderer } from "@/lib/document-preview/renderers"

const SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}
body{background:#e4e4e7;color:#000;overflow:auto}
.docx-wrapper{background:transparent!important;padding:12px!important}
.docx-wrapper>section.docx{margin-bottom:12px!important}
</style></head><body></body></html>`

export interface DocumentPreviewFrameProps {
  kind: DocumentPreviewKind
  /** The file to draw. A new buffer redraws the page where the reader is. */
  bytes: ArrayBuffer
  title: string
  /** True when the browser could not draw the newest file. */
  onRenderError: (failed: boolean) => void
}

export function DocumentPreviewFrame({ kind, bytes, title, onRenderError }: DocumentPreviewFrameProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const rendererRef = useRef<DocumentPreviewRenderer | null>(null)
  const [loaded, setLoaded] = useState(false)
  const t = useT()

  useEffect(() => {
    const doc = frameRef.current?.contentDocument
    if (!loaded || !doc) return
    const renderer = createDocumentPreviewRenderer(kind, doc, {
      page: (name) => t("documentPreview.page", { name }),
    })
    rendererRef.current = renderer
    return () => {
      rendererRef.current = null
      renderer.destroy()
    }
  }, [kind, loaded, t])

  useEffect(() => {
    const renderer = rendererRef.current
    if (!loaded || !renderer) return
    let cancelled = false
    renderer.render(bytes).then(
      () => {
        if (!cancelled) onRenderError(false)
      },
      () => {
        if (!cancelled) onRenderError(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [bytes, kind, loaded, onRenderError])

  return (
    <iframe
      ref={frameRef}
      title={title}
      data-testid="document-preview-frame"
      sandbox="allow-same-origin"
      srcDoc={SHELL}
      className="h-full w-full border-0"
      onLoad={() => setLoaded(true)}
    />
  )
}
