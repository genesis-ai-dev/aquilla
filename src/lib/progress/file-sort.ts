// AQU-499: sort/filter helpers for the per-file breakdown list in
// ProjectOverview. Pure functions so the component stays thin and the
// ordering logic gets direct unit coverage.
//
// Canonical ordering reuses `getBookOrdinal` from
// `@/lib/file-labeling/bible-book-names` — the same 66-book OT/NT ordinal
// map the sidebar's corpus grouping (`group-by-corpus.ts`) already uses to
// sort Bible books by reading order. We deliberately do NOT hardcode a
// second book list here.

import { getBookOrdinal, isKnownBookCode } from "@/lib/file-labeling/bible-book-names"
import type { MessageKey } from "@/lib/i18n/messages/en"

export type FileSortMode = "last-updated" | "canonical" | "alphabetical"

/**
 * Sort-mode picker options. `labelKey` is a catalog key, not a display
 * string — `src/lib/` can't call `useT()`, so the caller resolves it with
 * `t()` at render time (see `ProjectOverview.tsx`).
 */
export const FILE_SORT_MODES: ReadonlyArray<{ value: FileSortMode; labelKey: MessageKey }> = [
  { value: "last-updated", labelKey: "workspace.fileSort.lastUpdated" },
  { value: "canonical", labelKey: "workspace.fileSort.canonical" },
  { value: "alphabetical", labelKey: "workspace.fileSort.alphabetical" },
]

export interface SortableFile {
  name: string
  lastEditAt: number | null
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

/**
 * Best-effort canonical ordinal for a file name. Handles friendly display
 * names ("Genesis"), bare USFM codes ("GEN"), and raw import filenames that
 * carry an extension and/or numeric prefix ("40-MAT.usfm", "GEN.usfm") — the
 * same end/front 3-letter-code shape matching `file-labeling/detect.ts`'s
 * `detectBibleBook` already uses for auto-rename suggestions, reused here
 * for sorting instead. Returns -1 when no book can be resolved.
 */
function canonicalOrdinal(name: string): number {
  const direct = getBookOrdinal(name)
  if (direct >= 0) return direct
  const stem = stripExt(name)
  const endCandidate = stem.match(/([A-Za-z0-9]{3})$/)?.[1]
  const frontCandidate = stem.match(/^([A-Za-z0-9]{3})/)?.[1]
  const code =
    (endCandidate && isKnownBookCode(endCandidate) ? endCandidate : undefined)
    ?? (frontCandidate && isKnownBookCode(frontCandidate) ? frontCandidate : undefined)
  return code ? getBookOrdinal(code) : -1
}

/**
 * Sort a file list by the given mode. Always returns a new array (never
 * mutates the input) so callers can safely pass a live `FileSummary[]`.
 *
 *  - "last-updated" (default): most-recently-progressed first. `lastEditAt
 *    == null` (never edited) sorts last. Ties (including all-null) fall back
 *    to alphabetical by name for a stable, predictable order.
 *  - "canonical": Bible book reading order (Genesis → Revelation) derived
 *    from the file name via `getBookOrdinal`. Files that don't resolve to a
 *    known book (non-Scripture corpora) sort after all known books,
 *    alphabetically among themselves.
 *  - "alphabetical": plain locale-aware name compare.
 */
export function sortFiles<T extends SortableFile>(files: readonly T[], mode: FileSortMode): T[] {
  const copy = [...files]
  switch (mode) {
    case "alphabetical":
      copy.sort((a, b) => a.name.localeCompare(b.name))
      return copy
    case "canonical":
      copy.sort((a, b) => {
        const oa = canonicalOrdinal(a.name)
        const ob = canonicalOrdinal(b.name)
        if (oa >= 0 || ob >= 0) {
          if (oa < 0) return 1
          if (ob < 0) return -1
          if (oa !== ob) return oa - ob
        }
        return a.name.localeCompare(b.name)
      })
      return copy
    case "last-updated":
    default:
      copy.sort((a, b) => {
        if (a.lastEditAt == null && b.lastEditAt == null) return a.name.localeCompare(b.name)
        if (a.lastEditAt == null) return 1
        if (b.lastEditAt == null) return -1
        if (a.lastEditAt !== b.lastEditAt) return b.lastEditAt - a.lastEditAt
        return a.name.localeCompare(b.name)
      })
      return copy
  }
}

/** Case-insensitive substring filter on `name`. Empty/whitespace query returns all files. */
export function filterFilesByName<T extends { name: string }>(files: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...files]
  return files.filter((f) => f.name.toLowerCase().includes(q))
}
