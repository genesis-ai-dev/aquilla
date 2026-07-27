export interface CreateUsfmFootnoteMarkerInput {
  caller?: string
  ref?: string
  text: string
}

export function createUsfmFootnoteMarker({
  caller,
  ref,
  text,
}: CreateUsfmFootnoteMarkerInput): string {
  const safeCaller = sanitizeCaller(caller)
  const safeRef = sanitizeFootnoteField(ref ?? "")
  const safeText = sanitizeFootnoteField(text)
  const refPart = safeRef ? ` \\fr ${safeRef}` : ""
  return `\\f ${safeCaller}${refPart} \\ft ${safeText}\\f*`
}

function sanitizeCaller(value: string | undefined): string {
  const trimmed = (value ?? "").trim()
  if (!trimmed) return "+"
  const withoutMarkers = trimmed.replace(/[\\\s]/g, "")
  return withoutMarkers || "+"
}

/**
 * Strip marker-breaking content (stray `\f`/`\f*`, bare backslashes) from a
 * footnote field value while preserving nested character markers
 * (`\bd`/`\it`/`\ul`). Also used on model-produced note translations before
 * they are spliced into a rebuilt marker (reintegrate.ts).
 */
export function sanitizeFootnoteField(value: string): string {
  const protectedMarkers: string[] = []
  const protectedValue = value
    .replace(/\\(?:bd|it|ul)\*?/g, (marker) => {
      protectedMarkers.push(marker)
      return `__FOOTNOTE_MARKER_${protectedMarkers.length - 1}__`
    })

  return protectedValue
    .replace(/\\f\*/g, "")
    .replace(/\\f\b/g, "")
    .replace(/\\/g, "")
    .replace(/__FOOTNOTE_MARKER_(\d+)__/g, (_match, index) => protectedMarkers[Number(index)] ?? "")
    .replace(/\s+/g, " ")
    .trim()
}
