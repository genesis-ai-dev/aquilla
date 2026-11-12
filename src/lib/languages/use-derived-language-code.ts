import { useEffect, useState } from "react"

import { codeForLanguageLabel } from "@/lib/lanes/backfill-plan"

import { codeFromLanguageCatalog, type LanguageEntry } from "./catalog"
import { loadFullLanguageCatalog, peekFullLanguageCatalog } from "./full-catalog"

/**
 * The code an empty language-code field shows in grey (AQU-1792), and the
 * code a suggestion row shows beside the language name (AQU-2049).
 *
 * Majors and the named varieties ("Traditional Han") resolve immediately.
 * Everyone else uses the ISO 639-3 catalog once it is loaded, so "Turkana"
 * becomes "tuv". A freeform label stays unresolved.
 *
 * This is not the catalog row's `code`. French's ISO 639-3 id is "fra";
 * selecting French and leaving the override blank derives "fr".
 */
export function derivedLanguageCode(
  label: string | null | undefined,
  catalog: readonly LanguageEntry[] | null,
): string | null {
  const immediate = codeForLanguageLabel(label)
  if (immediate) return immediate
  if (!catalog) return null
  return codeFromLanguageCatalog(label, catalog)
}

export function useDerivedLanguageCode(label: string | null | undefined): string | null {
  const immediate = codeForLanguageLabel(label)
  const [catalog, setCatalog] = useState<readonly LanguageEntry[] | null>(
    () => peekFullLanguageCatalog(),
  )

  useEffect(() => {
    if (immediate) return
    if (!(label ?? "").trim()) return
    const loaded = peekFullLanguageCatalog()
    if (loaded) {
      setCatalog(loaded)
      return
    }
    let cancelled = false
    void loadFullLanguageCatalog().then(
      (entries) => {
        if (!cancelled) setCatalog(entries)
      },
      () => {
        // The field stays on the generic placeholder. The next edit retries.
      },
    )
    return () => {
      cancelled = true
    }
  }, [immediate, label])

  return derivedLanguageCode(label, catalog)
}
