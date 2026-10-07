// OPS-30 (docs/OPSEC-REVIEW-2026-09-14.md): keep the *document's own text* out
// of parser error messages.
//
// Import failures are telemetry: `ImportDialog`/`UploadPanel` send the thrown
// message to PostHog as `IMPORT_FAILED.error_message` and again through
// `captureException`. That is fine for "this file isn't valid XLIFF" and not
// fine for a slice of the file, because a source or draft passage identifies
// the passage, the language, and therefore the project — the D2/D3 linkage this
// product's threat model turns on.
//
// V8's `JSON.parse` message quotes the input verbatim:
//   Unexpected token 'T', ..."{"verse": The LORD i"... is not valid JSON
// and a browser's `<parsererror>` text can quote markup the same way. This
// strips those quoted spans while keeping every structural detail a person
// debugging an import actually uses — the token, the position, the line and
// column.

/** Replaces a quoted slice of the source document. */
const ELLIPSIS = "…"

/**
 * Strip document-derived quoted spans out of a parser's error detail.
 *
 * Handles both shapes V8 emits (`..."snippet"...` when the error is mid-document,
 * `"snippet"...` when it is at the start) and collapses the whitespace a
 * browser's `<parsererror>` text arrives with. Everything else — including the
 * offending token character and any `at position N (line L column C)` — is
 * preserved: it is diagnostic, not content.
 */
export function sanitizeParseDetail(detail: string): string {
  return detail
    .replace(/\.\.\."[\s\S]*?"\.\.\./g, ELLIPSIS)
    .replace(/"[\s\S]*?"\.\.\./g, ELLIPSIS)
    .replace(/\s+/g, " ")
    .trim()
}

/** Sanitize an unknown thrown value into a telemetry-safe detail string. */
export function sanitizeThrownDetail(err: unknown): string {
  return sanitizeParseDetail(err instanceof Error ? err.message : String(err))
}
