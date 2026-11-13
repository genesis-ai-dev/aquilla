// Parallel Bibles sidebar — translator's helps backed by the Free Use Bible
// API (bible.helloao.org). Shows the currently-viewed verse across the bible
// versions the user has pinned, auto-tracking scroll position in the editor.
//
// The same versions also show as Bible columns in the editor itself
// (parallel-bibles/EditorBibleColumns): both read one set of pins — the
// translator's own for this project, else the project defaults a lead set —
// so adding or removing a version in either place changes both.
// Chapter loading (and its API-kindness rules) lives in useParallelChapters.

import { useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { BookMarked, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { ErrorBoundary } from "./ErrorBoundary"
import { ResourcePaneCrash, ResourcePaneError } from "./ResourcePaneError"
import { RightSidebarPanel } from "./RightSidebarPanel"
import { useT } from "@/lib/i18n/I18nProvider"
import { sameVersionList } from "@/lib/parallel-bibles/pinned-versions"
import { alignVersion, mapEnglishRef, versificationScheme } from "@/lib/parallel-bibles/versification"
import { verseTextPresentation, verseTextStyle } from "@/lib/parallel-bibles/version-display"
import { referenceShape } from "./parallel-bibles/bible-cells"
import { chapterKey } from "./parallel-bibles/chapter-data"
import { useHelloaoCatalogue, usePinnedVersions, versionLabel } from "./parallel-bibles/useBibleVersions"
import { useParallelChapters } from "./parallel-bibles/useParallelChapters"
import { VersificationMark } from "./parallel-bibles/VersificationMark"
import { VersionCredit } from "./parallel-bibles/VersionCredit"
import { VersionPicker } from "./parallel-bibles/VersionPicker"

const OPEN_STORAGE_KEY_PREFIX = "aquilla:parallel-bibles:"

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
  const pins = usePinnedVersions(projectId, projectDefaults)
  const { pinned } = pins
  const [pickerOpen, setPickerOpen] = useState(false)
  const [defaultsStatus, setDefaultsStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  // Bumped by the inline Retry buttons. A lookup that failed while the reader
  // stays on one verse has nothing else to re-trigger its effect, which is why
  // a dead pane used to need a page reload (AQU-849).
  const [retryNonce, setRetryNonce] = useState(0)

  // Hold the last parseable ref so headings / unrefed rows don't blank the panel.
  const lastParsedRef = useRef<{ book: string; chapter: number; verse: number | null } | null>(null)
  const parsed = trackedRef ? parseCanonicalRef(trackedRef) : null
  if (parsed) lastParsedRef.current = parsed
  const tracked = parsed ?? lastParsedRef.current

  // Names, credits, script and numbering all come from the catalogue.
  const catalogue = useHelloaoCatalogue(pickerOpen || (open && pinned.length > 0))
  const translationById = catalogue.byId

  const trackedKey = tracked ? `${tracked.book} ${tracked.chapter} ${tracked.verse ?? ""}` : ""
  const refs = useMemo(() => {
    if (!trackedKey) return []
    const [book, chapter, verse] = trackedKey.split(" ")
    return [{ book, chapter: Number(chapter), verse: verse ? Number(verse) : null }]
  }, [trackedKey])
  const { chapterData, forget } = useParallelChapters({
    open,
    pinned,
    refs,
    translationById,
    retryNonce,
  })

  async function makeProjectDefaults() {
    if (!onSetProjectDefaults) return
    setDefaultsStatus("saving")
    const ok = await onSetProjectDefaults([...pinned])
    if (ok) pins.followProjectDefaults()
    setDefaultsStatus(ok ? "saved" : "failed")
  }

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
  const labelOf = (id: string) => versionLabel(id, translationById.get(id))
  const reference = tracked
    ? referenceShape(pinned, translationById, chapterData, tracked.book, tracked.chapter, labelOf)
    : undefined

  const differsFromDefaults = !sameVersionList(pinned, projectDefaults)
  const showMakeDefaults =
    canSetProjectDefaults && !!onSetProjectDefaults && pins.source === "personal"
    && pinned.length > 0 && differsFromDefaults
  const showFollowDefaults =
    pins.source === "personal" && (projectDefaults?.length ?? 0) > 0 && differsFromDefaults

  return (
    <RightSidebarPanel
      storageKey="parallel-bibles"
      defaultWidth={320}
      minWidth={300}
      className={cn("hidden sm:flex", className)}
      resizeLabel={t("editor.panel.resizeParallelBibles")}
    >
    <div className="flex h-full w-full flex-col border-l bg-card text-sm">
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
        ) : (
          <div className="divide-y">
            {pinned.map((versionId) => {
              const meta = translationById.get(versionId)
              const scheme = versificationScheme(meta?.language)
              const mapped = mapEnglishRef(scheme, tracked.book, tracked.chapter, tracked.verse)
              const key = chapterKey(versionId, tracked.book, mapped.chapter)
              const data = chapterData.get(key)
              const alignment = alignVersion({
                scheme,
                book: tracked.book,
                chapter: tracked.chapter,
                verse: tracked.verse,
                loaded: data && !data.error && data.shape.verseCount > 0 ? data.shape : undefined,
                reference: reference && { ...reference, isSelf: reference.versionId === versionId },
              })
              const verseText = alignment.verse !== null ? data?.verses.get(alignment.verse) : undefined
              const presentation = verseTextPresentation(meta)
              const text = verseTextStyle(presentation, "verse")
              return (
                <div key={versionId} className="group px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-muted-foreground/70">{labelOf(versionId)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("editor.bibles.removeVersion", { version: versionId })}
                      onClick={() => pins.unpin(versionId)}
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
                      // Drop the latched failure first, so the retry shows the
                      // spinner rather than the error it is clearing.
                      onRetry={() => {
                        forget(key)
                        setRetryNonce((n) => n + 1)
                      }}
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

        {pickerOpen && (
          <div className="border-t p-3">
            <VersionPicker
              translations={catalogue.translations}
              error={catalogue.error}
              onRetry={() => {
                catalogue.retry()
                setRetryNonce((n) => n + 1)
              }}
              exclude={pinned}
              onPick={(id) => {
                pins.pin(id)
                setDefaultsStatus("idle")
                setPickerOpen(false)
              }}
            />
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
              onClick={pins.followProjectDefaults}
              className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("editor.bibles.useProjectDefaults")}
            </button>
          )}
        </div>
        {(pins.source === "project" || defaultsStatus === "failed") && (
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
