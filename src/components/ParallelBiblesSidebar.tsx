// Parallel Bibles sidebar — translator's helps backed by the Free Use Bible
// API (bible.helloao.org). Shows the currently-viewed verse across the bible
// versions the user has pinned, auto-tracking scroll position in the editor.
//
// API kindness: only per-chapter endpoints are used (the granularity the API
// is designed for), fetches fire only while the panel is open, chapter
// responses are promise-cached in the helloao client (scrolling within a
// chapter costs zero requests), and chapter changes are debounced so fast
// scrolling doesn't burst-fetch every chapter passed over.
//
// Pinned versions persist in localStorage per user (not project settings) —
// helps are a personal reading aid, not project data.

import { useEffect, useMemo, useRef, useState } from "react"
import {
  fetchHelloaoChapter,
  fetchHelloaoTranslations,
  flattenHelloaoContent,
  type HelloaoTranslation,
} from "@/lib/parsers/helloao"
import { cn } from "@/lib/utils"
import { BookMarked, Plus, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AppTooltip } from "@/components/ui/tooltip"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"

const VERSIONS_STORAGE_KEY = "codex:parallel-bibles:versions"
const OPEN_STORAGE_KEY_PREFIX = "codex:parallel-bibles:"

function openStateKey(projectId: string): string {
  return `${OPEN_STORAGE_KEY_PREFIX}${projectId}:open`
}

export function readParallelBiblesOpen(projectId: string): boolean {
  try {
    return window.localStorage.getItem(openStateKey(projectId)) === "true"
  } catch {
    return false
  }
}

export function writeParallelBiblesOpen(projectId: string, value: boolean): void {
  try {
    window.localStorage.setItem(openStateKey(projectId), value ? "true" : "false")
  } catch {
    // localStorage may be unavailable — ignore
  }
}

function readPinnedVersions(): string[] {
  try {
    const raw = window.localStorage.getItem(VERSIONS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}

function writePinnedVersions(ids: string[]): void {
  try {
    window.localStorage.setItem(VERSIONS_STORAGE_KEY, JSON.stringify(ids))
  } catch {
    // ignore
  }
}

/** Parse a canonical ref ("GEN 1:1", "GEN 1", "GEN 1:s:1") into its parts.
 *  The verse is absent for chapter-scoped and heading refs. */
export function parseCanonicalRef(
  ref: string
): { book: string; chapter: number; verse: number | null } | null {
  const m = /^([0-9A-Z]{3})\s+(\d+)(?::(\d+))?/.exec(ref.trim().toUpperCase())
  if (!m) return null
  return {
    book: m[1],
    chapter: Number(m[2]),
    verse: m[3] ? Number(m[3]) : null,
  }
}

interface ParallelBiblesSidebarProps {
  /** Canonical ref of the first visible editor row (e.g. "GEN 1:1"). */
  trackedRef: string | null
  open: boolean
  onToggle: () => void
  className?: string
}

interface VersionVerses {
  /** verse number → flattened text for the loaded chapter */
  verses: Map<number, string>
  error?: string
}

export function ParallelBiblesSidebar({ trackedRef, open, onToggle, className }: ParallelBiblesSidebarProps) {
  const t = useT()
  const [pinned, setPinned] = useState<string[]>(() => readPinnedVersions())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [translations, setTranslations] = useState<HelloaoTranslation[] | null>(null)
  const [translationsErr, setTranslationsErr] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  // (version id, book, chapter) → loaded verses, rebuilt as the chapter changes
  const [chapterData, setChapterData] = useState<Map<string, VersionVerses>>(new Map())

  // Hold the last parseable ref so headings / unrefed rows don't blank the panel.
  const lastParsedRef = useRef<{ book: string; chapter: number; verse: number | null } | null>(null)
  const parsed = trackedRef ? parseCanonicalRef(trackedRef) : null
  if (parsed) lastParsedRef.current = parsed
  const tracked = parsed ?? lastParsedRef.current

  // Debounced chapter key — fast scrolling across chapters shouldn't fetch
  // every chapter passed over.
  const chapterKey = tracked ? `${tracked.book}/${tracked.chapter}` : null
  const [debouncedChapterKey, setDebouncedChapterKey] = useState(chapterKey)
  useEffect(() => {
    if (chapterKey === debouncedChapterKey) return
    const t = window.setTimeout(() => setDebouncedChapterKey(chapterKey), 250)
    return () => window.clearTimeout(t)
  }, [chapterKey, debouncedChapterKey])

  // Load the translations list lazily: when the picker opens, or when the
  // panel is open with pinned versions (so cards show names, not raw ids).
  const needTranslations = pickerOpen || (open && pinned.length > 0)
  useEffect(() => {
    if (!needTranslations || translations || translationsErr) return
    let cancelled = false
    fetchHelloaoTranslations()
      .then((list) => {
        if (!cancelled) setTranslations(list)
      })
      .catch((err) => {
        if (!cancelled) setTranslationsErr(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [needTranslations, translations, translationsErr])

  // Fetch the tracked chapter for every pinned version. fetchHelloaoChapter
  // promise-caches per (version, book, chapter) so repeat visits are free.
  useEffect(() => {
    if (!open || !debouncedChapterKey || pinned.length === 0) return
    const [book, chapterStr] = debouncedChapterKey.split("/")
    const chapter = Number(chapterStr)
    let cancelled = false

    for (const versionId of pinned) {
      fetchHelloaoChapter(versionId, book, chapter)
        .then((res) => {
          if (cancelled) return
          const verses = new Map<number, string>()
          for (const node of res.chapter.content) {
            if (node.type === "verse") {
              verses.set(node.number, flattenHelloaoContent(node.content))
            }
          }
          setChapterData((prev) => {
            const next = new Map(prev)
            next.set(`${versionId}/${book}/${chapter}`, { verses })
            return next
          })
        })
        .catch((err) => {
          if (cancelled) return
          setChapterData((prev) => {
            const next = new Map(prev)
            next.set(`${versionId}/${book}/${chapter}`, {
              verses: new Map(),
              error: err instanceof Error ? err.message : String(err),
            })
            return next
          })
        })
    }
    return () => {
      cancelled = true
    }
  }, [open, debouncedChapterKey, pinned])

  function pinVersion(id: string) {
    setPinned((prev) => {
      if (prev.includes(id)) return prev
      const next = [...prev, id]
      writePinnedVersions(next)
      return next
    })
    setPickerOpen(false)
    setQuery("")
  }

  function unpinVersion(id: string) {
    setPinned((prev) => {
      const next = prev.filter((v) => v !== id)
      writePinnedVersions(next)
      return next
    })
  }

  const translationById = useMemo(() => {
    const map = new Map<string, HelloaoTranslation>()
    for (const t of translations ?? []) map.set(t.id, t)
    return map
  }, [translations])

  const filteredTranslations = useMemo(() => {
    if (!translations) return []
    const q = query.trim().toLowerCase()
    const pool = q
      ? translations.filter(
          (t) =>
            t.id.toLowerCase().includes(q) ||
            t.name.toLowerCase().includes(q) ||
            t.englishName.toLowerCase().includes(q) ||
            t.languageEnglishName.toLowerCase().includes(q) ||
            t.languageName.toLowerCase().includes(q)
        )
      : translations
    return pool.filter((t) => !pinned.includes(t.id)).slice(0, 50)
  }, [translations, query, pinned])

  // Closed: slim edge tab so the helps are one click away while reading.
  if (!open) {
    return (
      <AppTooltip content={t("editor.bibles.openTooltip")} side="left">
        <button
          type="button"
          onClick={onToggle}
          aria-label={t("editor.bibles.show")}
          className={cn(
            "hidden h-full w-9 shrink-0 flex-col items-center gap-1.5 border-l bg-background pt-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:flex",
            className,
          )}
        >
          <BookMarked className="h-4 w-4" />
          <span className="text-sm font-semibold tracking-wide [writing-mode:vertical-rl]">
            {t("editor.bibles.edgeTab")}
          </span>
        </button>
      </AppTooltip>
    )
  }

  const trackedLabel = tracked
    ? `${tracked.book} ${tracked.chapter}${tracked.verse ? `:${tracked.verse}` : ""}`
    : null

  return (
    <div className={cn("hidden h-full w-80 shrink-0 flex-col border-l bg-card text-sm sm:flex", className)}>
      {/* Header — p-2 matches the other side panels' header strip. */}
      <div className="flex items-center justify-between border-b p-2">
        <div className="flex items-center gap-1.5 font-medium">
          <BookMarked className="h-4 w-4 text-muted-foreground" />
          <span>{t("editor.bibles.title")}</span>
          {trackedLabel && (
            <span className="rounded bg-muted px-1 py-0.5 text-xs font-mono text-muted-foreground">
              {trackedLabel}
            </span>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("editor.bibles.hide")}
          onClick={onToggle}
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {!tracked ? (
          <p className="p-4 text-xs text-muted-foreground">
            {t("editor.bibles.scrollHint")}
          </p>
        ) : pinned.length === 0 && !pickerOpen ? (
          <p className="p-4 text-xs text-muted-foreground">
            {t("editor.bibles.noVersions")}
          </p>
        ) : (
          <div className="divide-y">
            {pinned.map((versionId) => {
              const data = chapterData.get(`${versionId}/${tracked.book}/${tracked.chapter}`)
              const meta = translationById.get(versionId)
              const verseText =
                tracked.verse !== null ? data?.verses.get(tracked.verse) : undefined
              return (
                <div key={versionId} className="group px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground/70">
                      {meta ? (meta.shortName || meta.id) : versionId}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("editor.bibles.removeVersion", { version: versionId })}
                      onClick={() => unpinVersion(versionId)}
                      className="text-muted-foreground/0 transition-colors hover:text-foreground group-hover:text-muted-foreground"
                    >
                      <X />
                    </Button>
                  </div>
                  {data?.error ? (
                    <p className="mt-1 text-xs text-destructive">{data.error}</p>
                  ) : !data ? (
                    <p className="mt-1 text-xs text-muted-foreground">{t("common.loading")}</p>
                  ) : tracked.verse === null ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("editor.bibles.scrollToVerse")}
                    </p>
                  ) : verseText ? (
                    <p className="mt-1 text-xs leading-relaxed text-foreground/90">{verseText}</p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("editor.bibles.noTextForRef", { ref: trackedLabel ?? "" })}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Version picker */}
        {pickerOpen && (
          <div className="border-t p-3">
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
            {translationsErr ? (
              <p className="mt-2 text-xs text-destructive">{t("editor.bibles.failedToLoad", { error: translationsErr })}</p>
            ) : !translations ? (
              <p className="mt-2 text-xs text-muted-foreground">{t("editor.bibles.loadingVersions")}</p>
            ) : (
              <ul className="mt-2 max-h-48 overflow-y-auto rounded border">
                {filteredTranslations.length === 0 && (
                  <li className="p-2 text-xs text-muted-foreground">{t("editor.bibles.noMatches")}</li>
                )}
                {filteredTranslations.map((t) => (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => pinVersion(t.id)}
                      className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      <span className="truncate">{t.englishName || t.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {t.id}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Footer: add-version + attribution */}
      <div className="border-t px-3 py-2">
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
          {pickerOpen ? t("editor.bibles.closePicker") : t("editor.bibles.addVersion")}
        </button>
        <p className="mt-1 text-[10px] text-muted-foreground/60">
          {t("editor.bibles.attribution")}{" "}
          <a
            href="https://bible.helloao.org/"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            Free Use Bible API
          </a>
        </p>
      </div>
    </div>
  )
}
