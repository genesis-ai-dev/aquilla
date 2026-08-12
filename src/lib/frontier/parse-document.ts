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
// the user needs an error CODE from the worker (the deferred server-contract
// item), not a passthrough of its prose.

import { AUTH_BASE } from "./auth"
import { t } from "../i18n/standalone"

export const MAX_PARSE_FILE_BYTES = 2 * 1024 * 1024 // 2 MB (must match worker)

export async function parseDocumentFile(file: File, jwt: string): Promise<string> {
  const form = new FormData()
  form.append("file", file)

  const res = await fetch(`${AUTH_BASE}/api/v2/parse-document`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  })

  let body: { text?: string; error?: string } = {}
  try {
    body = (await res.json()) as typeof body
  } catch {
    // non-JSON body — fall through to status check
  }

  if (!res.ok || !body.text) {
    const err = new Error(t("error.parseDocument.failed"))
    err.cause = `HTTP ${res.status}${body.error ? ` — ${body.error.slice(0, 400)}` : ""}`
    throw err
  }

  return body.text
}
