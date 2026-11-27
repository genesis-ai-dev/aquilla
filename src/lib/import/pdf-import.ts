/**
 * AQU-2551: read a PDF for the import, in the person's words.
 *
 * The reader (`@/lib/parsers/pdf`) refuses a scanned, empty, locked or
 * unreadable PDF with a code; this turns each code into its message, and a
 * PDF with some scanned pages into a notice naming them (question 56). The
 * import never sends a PDF to the AI sandbox: it cannot read a scan or open a
 * locked file either, and the reader already has the text of a normal one.
 */

import { t } from "@/lib/i18n/standalone"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { extractPdfImport, extractPdfText, PdfReadError, type PdfReadErrorCode } from "@/lib/parsers/pdf"
import type { CellUnit, TranslatableString } from "@/lib/parsers/types"
import type { ImportPreviewNotice } from "./import-service"

const REFUSAL: Record<PdfReadErrorCode, MessageKey> = {
  scanned: "importExport.errors.pdfScanned",
  empty: "importExport.errors.pdfEmpty",
  password: "importExport.errors.pdfPassword",
  unreadable: "importExport.errors.pdfUnreadable",
  reader: "importExport.errors.pdfReaderFailed",
  "reader-timeout": "importExport.errors.pdfReaderSlow",
  "too-complex": "importExport.errors.pdfTooComplex",
}

/** A PDF the reader refused, with its message in the person's words. */
export class PdfRefusal extends Error {
  readonly code: PdfReadErrorCode

  constructor(err: PdfReadError) {
    super(t(REFUSAL[err.code]), { cause: err })
    this.name = "PdfRefusal"
    this.code = err.code
  }
}

export interface PdfImportRead {
  strings: TranslatableString[]
  importNotices: ImportPreviewNotice[]
}

export async function readPdfImport(buffer: ArrayBuffer, options?: { cellUnit?: CellUnit; budgetMs?: number; loadTimeoutMs?: number }): Promise<PdfImportRead> {
  let read: Awaited<ReturnType<typeof extractPdfImport>>
  try {
    read = await extractPdfImport(buffer, options)
  } catch (err) {
    if (err instanceof PdfReadError) throw new PdfRefusal(err)
    throw err
  }
  const importNotices: ImportPreviewNotice[] = read.imageOnlyPages.length === 0 ? [] : [{
    code: "pdf-image-only-pages",
    severity: "warning",
    message: t("importExport.notices.pdfImageOnlyPages", {
      count: read.imageOnlyPages.length,
      pages: read.imageOnlyPages.join(", "),
    }),
  }]
  return { strings: read.strings, importNotices }
}

/** AQU-2551: a PDF's plain text, read here in the browser, for the rule
 *  import and the Knowledge Base, which send the server only the text. A
 *  refused PDF throws a `PdfRefusal` with the import's own message. */
export async function readPdfText(buffer: ArrayBuffer): Promise<string> {
  try {
    return await extractPdfText(buffer)
  } catch (err) {
    if (err instanceof PdfReadError) throw new PdfRefusal(err)
    throw err
  }
}
