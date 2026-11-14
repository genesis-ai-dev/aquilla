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
import { extractPdfImport, PdfReadError, type PdfReadErrorCode } from "@/lib/parsers/pdf"
import type { CellUnit, TranslatableString } from "@/lib/parsers/types"
import type { ImportPreviewNotice } from "./import-service"

const REFUSAL: Record<PdfReadErrorCode, MessageKey> = {
  scanned: "importExport.errors.pdfScanned",
  empty: "importExport.errors.pdfEmpty",
  password: "importExport.errors.pdfPassword",
  unreadable: "importExport.errors.pdfUnreadable",
  reader: "importExport.errors.pdfReaderFailed",
}

export interface PdfImportRead {
  strings: TranslatableString[]
  importNotices: ImportPreviewNotice[]
}

export async function readPdfImport(buffer: ArrayBuffer, options?: { cellUnit?: CellUnit }): Promise<PdfImportRead> {
  let read: Awaited<ReturnType<typeof extractPdfImport>>
  try {
    read = await extractPdfImport(buffer, options)
  } catch (err) {
    if (err instanceof PdfReadError) throw new Error(t(REFUSAL[err.code]), { cause: err })
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
