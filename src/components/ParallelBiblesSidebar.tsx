// Parallel Bibles sidebar — translator's helps backed by the Free Use Bible
// API (bible.helloao.org). Shows the currently-viewed verse across the bible
// versions the user has pinned, auto-tracking scroll position in the editor.
// Two views: one verse per version (the narrow default), or whole chapters
// side by side in columns that keep in step with the editor.
//
// Chapter loading (and its API-kindness rules) lives in useParallelChapters.
// Which versions show: the translator's own pins for this project, else the
// project's defaults a lead set (lib/parallel-bibles/pinned-versions.ts).
// Every version carries a short credit with its licence link.

import { useEffect, useMemo, useRef, useState } from "react"
import { fetchHelloaoTranslations, type HelloaoTranslation } from "@/lib/parsers/helloao"
import { cn } from "@/lib/utils"
import { BookMarked, Columns3, Plus, Rows2, Search, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { ErrorBoundary } from "./ErrorBoundary"
import { ResourcePaneCrash, ResourcePaneError } from "./ResourcePaneError"
import { RightSidebarPanel } from "./RightSidebarPanel"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  clearPersonalPins,
  readPersonalPins,
  resolvePinnedVersions,
  sameVersionList,
  writePersonalPins,
} from "@/lib/parallel-bibles/pinned-versions"
import { alignVersion, mapEnglishRef, versificationScheme } from "@/lib/parallel-bibles/versification"
import { verseTextPresentation, verseTextStyle } from "@/lib/parallel-bibles/version-display"
import { chapterKey } from "./parallel-bibles/chapter-data"
import { PassageColumns, type PassageColumn } from "./parallel-bibles/PassageColumns"
import { useParallelChapters } from "./parallel-bibles/useParallelChapters"
import { VersificationMark } from "./parallel-bibles/VersificationMark"
import { VersionCredit } from "./parallel-bibles/VersionCredit"

const OPEN_STORAGE_KEY_PREFIX = "aquilla:parallel-bibles:"
const VIEW_STORAGE_KEY = "aquilla:parallel-bibles:view"

type BiblesView = "verse" | "passage"

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

/** Half the window: room for two or three columns beside a usable editor. */
function passageDefaultWidth(): number {
  const viewport = typeof window === "undefined" ? 1280 : window.innerWidth
  return Math.min(1100, Math.max(480, Math.round(viewport * 0.5)))
}

function readView(): BiblesView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "passage" ? "passage" : "verse"
  } catch {
    return "verse"
  }
}

function writeView(view: BiblesView): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view)
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
  /** Keys the translator's own pins per project. Absent: the one global list. */
  projectId?: string
  /** The project's default versions, shown while the translator has no pins of their own. */
  projectDefaults?: readonly string[]
  /** Project lead and up: may save the shown versions as the project defaults. */
  canSetProjectDefaults?: boolean
  /** Saves the project defaults; resolves true when the server took them. */
  onSetProjectDefaults?: (ids: string[]) => Promise<boolean>
}

/** A render throw inside the pane stays inside the pane (AQU-849) — without
 *  this the nearest boundary is AppShell's, which takes the whole workspace
 *  down until the translator reloads the page. */
export function ParallelBiblesSidebar(props: ParallelBiblesSidebarProps) {
  return (
    <ErrorBoundary
      label="parallel-bibles-sidebar"
      fallback={(reset) => <ResourcePaneCrash onRetry={reset} />}
    >
      <ParallelBiblesSidebarBody {...props} />
    </ErrorBoundary>
  )
}

function ParallelBiblesSidebarBody({
  trackedRef,
  open,
  onToggle,
  className,
  projectId,
  projectDefaults,
  canSetProjectDefaults = false,
  onSetProjectDefaults,
}: ParallelBiblesSidebarProps) {
  const t = useT()
  const [personal, setPersonal] = useState<string[] | null>(() => readPersonalPins(projectId))
  const [view, setView] = useState<BiblesView>(() => readView())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [translations, setTranslations] = useState<HelloaoTranslation[] | null>(null)
  const [translationsErr, setTranslationsErr] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [defaultsStatus, setDefaultsStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  // Bumped by the inline Retry buttons. A lookup that failed while the reader
  // stays on one verse has nothing else to re-trigger its effect, which is why
  // a dead pane used to need a page reload (AQU-849).
  const [retryNonce, setRetryNonce] = useState(0)

  const resolved = resolvePinnedVersions(personal, projectDefaults)
  // One string so a fresh-but-equal defaults array doesn't refetch.
  const pinnedKey = resolved.ids.join(",")
  const pinned = useMemo(() => (pinnedKey ? pinnedKey.split(",") : []), [pinnedKey])

  // Hold the last parseable ref so headings / unrefed rows don't blank the panel.
  const lastParsedRef = useRef<{ book: string; chapter: number; verse: number | null } | null>(null)
  const parsed = trackedRef ? parseCanonicalRef(trackedRef) : null
  if (parsed) lastParsedRef.current = parsed
  const tracked = parsed ?? lastParsedRef.current

  // Load the translations list lazily: when the picker opens, or when the
  // panel is open with pinned versions (names, credits, script and numbering
  // all come from it). `translationsErr` guards against a retry loop; clearing
  // it from Retry is what re-arms the fetch.
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

  const translationById = useMemo(() => {
    const map = new Map<string, HelloaoTranslation>()
    for (const tr of translations ?? []) map.set(tr.id, tr)
    return map
  }, [translations])

  const { chapterData, forget } = useParallelChapters({
    open,
    pinned,
    tracked,
    translationById,
    retryNonce,
  })

  function savePersonal(next: string[]) {
    setPersonal(next)
    writePersonalPins(projectId, next)
    setDefaultsStatus("idle")
  }

  function pinVersion(id: string) {
    if (!pinned.includes(id)) savePersonal([...pinned, id])
    setPickerOpen(false)
    setQuery("")
  }

  function unpinVersion(id: string) {
    savePersonal(pinned.filter((v) => v !== id))
  }

  function followProjectDefaults() {
    if (projectId) clearPersonalPins(projectId)
    setPersonal(null)
  }

  async function makeProjectDefaults() {
    if (!onSetProjectDefaults) return
    setDefaultsStatus("saving")
    const ok = await onSetProjectDefaults([...pinned])
    if (ok) followProjectDefaults()
    setDefaultsStatus(ok ? "saved" : "failed")
  }

  function toggleView() {
    const next = view === "verse" ? "passage" : "verse"
    setView(next)
    writeView(next)
  }

  const filteredTranslations = useMemo(() => {
    if (!translations) return []
    const q = query.trim().toLowerCase()
    const pool = q
      ? translations.filter((tr) =>
          // Some catalogue entries leave these out; one missing name used to
          // throw on the first keystroke and take the pane down.
          [tr.id, tr.name, tr.englishName, tr.languageEnglishName, tr.languageName].some(
            (field) => (field ?? "").toLowerCase().includes(q),
          ),
        )
      : translations
    return pool.filter((tr) => !pinned.includes(tr.id)).slice(0, 50)
  }, [translations, query, pinned])

  // Closed: slim edge tab so the helps are one click away while reading.
  if (!open) {
    return (
      // Its word names it: no hover (AQU-2260).
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
    )
  }

  const trackedLabel = tracked
    ? `${tracked.book} ${tracked.chapter}${tracked.verse ? `:${tracked.verse}` : ""}`
    : null

  const labelOf = (id: string) => {
    const meta = translationById.get(id)
    return meta ? meta.shortName || meta.id : id
  }

  // The first English-numbered version that has this chapter is the yardstick
  // the psalm-title and verse-count checks compare the others against (a Greek
  // New Testament pinned first has no Psalms to compare).
  const columns: PassageColumn[] = []
  if (tracked) {
    const referenceId = pinned.find((id) => {
      if (versificationScheme(translationById.get(id)?.language) !== "english") return false
      const data = chapterData.get(chapterKey(id, tracked.book, tracked.chapter))
      return !!data && !data.error && data.shape.verseCount > 0
    })
    const refData = referenceId
      ? chapterData.get(chapterKey(referenceId, tracked.book, tracked.chapter))
      : undefined
    const reference = referenceId && refData
      ? { ...refData.shape, versionLabel: labelOf(referenceId) }
      : undefined
    for (const versionId of pinned) {
      const meta = translationById.get(versionId)
      const scheme = versificationScheme(meta?.language)
      const mapped = mapEnglishRef(scheme, tracked.book, tracked.chapter, tracked.verse)
      const data = chapterData.get(chapterKey(versionId, tracked.book, mapped.chapter))
      const loaded = data && !data.error && data.shape.verseCount > 0 ? data.shape : undefined
      const alignment = alignVersion({
        scheme,
        book: tracked.book,
        chapter: tracked.chapter,
        verse: tracked.verse,
        loaded,
        reference: reference && { ...reference, isSelf: versionId === referenceId },
      })
      columns.push({ versionId, label: labelOf(versionId), meta, book: tracked.book, alignment, data })
    }
  }

  const retryColumn = (column: PassageColumn) => {
    // Drop the latched failure first, so the retry shows the spinner rather
    // than the error it is clearing.
    forget(chapterKey(column.versionId, column.book, column.alignment.chapter))
    setRetryNonce((n) => n + 1)
  }

  const passage = view === "passage" && !!tracked && pinned.length > 0
  const differsFromDefaults = !sameVersionList(pinned, projectDefaults)
  const showMakeDefaults =
    canSetProjectDefaults && !!onSetProjectDefaults && resolved.source === "personal"
    && pinned.length > 0 && differsFromDefaults
  const showFollowDefaults =
    resolved.source === "personal" && (projectDefaults?.length ?? 0) > 0 && differsFromDefaults

  return (
    <RightSidebarPanel
      key={view}
      storageKey={view === "passage" ? "parallel-bibles-passage" : "parallel-bibles"}
      defaultWidth={view === "passage" ? passageDefaultWidth() : 320}
      minWidth={view === "passage" ? 480 : 300}
      maxWidth={view === "passage" ? 1400 : undefined}
      className={cn("hidden sm:flex", className)}
      resizeLabel="Resize parallel bibles panel"
    >
    <div className="flex h-full w-full flex-col border-l bg-card text-sm">
      {/* Header — p-2 matches the other side panels' header strip. */}
      <div className="flex items-center justify-between gap-2 border-b p-2">
        <div className="flex min-w-0 items-center gap-1.5 font-medium">
          <BookMarked className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{t("editor.bibles.title")}</span>
          {trackedLabel && (
            <span className="rounded bg-muted px-1 py-0.5 text-xs font-mono text-muted-foreground">
              {trackedLabel}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={view === "passage"}
            onClick={toggleView}
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          >
            {view === "verse" ? <Columns3 /> : <Rows2 />}
            {view === "verse" ? t("editor.bibles.showPassages") : t("editor.bibles.showVerse")}
          </Button>
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
      </div>

      {/* Body */}
      <div className={cn("flex-1", passage && !pickerOpen ? "min-h-0" : "overflow-y-auto")}>
        {!tracked ? (
          <EmptyState
            variant="inline"
            icon={BookMarked}
            title={t("editor.bibles.noReferences")}
            description={t("editor.bibles.noReferencesDescription")}
          />
        ) : pinned.length === 0 && !pickerOpen ? (
          <p className="p-4 text-xs text-muted-foreground">
            {t("editor.bibles.noVersions")}
          </p>
        ) : passage && !pickerOpen ? (
          <PassageColumns columns={columns} onRetry={retryColumn} onRemove={unpinVersion} />
        ) : (
          <div className="divide-y">
            {columns.map((column) => {
              const { versionId, meta, data, alignment } = column
              const verseText = alignment.verse !== null ? data?.verses.get(alignment.verse) : undefined
              const presentation = verseTextPresentation(meta)
              const text = verseTextStyle(presentation, "verse")
              return (
                <div key={versionId} className="group px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground/70">{column.label}</span>
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
                  {alignment.note && data && !data.error && (
                    <VersificationMark note={alignment.note} className="mt-1" />
                  )}
                  {data?.error ? (
                    <ResourcePaneError
                      className="mt-1"
                      message={data.error}
                      onRetry={() => retryColumn(column)}
                      retryLabel={t("editor.bibles.retryVersion", { version: versionId })}
                    />
                  ) : !data ? (
                    <div className="mt-1 flex items-center text-muted-foreground" aria-label={t("common.loading")}>
                      <Spinner className="size-3.5" />
                    </div>
                  ) : tracked.verse === null ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("editor.bibles.scrollToVerse")}
                    </p>
                  ) : verseText ? (
                    <p
                      dir={presentation.dir}
                      lang={presentation.lang}
                      style={text.style}
                      className={cn("mt-1 text-start text-foreground/90", text.className)}
                    >
                      {verseText}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("editor.bibles.noTextForRef", { ref: trackedLabel ?? "" })}
                    </p>
                  )}
                  <VersionCredit versionId={versionId} meta={meta} className="mt-1" />
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
              <ResourcePaneError
                className="mt-2"
                message={t("editor.bibles.failedToLoad", { error: translationsErr })}
                onRetry={() => {
                  setTranslationsErr(null)
                  setRetryNonce((n) => n + 1)
                }}
                retryLabel={t("editor.bibles.retryVersions")}
              />
            ) : !translations ? (
              <p className="mt-2 text-xs text-muted-foreground">{t("editor.bibles.loadingVersions")}</p>
            ) : (
              <ul className="mt-2 max-h-48 overflow-y-auto rounded border">
                {filteredTranslations.length === 0 && (
                  <li className="p-2 text-xs text-muted-foreground">{t("editor.bibles.noMatches")}</li>
                )}
                {filteredTranslations.map((tr) => (
                  <li key={tr.id}>
                    <button
                      type="button"
                      onClick={() => pinVersion(tr.id)}
                      className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                    >
                      <span className="truncate">{tr.englishName || tr.name}</span>
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                        {tr.id}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Footer: add-version, project defaults, attribution */}
      <div className="border-t px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            {pickerOpen ? t("editor.bibles.closePicker") : t("editor.bibles.addVersion")}
          </button>
          {showMakeDefaults && (
            <button
              type="button"
              disabled={defaultsStatus === "saving"}
              onClick={() => void makeProjectDefaults()}
              className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
            >
              {t("editor.bibles.makeProjectDefaults")}
            </button>
          )}
          {showFollowDefaults && (
            <button
              type="button"
              onClick={followProjectDefaults}
              className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("editor.bibles.useProjectDefaults")}
            </button>
          )}
        </div>
        {(resolved.source === "project" || defaultsStatus === "failed") && (
          <p role="status" className="mt-1 text-[11px] text-muted-foreground">
            {defaultsStatus === "failed"
              ? t("editor.bibles.projectDefaultsFailed")
              : defaultsStatus === "saved"
                ? t("editor.bibles.projectDefaultsSaved")
                : t("editor.bibles.usingProjectDefaults")}
          </p>
        )}
        <p className="mt-1 text-[10px] text-muted-foreground/60">
          {t("editor.bibles.attribution")}{" "}
          <a
            href="https://bible.helloao.org/"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {/* i18n-exempt: proper-noun name of the external API this data is sourced from */}
            Free Use Bible API
          </a>
        </p>
      </div>
    </div>
    </RightSidebarPanel>
  )
}
