// Bible columns in the editor: read-only source columns, one per chosen Bible
// version, between Source and Target, lined up row by row.
//
//   # | Source | SBL 3:16 | BSB 3:16 | Target
//
// A Hebrew column follows its own numbering (versification.ts): on an English
// MAL 4:1 row the WLC column shows Hebrew 3:19 and says so. When the columns
// don't fit — more than three Bibles, a narrow window, a phone — the same
// verses stack under the source text instead, smaller, still row by row.
//
// The editor owns one provider; every row reads it through context, so a
// chapter landing re-renders the rows without threading props through the
// memoised row tree.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react"
import { ArrowLeftRight, BookPlus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import type { HelloaoTranslation } from "@/lib/parsers/helloao"
import { sameVersionList } from "@/lib/parallel-bibles/pinned-versions"
import type { RowScripture } from "@/lib/parallel-bibles/row-verses"
import { verseTextPresentation, verseTextStyle } from "@/lib/parallel-bibles/version-display"
import { cn } from "@/lib/utils"
import { referenceShape, resolveBibleCell, type BibleCell } from "./bible-cells"
import { useHelloaoCatalogue, usePinnedVersions, versionLabel, type HelloaoCatalogue, type PinnedVersions } from "./useBibleVersions"
import { useParallelChapters, type TrackedRef } from "./useParallelChapters"
import { VersificationMark } from "./VersificationMark"
import { VersionCredit } from "./VersionCredit"
import { VersionPicker } from "./VersionPicker"

/** What the workspace hands the editor so it can offer Bible columns. */
export interface EditorParallelBiblesConfig {
  projectId: string
  /** The project's default versions, shown until a translator picks their own. */
  projectDefaults?: readonly string[]
  /** Project lead and up: may save the shown versions as the project defaults. */
  canSetProjectDefaults: boolean
  /** Resolves true when the server took the new defaults. */
  onSetProjectDefaults: (ids: string[]) => Promise<boolean>
}

export type BibleColumnsLayout = "none" | "columns" | "stacked"

export const MAX_BIBLE_COLUMNS = 3
/** Below this a column of text — the Target the translator types in above all — stops being usable. */
export const MIN_TEXT_COLUMN_PX = 200
/** The editor's md breakpoint: below it the rows are the two-track phone grid. */
const MD_PX = 768

/**
 * Columns when every text track (Source, each Bible, Target) still gets
 * MIN_TEXT_COLUMN_PX; otherwise stacked under the source text. Phones always
 * stack: their grid has no room for a third track.
 */
export function bibleColumnsLayout(width: number, gutterPx: number, count: number): BibleColumnsLayout {
  if (count === 0) return "none"
  if (count > MAX_BIBLE_COLUMNS || width < MD_PX) return "stacked"
  const tracks = count + 2
  // ps-2.5 + pe-4 on the row, gap-x-2 between tracks.
  const usable = width - gutterPx - 26 - 8 * (tracks)
  return usable / tracks >= MIN_TEXT_COLUMN_PX ? "columns" : "stacked"
}

export interface BibleColumn {
  versionId: string
  label: string
  meta: HelloaoTranslation | undefined
}

interface BibleColumnsValue {
  columns: BibleColumn[]
  layout: BibleColumnsLayout
  cellFor: (versionId: string, row: RowScripture) => BibleCell
  retry: (key: string) => void
  pins: PinnedVersions
  catalogue: HelloaoCatalogue
  config: EditorParallelBiblesConfig
}

const BibleColumnsContext = createContext<BibleColumnsValue | null>(null)

export function useBibleColumnsLayout(): BibleColumnsLayout {
  return useContext(BibleColumnsContext)?.layout ?? "none"
}

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.getBoundingClientRect().width)
    read()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return width
}

/**
 * The editor's Bible columns state. `visibleRows` are the rows in view (their
 * chapters are what gets fetched, with the neighbours warmed); `enabled` is a
 * scripture file with a config — anything else shows no Bible columns at all.
 */
export function useEditorBibleColumns(args: {
  config: EditorParallelBiblesConfig | undefined
  enabled: boolean
  visibleRows: readonly RowScripture[]
  widthRef: RefObject<HTMLElement | null>
  gutterPx: number
}): BibleColumnsValue | null {
  const { config, enabled, visibleRows, widthRef, gutterPx } = args
  const pins = usePinnedVersions(config?.projectId, config?.projectDefaults)
  const active = enabled && !!config
  const pinned = active ? pins.pinned : []
  const catalogue = useHelloaoCatalogue(active && pinned.length > 0)
  const [retryNonce, setRetryNonce] = useState(0)
  const width = useElementWidth(widthRef)

  // First and last verse of each row in view, deduplicated.
  const refsKey = visibleRows
    .flatMap((row) => (row.kind === "verses" ? [`${row.book} ${row.chapter} ${row.from}`, `${row.book} ${row.chapter} ${row.to}`] : []))
    .filter((v, i, all) => all.indexOf(v) === i)
    .join(",")
  const refs = useMemo<TrackedRef[]>(
    () => (refsKey ? refsKey.split(",").map((part) => {
      const [book, chapter, verse] = part.split(" ")
      return { book, chapter: Number(chapter), verse: Number(verse) }
    }) : []),
    [refsKey],
  )
  const { chapterData, forget } = useParallelChapters({
    open: active,
    pinned,
    refs,
    translationById: catalogue.byId,
    retryNonce,
  })

  return useMemo(() => {
    if (!active || !config) return null
    const label = (id: string) => versionLabel(id, catalogue.byId.get(id))
    const columns = pinned.map((versionId) => ({ versionId, label: label(versionId), meta: catalogue.byId.get(versionId) }))
    return {
      columns,
      layout: bibleColumnsLayout(width, gutterPx, columns.length),
      cellFor: (versionId: string, row: RowScripture) =>
        resolveBibleCell({
          versionId,
          meta: catalogue.byId.get(versionId),
          row,
          chapterData,
          reference: row.kind === "verses"
            ? referenceShape(pinned, catalogue.byId, chapterData, row.book, row.chapter, label)
            : undefined,
        }),
      retry: (key: string) => {
        forget(key)
        setRetryNonce((n) => n + 1)
      },
      pins,
      catalogue,
      config,
    }
  }, [active, config, pinned, pins, catalogue, chapterData, forget, width, gutterPx])
}

export function BibleColumnsProvider({ value, children }: { value: BibleColumnsValue | null; children: ReactNode }) {
  return <BibleColumnsContext.Provider value={value}>{children}</BibleColumnsContext.Provider>
}

/** "Add Bible" on the Source header: the picker, and the project defaults. */
export function AddBibleMenu() {
  const t = useT()
  const ctx = useContext(BibleColumnsContext)
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle")
  if (!ctx) return null
  const { pins, catalogue, config } = ctx
  const differs = !sameVersionList(pins.pinned, config.projectDefaults)
  const showMake = config.canSetProjectDefaults && pins.source === "personal" && pins.pinned.length > 0 && differs
  const showFollow = pins.source === "personal" && (config.projectDefaults?.length ?? 0) > 0 && differs
  const makeDefaults = async () => {
    setStatus("saving")
    const ok = await config.onSetProjectDefaults([...pins.pinned])
    if (ok) pins.followProjectDefaults()
    setStatus(ok ? "saved" : "failed")
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-xs font-normal text-muted-foreground">
            <BookPlus className="size-3.5" />
            {t("editor.bibles.addBible")}
          </Button>
        }
      />
      <PopoverContent align="start" className="w-80 p-3" aria-label={t("editor.bibles.addBible")}>
        <VersionPicker
          translations={catalogue.translations}
          error={catalogue.error}
          onRetry={catalogue.retry}
          exclude={pins.pinned}
          onPick={(id) => {
            pins.pin(id)
            setStatus("idle")
          }}
        />
        {(showMake || showFollow || pins.source === "project" || status === "failed") && (
          <div className="mt-2 flex flex-col items-start gap-1 border-t pt-2">
            {showMake && (
              <button
                type="button"
                disabled={status === "saving"}
                onClick={() => void makeDefaults()}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
              >
                {t("editor.bibles.makeProjectDefaults")}
              </button>
            )}
            {showFollow && (
              <button
                type="button"
                onClick={pins.followProjectDefaults}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                {t("editor.bibles.useProjectDefaults")}
              </button>
            )}
            {(pins.source === "project" || status === "failed") && (
              <p role="status" className="text-[11px] text-muted-foreground">
                {status === "failed"
                  ? t("editor.bibles.projectDefaultsFailed")
                  : status === "saved"
                    ? t("editor.bibles.projectDefaultsSaved")
                    : t("editor.bibles.usingProjectDefaults")}
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** One header cell per Bible column: short name, remove, and its credit. */
export function BibleColumnHeaders() {
  const t = useT()
  const ctx = useContext(BibleColumnsContext)
  if (!ctx || ctx.layout !== "columns") return null
  return ctx.columns.map((column) => (
    <div
      key={column.versionId}
      data-testid={`bible-column-header-${column.versionId}`}
      dir="ltr"
      className="group/bible hidden min-w-0 flex-col gap-0.5 ps-2 md:flex"
    >
      <div className="flex min-w-0 items-center gap-1">
        <span className="truncate">{column.label}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("editor.bibles.removeVersion", { version: column.versionId })}
          onClick={() => ctx.pins.unpin(column.versionId)}
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <X />
        </Button>
      </div>
      <VersionCredit versionId={column.versionId} meta={column.meta} className="font-normal" />
    </div>
  ))
}

function CellText({
  cell,
  meta,
  view,
  onRetry,
}: {
  cell: BibleCell
  meta: HelloaoTranslation | undefined
  view: "column" | "stacked"
  onRetry: (key: string) => void
}) {
  const t = useT()
  if (cell.state === "loading") {
    return (
      <span className="flex items-center text-muted-foreground" aria-label={t("common.loading")}>
        <Spinner className="size-3" />
      </span>
    )
  }
  if (cell.state === "continued") {
    return <span className="text-xs italic text-muted-foreground">{t("editor.bibles.continued")}</span>
  }
  if (cell.state === "error") {
    return (
      <button type="button" onClick={() => onRetry(cell.key)} className="text-xs text-destructive underline-offset-2 hover:underline">
        {t("editor.bibles.retryVersion", { version: meta?.shortName || meta?.id || "" })}
      </button>
    )
  }
  const presentation = verseTextPresentation(meta)
  const text = verseTextStyle(presentation, view)
  return (
    <>
      {cell.state === "text" ? (
        <p dir={presentation.dir} lang={presentation.lang} style={text.style} className={cn("text-start text-foreground/90", text.className)}>
          {cell.verses.map((verse, i) => (
            <span key={verse.number}>
              {cell.verses.length > 1 && (
                <sup className="me-0.5 font-sans text-[0.65em] text-muted-foreground">{verse.number}</sup>
              )}
              {verse.text}
              {i < cell.verses.length - 1 ? " " : ""}
            </span>
          ))}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">{t("editor.bibles.noTextForRef", { ref: cell.ref })}</p>
      )}
      {cell.note && view === "column" && <VersificationMark note={cell.note} className="mt-1" />}
      {cell.note && view === "stacked" && (
        <ArrowLeftRight
          className="ms-1 inline size-3 text-amber-700 dark:text-amber-300"
          aria-label={t("editor.bibles.versNumberingDiffers")}
        />
      )}
    </>
  )
}

/** The row's Bible cells as grid tracks (layout "columns"). */
export function BibleRowCells({ row }: { row: RowScripture | null }) {
  const ctx = useContext(BibleColumnsContext)
  if (!ctx || ctx.layout !== "columns") return null
  return ctx.columns.map((column) => (
    <div
      key={column.versionId}
      data-testid={`bible-cell-${column.versionId}`}
      data-selection-ignore=""
      className="hidden min-w-0 flex-col break-words px-2 py-1.5 select-text md:flex"
    >
      {/* Mirrors the source column's 20px context line, so first lines share a baseline. */}
      <div className="mb-1 h-4" aria-hidden />
      {row && <CellText cell={ctx.cellFor(column.versionId, row)} meta={column.meta} view="column" onRetry={ctx.retry} />}
    </div>
  ))
}

/** The row's Bible verses under the source text (layout "stacked", and phones). */
export function BibleRowStack({ row }: { row: RowScripture | null }) {
  const ctx = useContext(BibleColumnsContext)
  if (!ctx || ctx.layout === "none" || !row) return null
  return (
    <div
      data-testid="bible-stack"
      data-selection-ignore=""
      className={cn("mt-1.5 flex flex-col gap-1 border-t border-border/60 pt-1.5", ctx.layout === "columns" && "md:hidden")}
    >
      {ctx.columns.map((column) => (
        <div key={column.versionId} data-testid={`bible-stack-${column.versionId}`} className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-sans text-[10px] font-medium text-muted-foreground" dir="ltr">{column.label}</span>
          <div className="min-w-0 flex-1">
            <CellText cell={ctx.cellFor(column.versionId, row)} meta={column.meta} view="stacked" onRetry={ctx.retry} />
          </div>
        </div>
      ))}
    </div>
  )
}
