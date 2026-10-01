/**
 * AQU-1456 — the full SIL ISO 639-3 suggestion catalog (~7,900 languages),
 * loaded on demand.
 *
 * The bundled `LANGUAGES` set in `./catalog` is ISO 639-1 only (~184 entries),
 * so most low-resource languages our translators work in could not be
 * suggested at all. Codex's project-setup picker offers the whole 639-3 table;
 * this brings the same reach to every Aquilla language field.
 *
 * It is ~145 KB of text, which has no business in the initial bundle, so the
 * table lives in its own module behind a dynamic `import()`. The parse happens
 * once per session and the result is memoized here, shared by every field.
 *
 * Entries keep the `./catalog` shape: `code` is the ISO 639-3 id (displayed as
 * the hint), `altCode` the ISO 639-1 code where SIL lists one, and `name` the
 * reference name — spaced as SIL publishes it ("Eastern Arrernte"), not
 * space-stripped the way Codex's generated array has it.
 */

import type { LanguageEntry } from "./catalog"

/** Resolved catalog, once parsed. Also the `peek` answer. */
let catalog: readonly LanguageEntry[] | null = null
/** In-flight load, so N fields focusing at once share one chunk fetch. */
let pending: Promise<readonly LanguageEntry[]> | null = null

export function parseIso639_3Table(table: string): LanguageEntry[] {
  const entries: LanguageEntry[] = []
  for (const line of table.split("\n")) {
    if (!line) continue
    const [code, altCode, name] = line.split("\t")
    if (!code || !name) continue
    entries.push(altCode ? { code, name, altCode } : { code, name })
  }
  return entries
}

/**
 * The loaded catalog, or `null` while it has never been requested. Lets a
 * freshly mounted field start on the full list instead of flashing the
 * bundled one when another field already paid for the load.
 */
export function peekFullLanguageCatalog(): readonly LanguageEntry[] | null {
  return catalog
}

/**
 * Load (and memoize) the full catalog. Safe to call on every focus/keystroke —
 * repeat calls return the same promise, and a failed load is not cached, so a
 * transient chunk error can be retried by the next keystroke.
 */
export function loadFullLanguageCatalog(): Promise<readonly LanguageEntry[]> {
  if (catalog) return Promise.resolve(catalog)
  pending ??= import("./iso-639-3-table")
    .then(({ ISO_639_3_TABLE }) => {
      catalog = parseIso639_3Table(ISO_639_3_TABLE)
      return catalog
    })
    .catch((error: unknown) => {
      // Leave the picker on the bundled set rather than breaking the field.
      pending = null
      throw error
    })
  return pending
}
