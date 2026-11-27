// AQU-2680: the PDF export (question 54, Sam's decision Nov 19). There is no
// converter on a server: the translation is laid out as a print page
// (`buildPrintPage`) and opened in the browser's print window, where the
// person picks "Save as PDF". Nothing is uploaded, so it works offline and
// on any network.
//
// The fallback: where printing is blocked or missing (another app's built-in
// browser, a browser with no print), the export gives the new Word document
// instead, with one sentence on saving it as PDF from Word. A cancel in the
// print window is the person's own choice and saves nothing.

import type { CellData } from "@/hooks/useCells"
import { t } from "@/lib/i18n/standalone"
import { exportDocxFromLines } from "./exporters/docx-from-lines"
import { buildPrintPage } from "./exporters/print-from-lines"
import { printHtml, type PrintOptions } from "./print-window"

export type PdfOrWord =
  /** The print window opened; the person saves the PDF there. */
  | { kind: "print" }
  /** Printing is not available here: the Word file, and the sentence to show. */
  | { kind: "word"; blob: Blob; notice: string }

export interface PdfOrWordOptions {
  /** The page's title, which browsers name the saved PDF after. */
  title: string
  /** The export's target language. */
  lang?: string
  /** For tests: how the page is opened for printing. */
  print?: PrintOptions
}

export async function exportPdfOrWord(cells: readonly CellData[], options: PdfOrWordOptions): Promise<PdfOrWord> {
  const page = buildPrintPage(cells, { title: options.title, lang: options.lang })
  if (await printHtml(page, options.print)) return { kind: "print" }
  return {
    kind: "word",
    blob: await exportDocxFromLines(cells, { lang: options.lang }),
    notice: t("importExport.status.pdfFellBackToWord"),
  }
}
