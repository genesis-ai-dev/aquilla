import { compareByCanonicalBookOrder } from "@/lib/file-labeling/bible-book-names"
import type { MessageKey } from "@/lib/i18n/messages/en"

export interface CorpusGroup<T = unknown> {
  /**
   * Stable identity string — the raw corpus marker for a named group, or the
   * literal `"Ungrouped"` sentinel for the synthetic no-marker bucket.
   * Callers compare/key on THIS field (`group.label === "Ungrouped"`,
   * `collapsed.has(group.label)`, …) — it must never be swapped for a
   * translated string, or every one of those comparisons silently breaks in
   * a non-English locale. Named-group values are user/import-authored data
   * (a season name, "OT"/"NT", …) and are correctly never translated either.
   */
  label: string
  /**
   * Set ONLY on the synthetic "Ungrouped" bucket — the catalog key for its
   * user-visible text. `src/lib/` can't call `useT()`, so the caller
   * resolves it with `t()` at render time, falling back to the raw `label`
   * for named groups (`group.labelKey ? t(group.labelKey) : group.label`).
   */
  labelKey?: MessageKey
  files: T[]
}

function normalize(marker: string): string {
  return marker.trim().toLowerCase()
}

// Bible books in OT/NT corpora are sorted canonically (Genesis → Revelation,
// not alphabetically) so the sidebar reads like a Bible (#32). Non-book files
// inside the same corpus fall through the shared comparator to alphabetic. Files
// in a non-OT/NT named corpus (seasons, custom groupings) stay purely
// alphabetic.
function corpusFileCompare(label: string, a: { name: string }, b: { name: string }): number {
  if (label === "OT" || label === "NT") return compareByCanonicalBookOrder(a.name, b.name)
  return a.name.localeCompare(b.name)
}

export function groupByCorpus<T extends { name: string; corpusMarker?: string }>(
  files: T[],
): CorpusGroup<T>[] {
  const groupsByKey = new Map<string, { label: string; files: T[] }>()
  const ungrouped: T[] = []

  for (const file of files) {
    const raw = file.corpusMarker?.trim()
    if (!raw) {
      ungrouped.push(file)
      continue
    }
    const key = normalize(raw)
    const existing = groupsByKey.get(key)
    if (existing) existing.files.push(file)
    else groupsByKey.set(key, { label: raw, files: [file] })
  }

  for (const group of groupsByKey.values()) {
    group.files.sort((a, b) => corpusFileCompare(group.label, a, b))
  }
  // Marker-less files (e.g. existing Codex projects that never carried a
  // corpusMarker) still read like a Bible: canonical book order first, with
  // non-book files falling back to alphabetic. Previously this bucket was
  // purely alphabetic, which is exactly the sidebar complaint in AQU-582.
  ungrouped.sort((a, b) => compareByCanonicalBookOrder(a.name, b.name))

  const named: CorpusGroup<T>[] = Array.from(groupsByKey.values()).sort((a, b) => {
    if (a.label === "OT" && b.label !== "OT") return -1
    if (b.label === "OT" && a.label !== "OT") return 1
    if (a.label === "NT" && b.label !== "NT") return -1
    if (b.label === "NT" && a.label !== "NT") return 1
    return a.label.localeCompare(b.label)
  })

  if (ungrouped.length > 0) {
    // i18n-exempt control-flow identity value, not display text — labelKey
    // carries the translated text; see the CorpusGroup.label doc comment.
    named.push({ label: "Ungrouped", labelKey: "nav.fileList.ungroupedLabel", files: ungrouped })
  }
  return named
}
