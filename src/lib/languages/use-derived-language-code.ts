import { useEffect, useState } from "react"

import { codeForLanguageLabel } from "@/lib/lanes/backfill-plan"

import { codeFromLanguageCatalog, type LanguageEntry } from "./catalog"
import { loadFullLanguageCatalog, peekFullLanguageCatalog } from "./full-catalog"

/**
 * The code an empty language-code field shows in grey (AQU-1792).
 *
 * Majors and the named varieties ("Traditional Han") resolve immediately.
 * Everyone else waits for the ISO 639-3 catalog, so "Turkana" becomes "tuv"
 * once that list is in memory. A freeform label stays unresolved.
 */
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

  if (immediate) return immediate
  if (!catalog) return null
  return codeFromLanguageCatalog(label, catalog)
}
