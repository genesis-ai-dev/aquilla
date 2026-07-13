// parse-document client helper — AQU-197
//
// Uploads a .pdf or .docx file to the auth-worker's /api/v2/parse-document
// endpoint and returns the extracted plain text. Throws with a human-readable
// message on HTTP errors or parse failures.

import { AUTH_BASE } from "./auth"

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

  if (!res.ok) {
    throw new Error(body.error ?? `Document parse failed (HTTP ${res.status}).`)
  }

  if (!body.text) {
    throw new Error("Worker returned empty text.")
  }

  return body.text
}
