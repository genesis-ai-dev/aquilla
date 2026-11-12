import type { ScopePath } from "./types"

/**
 * AQU-1352 spec §3.9: a scope is always written as one breadcrumb string,
 * produced by this helper, so the page title, add-people dialog header,
 * grant chip, inspector row and badge are byte-identical.
 */

/** U+203A SINGLE RIGHT-POINTING ANGLE QUOTATION MARK, space-padded. */
export const SCOPE_SEPARATOR = " › "
/** U+2026 HORIZONTAL ELLIPSIS — placeholder for ancestors the viewer cannot see. */
export const HIDDEN_ANCESTORS = "…"

/**
 * Spec §3.9 rule 4: ancestors marked `hidden` by the server collapse into a
 * single "…" crumb for every caller — "… › Pattani Malay Bible". Visibility
 * travels on the wire, so no caller can forget to truncate.
 */
export function formatScopePath(path: ScopePath): string {
  const names = path.filter((s) => !s.hidden).map((s) => s.name)
  if (names.length < path.length) names.unshift(HIDDEN_ANCESTORS)
  return names.join(SCOPE_SEPARATOR)
}

/** Stable identity for a path (ids, not names) — for React keys and dedup. */
export function scopePathKey(path: ScopePath): string {
  return path.map((s) => `${s.type}:${s.id}`).join("/")
}
