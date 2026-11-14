// parse-document client helper — AQU-197
//
// Uploads a .pdf or .docx file to the auth-worker's /api/v2/parse-document
// endpoint and returns the extracted plain text. Throws with a human-readable
// message on HTTP errors or parse failures.
//
// AQU-820: the worker's `{ error }` string is untranslated, and its 422 case
// interpolates the raw extractor exception — RuleImportDialog renders
// `err.message` verbatim, so the thrown message is ours and keyed. The server
// text is kept on `cause`. Distinguishing "encrypted" from "image-only" for
// the user needs an error CODE from the worker, not a passthrough of its
// prose. AQU-2551: the worker now sends one for a PDF ("password", "empty"),
// and it is worded with the PDF import's own messages.

import { AUTH_BASE } from "./auth"
import { t } from "../i18n/standalone"
import type { MessageKey } from "../i18n/messages/en"

export const MAX_PARSE_FILE_BYTES = 2 * 1024 * 1024 // 2 MB (must match worker)

/** The worker's PDF refusal codes, worded as the PDF import words them. */
const PDF_REFUSAL: Readonly<Record<string, MessageKey>> = {
  password: "importExport.errors.pdfPassword",
  empty: "importExport.errors.pdfEmpty",
}

export async function parseDocumentFile(file: File, jwt: string): Promise<string> {
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
    const refusal = body.code && Object.prototype.hasOwnProperty.call(PDF_REFUSAL, body.code) ? PDF_REFUSAL[body.code] : null
    const err = new Error(t(refusal ?? "error.parseDocument.failed"))
    err.cause = `HTTP ${res.status}${body.error ? ` — ${body.error.slice(0, 400)}` : ""}`
    throw err
  }

  return body.text
}
