// AQU-2551: read a PDF as an import source.
//
// pdf.js (`pdfjs-dist`) is loaded only when a PDF is read (dynamic import), and
// it parses in its own Web Worker in the browser: the worker file is emitted
// by Vite as a hashed asset and handed to pdf.js as its `workerSrc`. Where
// there is no Worker (tests, Node), pdf.js runs the same code inline.
//
// This module reads each page's positioned text, marked-content brackets and
// structure tree; `pdf-blocks.ts` turns them into paragraphs (tagged PDFs by
// their tags, untagged ones by their layout), and the paragraphs become cells
// with the Word import's own splitter, so a PDF and the .docx it was saved
// from come out cut the same way.
//
// A scanned PDF (pages that paint an image and hold no text), an empty one
// and a password-protected one are refused with a reason (`PdfReadError`);
// a PDF with some image-only pages imports its text pages and names the
// others. None of these go to the AI sandbox, which cannot do better.

import { v4 as uuid } from "uuid"
import type { CellUnit, TranslatableString } from "./core-types"
import { createUsfmFootnoteMarker } from "../footnotes/insert"
import { splitFootnoteAware } from "./docx"
import { pdfPagesToParagraphs, type PdfPageContent, type PdfPageItem, type PdfStructNode } from "./pdf-blocks"

export type PdfReadErrorCode = "password" | "scanned" | "empty" | "unreadable"

/** A PDF the import refuses, with the reason. The caller words the message. */
export class PdfReadError extends Error {
  constructor(readonly code: PdfReadErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "PdfReadError"
  }
}

export interface PdfImport {
  strings: TranslatableString[]
  /** 1-based numbers of pages that hold only an image (scanned), when the
   *  PDF also has text pages. */
  imageOnlyPages: number[]
  tagged: boolean
}

export interface PdfParseOptions {
  cellUnit?: CellUnit
}

type PdfJs = typeof import("pdfjs-dist")

let pdfjsPromise: Promise<PdfJs> | null = null

async function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import("pdfjs-dist")
    if (typeof window !== "undefined" && typeof Worker !== "undefined" && !pdfjs.GlobalWorkerOptions.workerSrc) {
      const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    }
    return pdfjs
  })()
  try {
    return await pdfjsPromise
  } catch (err) {
    pdfjsPromise = null
    throw err
  }
}

/** The pdf.js drawing operations that paint an image. */
function imagePaintOps(pdfjs: PdfJs): Set<number> {
  const ops = pdfjs.OPS as Record<string, number | undefined>
  return new Set([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintInlineImageXObjectGroup,
    ops.paintImageMaskXObject,
    ops.paintImageMaskXObjectGroup,
    ops.paintImageXObjectRepeat,
    ops.paintImageMaskXObjectRepeat,
    ops.paintSolidColorImageMask,
  ].filter((op): op is number => typeof op === "number"))
}

interface RawTextItem {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  hasEOL?: boolean
  dir?: string
  type?: string
  id?: string
  tag?: string
}

function toPageItems(items: readonly RawTextItem[]): PdfPageItem[] {
  const out: PdfPageItem[] = []
  for (const it of items) {
    if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") {
      out.push({ mc: "begin", id: it.id ?? null, tag: it.tag ?? null })
    } else if (it.type === "endMarkedContent") {
      out.push({ mc: "end" })
    } else if (typeof it.str === "string" && it.transform) {
      out.push({
        s: it.str,
        x: it.transform[4],
        y: it.transform[5],
        b: it.transform[1],
        w: it.width ?? 0,
        h: it.height ?? 0,
        eol: !!it.hasEOL,
        dir: it.dir ?? "ltr",
      })
    }
  }
  return out
}

const hasText = (items: readonly PdfPageItem[]) => items.some((it) => "s" in it && it.s.trim() !== "")

/** Read a PDF into import cells. Throws `PdfReadError` for a PDF it refuses. */
export async function extractPdfImport(buffer: ArrayBuffer, options?: PdfParseOptions): Promise<PdfImport> {
  const pdfjs = await loadPdfJs()
  // pdf.js transfers (detaches) the bytes it is given: hand it a copy.
  const task = pdfjs.getDocument({
    data: new Uint8Array(buffer.slice(0)),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  })
  let doc: Awaited<typeof task.promise>
  try {
    doc = await task.promise
  } catch (err) {
    await task.destroy().catch(() => {})
    const name = (err as { name?: string } | null)?.name
    if (name === "PasswordException") throw new PdfReadError("password", "PDF is password-protected", { cause: err })
    throw new PdfReadError("unreadable", `PDF could not be read: ${(err as Error)?.message ?? String(err)}`, { cause: err })
  }
  try {
    const paintOps = imagePaintOps(pdfjs)
    const pages: PdfPageContent[] = []
    const imageOnlyPages: number[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      try {
        const view = page.getViewport({ scale: 1 })
        const content = await page.getTextContent({ includeMarkedContent: true })
        const items = toPageItems(content.items as RawTextItem[])
        if (!hasText(items)) {
          // no text: a scanned page paints an image, an empty one nothing
          const ops = await page.getOperatorList()
          if (ops.fnArray.some((fn) => paintOps.has(fn))) imageOnlyPages.push(n)
          continue
        }
        const tree = (await page.getStructTree().catch(() => null)) as PdfStructNode | null
        pages.push({ n, w: view.width, h: view.height, items, tree })
      } finally {
        page.cleanup()
      }
    }
    if (pages.length === 0) {
      if (imageOnlyPages.length > 0) throw new PdfReadError("scanned", "PDF is a scanned image with no text")
      throw new PdfReadError("empty", "PDF has no text")
    }
    const read = pdfPagesToParagraphs(pages, (text) => createUsfmFootnoteMarker({ caller: "+", text }))
    if (read.paragraphs.length === 0) throw new PdfReadError(imageOnlyPages.length ? "scanned" : "empty", "PDF has no text")
    return { strings: paragraphsToStrings(read.paragraphs, options?.cellUnit), imageOnlyPages, tagged: read.tagged }
  } finally {
    await task.destroy().catch(() => {})
  }
}

/** Paragraphs → cells, with the Word import's splitter: one cell per
 *  paragraph on the Paragraph setting, sentences on the Sentence setting. */
function paragraphsToStrings(paragraphs: ReturnType<typeof pdfPagesToParagraphs>["paragraphs"], cellUnit: CellUnit = "sentence"): TranslatableString[] {
  const results: TranslatableString[] = []
  const perPage = new Map<number, number>()
  for (const p of paragraphs) {
    const k = (perPage.get(p.page) ?? 0) + 1
    perPage.set(p.page, k)
    const sourceLocation = { file: `page/${p.page}`, blockPath: `block[${k}]` }
    const segments = splitFootnoteAware(p.text, cellUnit)
    segments.forEach((seg, i) => {
      results.push({
        id: uuid(),
        original: seg.text,
        translated: "",
        context: p.heading ?? "Paragraph",
        group: seg.group,
        type: p.heading ? "heading" : "text",
        sourceLocation,
        ...(i === 0 ? { paragraphStart: true } : {}),
      })
    })
  }
  return results
}
