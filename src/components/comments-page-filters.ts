// Pure filter/sort helpers for the project comments page.
// Kept out of CommentsPage.tsx so Fast Refresh can update the component
// without a full reload (component files must not export non-components).

import type { CommentRecord } from "@/lib/sync/comments-read-types"
import type { TFunction } from "@/lib/i18n/I18nProvider"
import { translate } from "@/lib/i18n/translate"

export type SortOrder = "recent-activity" | "creation" | "unresolved-first"

export interface FilterState {
  /** AQU-1958: "" = every project. Only the org-wide view ever sets this —
   *  the project page's list is one project by construction. */
  projectId: string
  fileId: string    // "" = all
  authorId: string  // "" = all
  participant: string // "" = all
  showResolved: boolean
  search: string    // client-side substring search over body
  /** AQU-1958: inclusive `YYYY-MM-DD` bounds on when the thread was started;
   *  "" = unbounded on that end. */
  from: string
  to: string
  sort: SortOrder
}

export const DEFAULT_FILTER: FilterState = {
  projectId: "",
  fileId: "",
  authorId: "",
  participant: "",
  showResolved: false,
  search: "",
  from: "",
  to: "",
  sort: "unresolved-first",
}

/**
 * Epoch bounds for a `YYYY-MM-DD` filter value, in the reader's own timezone —
 * someone who picks "2 Oct" means their 2 Oct, not UTC's. `from` is the start
 * of that day and `to` the end of it, so both ends are inclusive. Returns null
 * for "" and for anything that isn't a calendar date (a half-typed value from
 * a text-input fallback), which reads as "no bound" rather than "nothing
 * matches".
 */
export function dayBound(value: string, edge: "start" | "end"): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!match) return null
  const [, year, month, day] = match
  const date = edge === "start"
    ? new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0)
    : new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999)
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

export function applyFilters(
  roots: CommentRecord[],
  repliesByParent: Map<string, CommentRecord[]>,
  filter: FilterState,
): CommentRecord[] {
  return roots.filter((root) => {
    // show-resolved toggle
    if (!filter.showResolved && root.resolved) return false

    // project filter (org-wide view)
    if (filter.projectId && root.projectId !== filter.projectId) return false

    // file filter
    if (filter.fileId && root.fileId !== filter.fileId) return false

    // date range — on when the thread was started, which is what a reviewer
    // asking "what came in last week" means.
    const from = dayBound(filter.from, "start")
    if (from != null && root.createdAt < from) return false
    const to = dayBound(filter.to, "end")
    if (to != null && root.createdAt > to) return false

    // author filter — matches root author
    if (filter.authorId && root.authorId !== filter.authorId) return false

    // participant filter — root author OR any reply author
    if (filter.participant) {
      const replies = repliesByParent.get(root.commentId) ?? []
      const allAuthors = [root.authorId, ...replies.map((r) => r.authorId)]
      if (!allAuthors.includes(filter.participant)) return false
    }

    // body search — substring over root body + replies
    if (filter.search.trim()) {
      const needle = filter.search.trim().toLowerCase()
      const haystack = [
        root.body,
        ...(repliesByParent.get(root.commentId) ?? []).map((r) => r.body),
      ]
        .join(" ")
        .toLowerCase()
      // SWARM-TODO: wire true FTS5 endpoint when available (pass ?q= to sync-worker)
      if (!haystack.includes(needle)) return false
    }

    return true
  })
}

export function applySorting(roots: CommentRecord[], sort: SortOrder): CommentRecord[] {
  const copy = [...roots]
  if (sort === "unresolved-first") {
    copy.sort((a, b) => {
      if (a.resolved !== b.resolved) return a.resolved ? 1 : -1
      return b.createdAt - a.createdAt
    })
  } else if (sort === "creation") {
    copy.sort((a, b) => b.createdAt - a.createdAt)
  } else if (sort === "recent-activity") {
    copy.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  return copy
}

/**
 * Count how many list-narrowing filters are active. `sort` is excluded (it is
 * always set and never narrows the list); `search` is trimmed so a
 * whitespace-only query — which `applyFilters` ignores — doesn't read as active.
 */
export function countActiveFilters(filter: FilterState): number {
  return [
    filter.projectId,
    filter.fileId,
    filter.authorId,
    filter.participant,
    filter.showResolved ? "1" : "",
    filter.search.trim(),
    filter.from.trim(),
    filter.to.trim(),
  ].filter(Boolean).length
}

/**
 * AQU-650: the header count badge. When any filter is active it reflects what
 * the user is actually looking at — the number of visible threads (top-level
 * comments) in the filtered list below, including 0 when nothing matches. With
 * no filters active it shows the project total comment count, exactly as before.
 */
export function headerBadgeCount(
  totalComments: number,
  visibleThreadCount: number,
  activeFilterCount: number,
): number {
  return activeFilterCount > 0 ? visibleThreadCount : totalComments
}

/**
 * Resolve a fileId to a display name, or return a tombstone if not found.
 * `t` is optional so this pure helper stays callable from tests without a
 * provider; callers that render UI always pass the real translator.
 */
export function resolveFileName(
  fileId: string | null | undefined,
  fileMap: Map<string, string>,
  t: TFunction = (key, vars) => translate(undefined, key, vars),
): { name: string; exists: boolean } {
  if (!fileId) return { name: t("comments.file.unknown"), exists: false }
  const name = fileMap.get(fileId)
  if (name !== undefined) return { name, exists: true }
  return { name: t("comments.file.deleted"), exists: false }
}
