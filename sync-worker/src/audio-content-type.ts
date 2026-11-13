// Content-Type hardening for audio/video objects stored in R2.
//
// Split out of `audio.ts` (AQU-1853) so the multipart upload path can reuse it
// without importing the route module back — `audio.ts` imports
// `audio-multipart.ts`, and a runtime import in the other direction would make
// that a cycle. `safeAudioContentType` is still re-exported from `audio.ts`,
// so existing importers (voice-convert, diarization) are unaffected.

// [Pen test] Input validation & injection (2026-08-26): this endpoint stored
// whatever `Content-Type` the uploading client sent and served it back
// verbatim with no `X-Content-Type-Options`, unlike the artifact/knowledge-base
// content routes (see BROWSER_RENDERABLE_CONTENT_TYPES in
// sync-worker/src/external/artifacts-route.ts and OPS-8). A CONTRIBUTOR-scoped
// caller could PUT bytes declared `text/html` at an audioId of their choosing,
// then hand the resulting first-party api.aquilla.app URL to anyone (the GET
// route accepts the sync-token as `?t=`, so the link needs no victim session)
// and have it render as active content. Mirror the same deny-list fix here.
const BROWSER_RENDERABLE_CONTENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "application/javascript",
  "text/javascript",
  "application/x-javascript",
])

// [Pen test] API security & data exposure (2026-11-05): the deny-list above
// missed active/odd types (text/xsl, application/xslt+xml, application/rdf+xml,
// application/mathml+xml, multipart/x-mixed-replace, application/pdf). Switch
// to an allow-list: only audio/*, video/* and the generic/ogg container types
// are echoed back; everything else is stored and served as octet-stream.
const ALLOWED_EXACT_TYPES = new Set(["application/octet-stream", "application/ogg"])

/** Content-Type safe to store/echo back for an audio object. Anything that is
 *  not audio/*, video/* or a generic container type falls back to a
 *  non-executable type — `<audio src>` playback doesn't care about the exact
 *  declared subtype, so this costs no real functionality. */
export function safeAudioContentType(raw: string | null | undefined): string {
  const normalized = (raw ?? "").split(";")[0].trim().toLowerCase()
  if (!normalized || BROWSER_RENDERABLE_CONTENT_TYPES.has(normalized)) {
    return "application/octet-stream"
  }
  if (
    ALLOWED_EXACT_TYPES.has(normalized) ||
    /^(audio|video)\/[a-z0-9][a-z0-9.+-]*$/.test(normalized)
  ) {
    return raw as string
  }
  return "application/octet-stream"
}
