// parse-document client helper — AQU-197
//
// Returns the plain text of a .docx (through the auth-worker's
// /api/v2/parse-document endpoint) or a .pdf (read in the browser, AQU-2551).
// Throws with a human-readable message on HTTP errors or parse failures.
//
// AQU-820: the worker's `{ error }` string is untranslated, and its 422 case
// interpolates the raw extractor exception — RuleImportDialog renders
// `err.message` verbatim, so the thrown message is ours and keyed. The server
// text is kept on `cause`. Distinguishing "encrypted" from "image-only" for
// the user needs an error CODE from the worker, not a passthrough of its
// prose.
//
// AQU-2551 (review findings 1–3): the worker no longer parses PDFs; a 2 MB
// upload could make it decode a gigabyte. A PDF is read here, in the browser,
// with the import's own reader (pdf.js in its own Web Worker), and only its
// text goes on to the rule extractor. The worker refuses a PDF with the code
// "pdf-text-required", which a page from before the change can still meet.

import { AUTH_BASE } from "./auth"
import { t } from "../i18n/standalone"
import type { MessageKey } from "../i18n/messages/en"

export const MAX_PARSE_FILE_BYTES = 2 * 1024 * 1024 // 2 MB (must match worker)

/** The worker's refusal codes this client words. */
const REFUSAL: Readonly<Record<string, MessageKey>> = {
  "pdf-text-required": "importExport.errors.pdfServerRefused",
}

/** A PDF by its name or its type, as the rule import dialog accepts it. */
export function isPdfFile(file: File): boolean {
  return file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf"
}

export async function parseDocumentFile(file: File, jwt: string): Promise<string> {
  if (isPdfFile(file)) {
    // loaded only when a PDF is dropped, like the import's reader
    const { readPdfText } = await import("@/lib/import/pdf-import")
    return readPdfText(await file.arrayBuffer())
  }
  const form = new FormData()
  form.append("file", file)

  const res = await fetch(`${AUTH_BASE}/api/v2/parse-document`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  })

  let body: { text?: string; error?: string; code?: string } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    // non-JSON body — fall through to status check
  }

  if (!res.ok || !body.text) {
    const refusal = body.code && Object.prototype.hasOwnProperty.call(REFUSAL, body.code) ? REFUSAL[body.code] : null
    const err = new Error(t(refusal ?? "error.parseDocument.failed"))
    err.cause = `HTTP ${res.status}${body.error ? ` — ${body.error.slice(0, 400)}` : ""}`
    throw err
  }

  return body.text
}
