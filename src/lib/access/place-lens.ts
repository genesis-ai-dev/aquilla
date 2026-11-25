import type { ScopeRef, ScopeType } from "./types"

/** A place node the lens can filter. Structural so the worker payload and the SPA share it. */
export interface PlaceFilterNode {
  scope: Pick<ScopeRef, "name">
  children: PlaceFilterNode[]
  directGrantees: readonly { displayName: string; email?: string | null }[]
  inherited?: readonly { displayName?: string; email?: string | null }[]
}

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

function nodeTextHits(node: PlaceFilterNode, q: string): boolean {
  if (node.scope.name.toLowerCase().includes(q)) return true
  const people = [...node.directGrantees, ...(node.inherited ?? [])]
  return people.some((person) =>
    person.displayName?.toLowerCase().includes(q) || person.email?.toLowerCase().includes(q),
  )
}

/**
 * Keep a place when its name or one of its people matches, and keep ancestors
 * of a match. A matching place keeps its children so it can still be opened.
 */
export function filterPlaceTree<T extends PlaceFilterNode>(nodes: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...nodes]
  const kept: T[] = []
  for (const node of nodes) {
    const children = filterPlaceTree(node.children as T[], query)
    if (nodeTextHits(node, q)) kept.push(node)
    else if (children.length > 0) kept.push({ ...node, children } as T)
  }
  return kept
}
