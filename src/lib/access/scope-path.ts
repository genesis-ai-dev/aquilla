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

export interface FormatScopePathOptions {
  /**
   * Number of leading crumbs the viewer may not see (spec §3.9 rule 4). They
   * collapse into a single "…" crumb: "… › Pattani Malay Bible".
   */
  truncateBefore?: number
}

export function formatScopePath(path: ScopePath, opts: FormatScopePathOptions = {}): string {
  const hidden = Math.min(Math.max(opts.truncateBefore ?? 0, 0), path.length)
  const names = path.slice(hidden).map((s) => s.name)
  if (hidden > 0) names.unshift(HIDDEN_ANCESTORS)
  return names.join(SCOPE_SEPARATOR)
}

/** Stable identity for a path (ids, not names) — for React keys and dedup. */
export function scopePathKey(path: ScopePath): string {
  return path.map((s) => `${s.type}:${s.id}`).join("/")
}
