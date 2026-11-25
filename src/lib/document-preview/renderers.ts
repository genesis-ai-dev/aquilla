// Draws a Word, PowerPoint or InDesign file into the preview frame's document.
//
// The Word and PowerPoint libraries build the page as DOM from the file's own
// XML, so a file can put its own links and styles on screen. The frame they draw into is a
// sandboxed iframe that runs no scripts (DocumentPreviewFrame); this module
// also takes the links' targets away, so a click in the preview goes nowhere.

import type { DocumentPreviewKind } from "./build"

export interface DocumentPreviewRenderer {
  /** Draw this file. A later call replaces what the earlier one drew. */
  render(bytes: ArrayBuffer): Promise<void>
  destroy(): void
}

/** Space around the page inside the frame, in CSS pixels. */
const GUTTER = 12

/**
 * A host element inside the frame. It is created by the app's own document and
 * moved into the frame: the libraries test `instanceof HTMLElement` against
 * the app's globals, which an element born in the frame would fail.
 */
function hostIn(doc: Document): HTMLDivElement {
  const host = document.createElement("div")
  doc.body.appendChild(host)
  return host
}

function neutralizeLinks(root: ParentNode): void {
  for (const link of root.querySelectorAll("a[href]")) link.removeAttribute("href")
}

function scrollerOf(doc: Document): Element {
  return doc.scrollingElement ?? doc.documentElement
}

function createDocxRenderer(doc: Document): DocumentPreviewRenderer {
  const view = doc.defaultView
  let stage: HTMLDivElement | null = null
  let latest = 0

  // Word pages have a fixed width; the panel is usually narrower. Scale the
  // whole document so a page fills the panel, and never above its real size.
  const fit = () => {
    if (!stage) return
    stage.style.zoom = ""
    const page = stage.querySelector<HTMLElement>("section.docx")
    if (!page || page.offsetWidth === 0) return
    const available = doc.documentElement.clientWidth - GUTTER * 2
    stage.style.zoom = String(Math.min(1, Math.max(0.2, available / page.offsetWidth)))
  }
  view?.addEventListener("resize", fit)

  return {
    async render(bytes) {
      const turn = ++latest
      const { renderAsync } = await import("docx-preview")
      const next = hostIn(doc)
      // Off screen until it is whole, so the page on screen does not blank.
      next.style.display = "none"
      try {
        await renderAsync(bytes, next, next, {
          inWrapper: true,
          breakPages: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          renderEndnotes: true,
          // Data URLs, not blob URLs: every keystroke redraws, and blob URLs
          // made by the library are never released.
          useBase64URL: true,
        })
      } catch (error) {
        next.remove()
        throw error
      }
      if (turn !== latest) {
        next.remove()
        return
      }
      neutralizeLinks(next)
      const scroller = scrollerOf(doc)
      const top = scroller.scrollTop
      stage?.remove()
      stage = next
      next.style.display = ""
      fit()
      scroller.scrollTop = top
    },
    destroy() {
      latest++
      view?.removeEventListener("resize", fit)
      stage?.remove()
      stage = null
    },
  }
}

function createPptxRenderer(doc: Document): DocumentPreviewRenderer {
  // The viewer fits slides to its host's width, so the space around them is
  // the frame's, not the host's.
  const host = hostIn(doc)
  host.style.margin = `${GUTTER}px`
  let viewer: import("@aiden0z/pptx-renderer").PptxViewer | null = null
  let latest = 0

  return {
    async render(bytes) {
      const turn = ++latest
      const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer")
      if (turn !== latest) return
      const scroller = scrollerOf(doc)
      const top = scroller.scrollTop
      viewer ??= new PptxViewer(host, {
        fitMode: "contain",
        // A deck may link pictures and video on other servers. The preview
        // asks no server but ours for anything.
        externalMedia: "block",
        zipLimits: RECOMMENDED_ZIP_LIMITS,
        // No PDF.js: it is only for vector artwork stored as an EMF fallback.
        pdfjs: false,
      })
      await viewer.open(bytes, { renderMode: "list" })
      if (turn !== latest) return
      neutralizeLinks(host)
      scroller.scrollTop = top
    },
    destroy() {
      latest++
      viewer?.destroy()
      viewer = null
      host.remove()
    },
  }
}

function createIdmlRenderer(doc: Document, labels: DocumentPreviewLabels): DocumentPreviewRenderer {
  const host = hostIn(doc)
  let latest = 0
  return {
    async render(bytes) {
      const turn = ++latest
      const { renderIdmlFlow } = await import("./idml-flow")
      const flow = await renderIdmlFlow(bytes, labels.page)
      if (turn !== latest) return
      const scroller = scrollerOf(doc)
      const top = scroller.scrollTop
      // Markup this module's own code built: every piece of package text in
      // it is escaped (idml-flow.ts).
      host.innerHTML = flow.html
      scroller.scrollTop = top
    },
    destroy() {
      latest++
      host.remove()
    },
  }
}

export interface DocumentPreviewLabels {
  /** A page's name in the reader's language ("Page 4"). */
  page: (name: string) => string
}

export function createDocumentPreviewRenderer(
  kind: DocumentPreviewKind,
  doc: Document,
  labels: DocumentPreviewLabels,
): DocumentPreviewRenderer {
  if (kind === "docx") return createDocxRenderer(doc)
  if (kind === "pptx") return createPptxRenderer(doc)
  return createIdmlRenderer(doc, labels)
}
