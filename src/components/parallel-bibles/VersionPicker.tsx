// Search the helloao catalogue and pick a Bible version. Used by the
// Parallel Bibles panel and the editor's "Add Bible" menu.

import { useMemo, useState } from "react"
import { Search } from "lucide-react"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { useT } from "@/lib/i18n/I18nProvider"
import type { HelloaoTranslation } from "@/lib/parsers/helloao"
import { ResourcePaneError } from "../ResourcePaneError"

/** Some catalogue entries leave the language names out; a missing field used
 *  to throw on the first keystroke and take the whole pane down. */
export function filterTranslations(
  translations: readonly HelloaoTranslation[],
  query: string,
  exclude: readonly string[],
): HelloaoTranslation[] {
  const q = query.trim().toLowerCase()
  const pool = q
    ? translations.filter((tr) =>
        [tr.id, tr.name, tr.englishName, tr.languageEnglishName, tr.languageName].some(
          (field) => (field ?? "").toLowerCase().includes(q),
        ),
      )
    : translations
  return pool.filter((tr) => !exclude.includes(tr.id)).slice(0, 50)
}

export function VersionPicker({
  translations,
  error,
  onRetry,
  exclude,
  onPick,
}: {
  translations: HelloaoTranslation[] | null
  error: string | null
  onRetry: () => void
  exclude: readonly string[]
  onPick: (id: string) => void
}) {
  const t = useT()
  const [query, setQuery] = useState("")
  const results = useMemo(
    () => (translations ? filterTranslations(translations, query, exclude) : []),
    [translations, query, exclude],
  )
  return (
    <div>
      <InputGroup>
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
        <InputGroupInput
          autoFocus
          placeholder={t("editor.bibles.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("editor.bibles.searchLabel")}
        />
      </InputGroup>
      {error ? (
        <ResourcePaneError
          className="mt-2"
          message={t("editor.bibles.failedToLoad", { error })}
          onRetry={onRetry}
          retryLabel={t("editor.bibles.retryVersions")}
        />
      ) : !translations ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("editor.bibles.loadingVersions")}</p>
      ) : (
        <ul className="mt-2 max-h-48 overflow-y-auto rounded border">
          {results.length === 0 && (
            <li className="p-2 text-xs text-muted-foreground">{t("editor.bibles.noMatches")}</li>
          )}
          {results.map((tr) => (
            <li key={tr.id}>
              <button
                type="button"
                onClick={() => {
                  onPick(tr.id)
                  setQuery("")
                }}
                className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
              >
                <span className="truncate">{tr.englishName || tr.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{tr.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
