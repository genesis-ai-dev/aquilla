// AQU-2680: the fallback the PDF export will use (PLAN.md section 4).
//
// The PDF is made from the Word file the browser has already built, by a
// converter on the server (question 98, not built yet; it is passed in).
// When there is no converter, the device is offline, or the converter fails,
// hands back nothing or runs past the time limit, the export saves the Word
// file instead, with one sentence on how to save it as PDF. Nothing is lost:
// the Word file is already made. Trying again is the same button again.

import { t } from "@/lib/i18n/standalone"

/** Turns a Word file into a PDF. Stops when `signal` aborts. */
export type DocxToPdf = (docx: Blob, options: { signal: AbortSignal }) => Promise<Blob>

export interface PdfOrWord {
  blob: Blob
  ext: "pdf" | "docx"
  /** The sentence to show when the Word file was saved instead; null for the PDF. */
  notice: string | null
}

/** No spinner past this: the person is waiting on the export. */
export const PDF_CONVERT_TIMEOUT_MS = 60_000

export interface PdfOrWordOptions {
  /** Default: the browser's own `navigator.onLine`. */
  online?: boolean
  timeoutMs?: number
}

export async function exportPdfOrWord(docx: Blob, convert: DocxToPdf | null | undefined, options?: PdfOrWordOptions): Promise<PdfOrWord> {
  const word: PdfOrWord = { blob: docx, ext: "docx", notice: t("importExport.status.pdfFellBackToWord") }
  const online = options?.online ?? (typeof navigator === "undefined" || navigator.onLine !== false)
  if (!convert || !online) return word
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), options?.timeoutMs ?? PDF_CONVERT_TIMEOUT_MS)
  })
  try {
    const pdf = await Promise.race([convert(docx, { signal: controller.signal }), timedOut])
    if (!pdf || pdf.size === 0) return word
    return { blob: pdf, ext: "pdf", notice: null }
  } catch {
    return word
  } finally {
    clearTimeout(timer)
    // ends a request still running (the time limit); harmless after it finished
    controller.abort()
  }
}
