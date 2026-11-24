// The reading preview: the book laid out as a reader sees it, live as the
// translator types. It is the Web page export (src/lib/export/exporters/html.ts)
// built from the cells on screen, so it needs no original upload and works for
// every Bible book, whatever format it was imported from.
//
// The page is self-contained HTML with its own stylesheet, so it renders in a
// sandboxed iframe: its CSS cannot touch the app's and the app's cannot touch
// it. The sandbox allows no scripts (the page has none, and every piece of
// cell text in it is escaped); `allow-same-origin` only lets this component
// reach into the document to swap the body and scroll to a verse.

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react"
import type { CellData } from "@/hooks/useCells"
import { buildHtmlPage } from "@/lib/export/exporters/html"
import { useT } from "@/lib/i18n/I18nProvider"

/** Marks the verse being edited. Injected once; the page's own CSS has no such rule. */
const ACTIVE_STYLE = `.verse-number[data-active]{color:var(--link);outline:2px solid var(--link);outline-offset:2px;border-radius:2px}`

export interface ReadingPreviewPaneProps {
  cells: readonly CellData[]
  /** Values typed but not saved yet, by cell id: the page shows them already. */
  unsaved: ReadonlyMap<string, string>
  fileName?: string | null
  lang?: string | null
  /** The reference of the verse being edited; the page keeps it in view. */
  activeRef: string | null
}

export function ReadingPreviewPane({ cells, unsaved, fileName, lang, activeRef }: ReadingPreviewPaneProps) {
  const t = useT()
  const deferredCells = useDeferredValue(cells)
  const deferredUnsaved = useDeferredValue(unsaved)
  const page = useMemo(() => {
    const visible = deferredCells
      .filter((cell) => !cell.hidden)
      .map((cell) => {
        const typed = deferredUnsaved.get(cell.id)
        return typed === undefined ? cell : { ...cell, translated: typed }
      })
    return buildHtmlPage(visible, { fileName, lang, verseAnchors: true })
  }, [deferredCells, deferredUnsaved, fileName, lang])

  const frameRef = useRef<HTMLIFrameElement | null>(null)
  // The first page loads through srcDoc. Later pages swap only the body, so a
  // keystroke does not reload the frame and throw the reader back to the top.
  const [initialPage] = useState(page)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    const doc = frameRef.current?.contentDocument
    if (!loaded || !doc) return
    const next = new DOMParser().parseFromString(page, "text/html")
    doc.body.innerHTML = next.body.innerHTML
    markActive(doc, activeRef, false)
  }, [page, loaded, activeRef])

  useEffect(() => {
    const doc = frameRef.current?.contentDocument
    if (!loaded || !doc) return
    markActive(doc, activeRef, true)
  }, [activeRef, loaded])

  return (
    <iframe
      ref={frameRef}
      title={t("bibleDocument.preview.readingTitle")}
      data-testid="reading-preview"
      sandbox="allow-same-origin"
      srcDoc={initialPage}
      className="h-full w-full border-0 bg-background"
      onLoad={() => {
        const doc = frameRef.current?.contentDocument
        if (doc) {
          const style = doc.createElement("style")
          style.textContent = ACTIVE_STYLE
          doc.head.appendChild(style)
        }
        setLoaded(true)
      }}
    />
  )
}

/** Mark the active verse's number, and bring it into view when asked. */
function markActive(doc: Document, ref: string | null, scroll: boolean): void {
  for (const el of doc.querySelectorAll("[data-active]")) el.removeAttribute("data-active")
  if (!ref) return
  const el = doc.querySelector(`[data-ref="${CSS.escape(ref)}"]`)
  if (!el) return
  el.setAttribute("data-active", "")
  if (scroll) el.scrollIntoView({ block: "center", behavior: "smooth" })
}
