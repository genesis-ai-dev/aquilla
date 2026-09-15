import { compareByCanonicalBookOrder, bookCodeFromFileName } from "@/lib/file-labeling/bible-book-names"
import { getTestament } from "@/lib/codex-editor/bible-books"
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
  /**
   * Set ONLY when at least one member landed here through the AQU-1084
   * fallback (no `corpusMarker`; testament derived from `bookCode` or, for
   * migrated files, from the file name) rather than through its own marker. `renameCorpus` matches on `corpusMarker`, so
   * renaming such a group would skip those members — callers hide the rename
   * affordance when this is set.
   */
  derived?: true
  files: T[]
}

/** The subset of a file the grouping reads. `type` is a plain string rather
 *  than `FileType` because migrated Codex projects arrive with `"codex"`,
 *  which the union does not name (see `src/lib/migrate/map.ts`). */
export interface GroupableFile {
  name: string
  corpusMarker?: string
  bookCode?: string
  type?: string
  hasScriptureContent?: boolean
}

// File types whose members may be Scripture books even when the record
// carries no `bookCode`: the native Scripture formats, plus `"codex"`, the
// kind the legacy-project migrator stamps on every non-IDML file. A file of
// any other type that happens to be named "ACT" is not a Bible book.
const NAME_FALLBACK_TYPES: ReadonlySet<string> = new Set(["usfm", "ebible", "helloao", "codex"])

function mayBeScripture(file: GroupableFile): boolean {
  return file.hasScriptureContent === true || (file.type !== undefined && NAME_FALLBACK_TYPES.has(file.type))
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

/**
 * The marker a file groups under. `corpusMarker` always wins so custom
 * groupings (seasons, series, …) are untouched. It is client-local state
 * though, and often missing after a reload or on a fresh device (see
 * `src/lib/file-labeling/detect.ts`), which used to drop every Bible book
 * into "Ungrouped" exactly when a new user opened the project. When it is
 * absent, the server-backed `bookCode` still tells us the testament (AQU-1084).
 *
 * Projects migrated from legacy Codex carry neither: the migrator never sets
 * `bookCode` (`src/lib/migrate/map.ts`) and the rename banner that would set
 * `corpusMarker` skips their `"codex"` type. Their files are named by bare
 * book code ("1CH"), so as a last resort the code is read off the file name,
 * with the same rule the rename detector uses, for scripture-capable files
 * only (PR #504 review, 2026-09-07).
 */
function resolveMarker(file: GroupableFile): { marker: string; derived: boolean } | null {
  const raw = file.corpusMarker?.trim()
  if (raw) return { marker: raw, derived: false }
  const code = file.bookCode || (mayBeScripture(file) ? bookCodeFromFileName(file.name) : undefined)
  const testament = code ? getTestament(code) : undefined
  if (testament) return { marker: testament, derived: true }
  return null
}

export function groupByCorpus<T extends GroupableFile>(
  files: T[],
): CorpusGroup<T>[] {
  const groupsByKey = new Map<string, CorpusGroup<T>>()
  const ungrouped: T[] = []

  for (const file of files) {
    const resolved = resolveMarker(file)
    if (!resolved) {
      ungrouped.push(file)
      continue
    }
    const key = normalize(resolved.marker)
    const existing = groupsByKey.get(key)
    if (existing) {
      existing.files.push(file)
      if (resolved.derived) existing.derived = true
    } else {
      const group: CorpusGroup<T> = { label: resolved.marker, files: [file] }
      if (resolved.derived) group.derived = true
      groupsByKey.set(key, group)
    }
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
