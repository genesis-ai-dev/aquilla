import type { ScopeType } from "./types"

/** `type:id` in the access page URL. The id may itself contain colons. */
export function placeParam(scope: { type: string; id: string }): string {
  return `${scope.type}:${scope.id}`
}

export function parsePlaceParam(raw: string | null): { type: ScopeType; id: string } | null {
  if (!raw) return null
  const cut = raw.indexOf(":")
  if (cut <= 0) return null
  const type = raw.slice(0, cut)
  const id = raw.slice(cut + 1)
  if (!id) return null
  if (type !== "org" && type !== "team" && type !== "project" && type !== "lane") return null
  return { type, id }
}

/**
 * AQU-2318: the summary sentence counts rows, not expanded team membership.
 * A team grant is one row (its member count is drawn on the row). The two
 * section totals are these numbers, so the sentence cannot disagree with
 * the lists under it.
 */
export function placeRowCounts(node: {
  directGrantees: readonly unknown[]
  inherited?: readonly unknown[]
}): { granted: number; reaches: number; total: number } {
  const granted = node.directGrantees.length
  const reaches = node.inherited?.length ?? 0
  return { granted, reaches, total: granted + reaches }
}
