// Internal ids are RFC-4122 UUIDs. Anything that looks like one must never be
// shown as a human-facing label (tab pills, section strips, breadcrumbs).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function looksLikeUuid(value: string): boolean {
  return UUID_RE.test(value.trim())
}
