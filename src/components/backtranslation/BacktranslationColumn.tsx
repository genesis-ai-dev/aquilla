// The Back-translation column: the editor's third text column, after Source
// and Target.
//
//   # | Source | (Bible columns) | Target | Back-translation
//
// A back-translation is the translation rendered back into the source
// language, so a reviewer who does not read the target can check the meaning.
// It is a third version of the same line, so it sits beside the other two and
// reads row by row and down the page — not under the target, and not behind a
// tab on every row.
//
// Each person opens or closes the column for themselves (bt-column-pref.ts);
// when they never chose, it is open on a project that back-translates live.
// When the window is too narrow for a third column (and on phones) the same
// reading stacks under the target instead, the way the Bible columns stack
// under the source.
//
// Like the Bible columns, the editor owns one provider and every row reads it
// through context, so nothing is threaded through the memoised row tree.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode, type RefObject,
} from "react"
import { AlertTriangle, Languages, MoreHorizontal, Pencil, RefreshCw, Sparkles, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { AppTooltip } from "@/components/ui/tooltip"
import { InlineBacktranslation } from "@/components/cell/InlineBacktranslation"
import { useT } from "@/lib/i18n/I18nProvider"
import {
  BT_COLUMN_CHANGED_EVENT, readBtColumnChoice, resolveBtColumnShown, writeBtColumnChoice,
  type BtColumnChoice,
} from "@/lib/completion/bt-column-pref"
import type { BacktranslationActionSource } from "@/lib/completion/bt-record"
import type { CellData } from "@/hooks/useCells"
import { cn } from "@/lib/utils"

export type BacktranslationColumnLayout = "none" | "column" | "stacked"

/** Same floor as the Bible columns: below it a column of text stops being usable. */
const MIN_TEXT_COLUMN_PX = 200
/** The editor's md breakpoint: below it the rows are the two-track phone grid. */
const MD_PX = 768

/**
 * A column when Source, Target and Back-translation each still get
 * MIN_TEXT_COLUMN_PX; otherwise stacked under the target. The column is
 * decided before the Bible columns are, so on a tight window the Bibles stack
 * first and the back-translation keeps its column.
 */
export function backtranslationColumnLayout(width: number, gutterPx: number, shown: boolean): BacktranslationColumnLayout {
  if (!shown) return "none"
  if (width < MD_PX) return "stacked"
  // ps-2.5 + pe-4 on the row, gap-x-2 before each of the three text tracks.
  const usable = width - gutterPx - 26 - 8 * 3
  return usable / 3 >= MIN_TEXT_COLUMN_PX ? "column" : "stacked"
}

/** What the workspace hands the editor so it can offer the column. */
export interface EditorBacktranslationConfig {
  projectId: string
  /** The project back-translates each translation as it is saved. */
  live: boolean
  /** Maintainers and up: may turn live back-translation on or off for the project. */
  canSetLive: boolean
  onSetLive: (on: boolean) => void
  /** Cells waiting for a back-translation (after a save, or queued by "Back-translate N rows"). */
  waiting: ReadonlySet<string>
  /** How many are waiting or in progress, for the heading. */
  pending: number
  /** Back-translate these cells, a few at a time. */
  onBacktranslateMany: (cellIds: string[]) => void
  /** Drop everything that has not started yet. */
  onStop: () => void
}

interface BacktranslationColumnValue {
  layout: BacktranslationColumnLayout
  config: EditorBacktranslationConfig
  /** An AI model is set up, so back-translations can be made. */
  configured: boolean
  /** This person may make and correct back-translations here. */
  canWrite: boolean
  sourceLanguage: string | undefined
  show: () => void
  hide: () => void
  /** Rows on the page that have a translation and no current back-translation. */
  collectMissing: () => string[]
}

const BacktranslationColumnContext = createContext<BacktranslationColumnValue | null>(null)

export function useBacktranslationColumnLayout(): BacktranslationColumnLayout {
  return useContext(BacktranslationColumnContext)?.layout ?? "none"
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

function useBtColumnChoice(projectId: string | undefined): [BtColumnChoice | null, (choice: BtColumnChoice) => void] {
  // Held with the project it was read for, so another project's choice is
  // never shown for even one render after the project changes.
  const [stored, setStored] = useState(() => ({ projectId, choice: readBtColumnChoice(projectId) }))
  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string | null }>).detail
      if ((detail?.projectId ?? null) === (projectId ?? null)) {
        setStored({ projectId, choice: readBtColumnChoice(projectId) })
      }
    }
    window.addEventListener(BT_COLUMN_CHANGED_EVENT, onChange)
    return () => window.removeEventListener(BT_COLUMN_CHANGED_EVENT, onChange)
  }, [projectId])
  const choose = useCallback((next: BtColumnChoice) => {
    setStored({ projectId, choice: next })
    writeBtColumnChoice(projectId, next)
  }, [projectId])
  const choice = stored.projectId === projectId ? stored.choice : readBtColumnChoice(projectId)
  return [choice, choose]
}

/**
 * The editor's Back-translation column state. `config` absent (an embedding
 * with no back-translation wiring) or `enabled` false (an audio-only language)
 * means the column is not offered at all.
 */
export function useEditorBacktranslationColumn(args: {
  config: EditorBacktranslationConfig | undefined
  enabled: boolean
  configured: boolean
  canWrite: boolean
  sourceLanguage: string | undefined
  widthRef: RefObject<HTMLElement | null>
  gutterPx: number
  collectMissing: () => string[]
}): BacktranslationColumnValue | null {
  const { config, enabled, configured, canWrite, sourceLanguage, widthRef, gutterPx, collectMissing } = args
  const [choice, choose] = useBtColumnChoice(config?.projectId)
  const width = useElementWidth(widthRef)
  const active = enabled && !!config
  const shown = active && resolveBtColumnShown(choice, config.live)
  const layout = backtranslationColumnLayout(width, gutterPx, shown)
  return useMemo(() => {
    if (!active || !config) return null
    return {
      layout,
      config,
      configured,
      canWrite,
      sourceLanguage,
      show: () => choose("shown"),
      hide: () => choose("hidden"),
      collectMissing,
    }
  }, [active, config, layout, configured, canWrite, sourceLanguage, choose, collectMissing])
}

export function BacktranslationColumnProvider({ value, children }: { value: BacktranslationColumnValue | null; children: ReactNode }) {
  return <BacktranslationColumnContext.Provider value={value}>{children}</BacktranslationColumnContext.Provider>
}

// ── The options popover ─────────────────────────────────────────────────────

function BacktranslationOptions({ ctx, onDone }: { ctx: BacktranslationColumnValue; onDone: () => void }) {
  const t = useT()
  const { config } = ctx
  // Counted once, when the popover opens: the page does not change under an open popover.
  const [missing] = useState(() => ctx.collectMissing())
  const busy = config.pending > 0
  return (
    <div className="flex flex-col gap-3 text-xs">
      <p className="leading-relaxed text-muted-foreground">{t("editor.btColumn.about")}</p>

      <div className="flex items-start justify-between gap-3 border-t pt-3">
        <div className="min-w-0">
          <label htmlFor="bt-column-live" className="font-medium text-foreground">
            {t("editor.btColumn.liveLabel")}
          </label>
          <p className="mt-0.5 leading-relaxed text-muted-foreground">
            {config.canSetLive ? t("editor.btColumn.liveDescription") : t("editor.btColumn.liveMaintainerOnly")}
          </p>
        </div>
        <Switch
          id="bt-column-live"
          checked={config.live}
          disabled={!config.canSetLive}
          onCheckedChange={(checked) => config.onSetLive(checked)}
          aria-label={t("editor.btColumn.liveLabel")}
        />
      </div>

      {ctx.canWrite && (
        <div className="flex flex-col gap-1.5 border-t pt-3">
          {busy ? (
            <div className="flex items-center justify-between gap-2">
              <span role="status" className="inline-flex items-center gap-1.5 text-muted-foreground">
                <Spinner className="size-3.5" />
                {t("editor.btColumn.progress", { count: config.pending })}
              </span>
              <Button type="button" variant="outline" size="xs" onClick={config.onStop}>
                {t("editor.btColumn.stop")}
              </Button>
            </div>
          ) : missing.length > 0 ? (
            <>
              <Button
                type="button"
                size="sm"
                disabled={!ctx.configured}
                data-testid="bt-column-fill"
                onClick={() => {
                  config.onBacktranslateMany(missing)
                  onDone()
                }}
              >
                <Sparkles />
                {t("editor.btColumn.fill", { count: missing.length })}
              </Button>
              <p className="leading-relaxed text-muted-foreground">
                {ctx.configured ? t("editor.btColumn.fillHint") : t("editor.bt.needsAiHint")}
              </p>
            </>
          ) : (
            <p className="leading-relaxed text-muted-foreground">{t("editor.btColumn.fillNone")}</p>
          )}
        </div>
      )}
    </div>
  )
}

function OptionsPopover({ ctx, trigger, align }: { ctx: BacktranslationColumnValue; trigger: React.ReactElement; align: "start" | "end" }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align={align} className="w-80 p-3" aria-label={t("editor.btColumn.options")}>
        {open && <BacktranslationOptions ctx={ctx} onDone={() => setOpen(false)} />}
      </PopoverContent>
    </Popover>
  )
}

/** Live / progress, beside the heading. */
function ColumnStatus({ ctx }: { ctx: BacktranslationColumnValue }) {
  const t = useT()
  if (ctx.config.pending > 0) {
    return (
      <span role="status" data-testid="bt-column-progress" className="inline-flex items-center gap-1 font-normal text-muted-foreground">
        <Spinner className="size-3" />
        {t("editor.btColumn.progress", { count: ctx.config.pending })}
      </span>
    )
  }
  if (!ctx.config.live) return null
  return (
    <span data-testid="bt-column-live-badge" className="inline-flex items-center gap-1 font-normal text-emerald-700 dark:text-emerald-400">
      <span aria-hidden className="size-1.5 rounded-full bg-emerald-500" />
      {t("editor.btColumn.liveBadge")}
    </span>
  )
}

// ── Header pieces ───────────────────────────────────────────────────────────

/**
 * On the Target header. Closed: one click opens the column. Stacked (no room
 * for a column): the column has no heading of its own, so its options and its
 * close button live here.
 */
export function BacktranslationColumnToggle() {
  const t = useT()
  const ctx = useContext(BacktranslationColumnContext)
  if (!ctx || ctx.layout === "column") return null
  if (ctx.layout === "none") {
    return (
      <AppTooltip content={t("editor.btColumn.show")}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="bt-column-show"
          aria-label={t("editor.btColumn.show")}
          onClick={ctx.show}
          className="ms-auto h-6 gap-1 px-1.5 text-xs font-normal text-muted-foreground"
        >
          <Languages className="size-3.5" />
          <span className="hidden lg:inline">{t("editor.btColumn.title")}</span>
        </Button>
      </AppTooltip>
    )
  }
  return (
    <span className="ms-auto inline-flex items-center gap-0.5">
      <OptionsPopover
        ctx={ctx}
        align="end"
        trigger={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="bt-column-options"
            aria-label={t("editor.btColumn.options")}
            className="h-6 gap-1 px-1.5 text-xs font-normal text-foreground"
          >
            <Languages className="size-3.5" />
            <span className="hidden lg:inline">{t("editor.btColumn.title")}</span>
            <ColumnStatus ctx={ctx} />
          </Button>
        }
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="bt-column-hide"
        aria-label={t("editor.btColumn.hide")}
        onClick={ctx.hide}
        className="text-muted-foreground/60 hover:text-foreground"
      >
        <X />
      </Button>
    </span>
  )
}

/** The column's own heading: name, the language it reads in, status, options, close. */
export function BacktranslationColumnHeader() {
  const t = useT()
  const ctx = useContext(BacktranslationColumnContext)
  if (!ctx || ctx.layout !== "column") return null
  return (
    <div
      data-testid="bt-column-header"
      dir="ltr"
      className="hidden min-w-0 flex-wrap items-center gap-1 ps-2 md:flex md:gap-2"
    >
      <span className="truncate">{t("editor.btColumn.title")}</span>
      {ctx.sourceLanguage && (
        <Badge variant="secondary" className="max-w-full min-w-0 whitespace-normal break-words text-[10px] font-normal normal-case tracking-normal">
          {ctx.sourceLanguage}
        </Badge>
      )}
      <ColumnStatus ctx={ctx} />
      <span className="ms-auto inline-flex items-center gap-0.5">
        <OptionsPopover
          ctx={ctx}
          align="end"
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              data-testid="bt-column-options"
              aria-label={t("editor.btColumn.options")}
              className="text-muted-foreground hover:text-foreground"
            >
              <MoreHorizontal />
            </Button>
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="bt-column-hide"
          aria-label={t("editor.btColumn.hide")}
          onClick={ctx.hide}
          className="text-muted-foreground/60 hover:text-foreground"
        >
          <X />
        </Button>
      </span>
    </div>
  )
}

// ── Row cell ────────────────────────────────────────────────────────────────

export interface BacktranslationRowProps {
  /** The row's cell, with its back-translation overlaid (EditorTable applyRowOverlays). */
  cell: CellData
  /** The translation as it is on screen, unsaved typing included. */
  visibleTranslated: string
  /** The reading describes older text than what is on screen. */
  stale: boolean
  generating: boolean
  error: string | undefined
  /** This row may be written to by this person right now (role, lane, lock). */
  editable: boolean
  /** Source-language direction and size: the reading is in the source language. */
  dir: "ltr" | "rtl" | "auto" | undefined
  fontSize: number
  onBacktranslate?: (cell: CellData, source: BacktranslationActionSource) => void
  onSave?: (cell: CellData, btText: string, polished: boolean) => void
  /** Opens the row's Back-translation tab (gloss, alignment). */
  onOpenDetails: () => void
}

type CellState = "empty" | "missing" | "waiting" | "generating" | "failed" | "stale" | "current"

function cellState(args: {
  hasTranslation: boolean
  reading: string
  stale: boolean
  generating: boolean
  waiting: boolean
  failed: boolean
}): CellState {
  if (args.generating) return "generating"
  if (args.waiting) return "waiting"
  if (args.failed) return "failed"
  if (!args.hasTranslation) return "empty"
  if (!args.reading) return "missing"
  return args.stale ? "stale" : "current"
}

/**
 * The row's back-translation as its own grid track (layout "column").
 *
 * Rows are recycled, so the editor mounts this with `key={cell.id}`: a row
 * handed another cell must not keep the last cell's open editor.
 */
export function BacktranslationRowCell(props: BacktranslationRowProps) {
  const t = useT()
  const ctx = useContext(BacktranslationColumnContext)
  const { cell, visibleTranslated, stale, generating, error, editable, dir, fontSize, onBacktranslate, onSave, onOpenDetails } = props
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  if (!ctx || ctx.layout !== "column") return null

  const reading = cell.backtranslation?.trim() ?? ""
  const hasTranslation = visibleTranslated.trim().length > 0
  const corrected = Boolean(reading) && cell.backtranslationPolished === false
  const waiting = ctx.config.waiting.has(cell.id) && !generating
  const state = cellState({ hasTranslation, reading, stale, generating, waiting, failed: Boolean(error) })
  const subject: CellData = { ...cell, translated: visibleTranslated }
  const canGenerate = editable && Boolean(onBacktranslate)
  const canEdit = editable && Boolean(onSave) && hasTranslation
  const busy = state === "generating" || state === "waiting"

  const generate = (source: BacktranslationActionSource) => onBacktranslate?.(subject, source)
  const startEdit = () => {
    setDraft(cell.backtranslation ?? "")
    setEditing(true)
  }
  const save = () => {
    const next = draft.trim()
    setEditing(false)
    if (!next || next === reading) return
    onSave?.(subject, next, false)
  }

  return (
    <div
      data-testid="bt-cell"
      data-state={state}
      data-selection-ignore=""
      data-editor-cell-surface="backtranslation"
      className={cn(
        "group/bt relative hidden min-h-[40px] min-w-0 flex-col break-words rounded-lg px-2 py-1.5 select-text transition-colors md:flex",
        "focus-within:bg-muted focus-within:ring-1 focus-within:ring-ring/40 focus-within:ring-inset",
        editing && "bg-muted ring-1 ring-ring/40 ring-inset",
      )}
      style={{ fontSize: `${fontSize}px`, lineHeight: "1.6" }}
      onClick={(event) => event.stopPropagation()}
    >
      {/* The same 20px lane the source column keeps for its context line, so
          first lines share a baseline. Here it says what kind of reading this
          is, and holds the cell's own actions. */}
      <div className="mb-1 flex h-4 min-w-0 items-center gap-1.5 font-sans text-[11px] leading-none" dir="ltr">
        {state === "generating" && (
          <span role="status" className="inline-flex items-center gap-1 text-muted-foreground">
            <Spinner className="size-3" />
            {t("editor.bt.inlineGenerating")}
          </span>
        )}
        {state === "waiting" && <span className="text-muted-foreground/70">{t("editor.btColumn.cellWaiting")}</span>}
        {state === "failed" && (
          <AppTooltip content={error}>
            <span className="inline-flex items-center gap-1 font-medium text-destructive">
              <AlertTriangle className="size-3" />
              {t("editor.bt.failed")}
            </span>
          </AppTooltip>
        )}
        {state === "stale" && (
          <span className="rounded-sm bg-amber-500/10 px-1 py-0.5 font-medium text-amber-700 dark:text-amber-400">
            {t("editor.bt.inlineStale")}
          </span>
        )}
        {corrected && !busy && (
          <span className="font-medium text-emerald-700 dark:text-emerald-400">{t("editor.bt.originCorrected")}</span>
        )}
        {!editing && (
          <span className="ms-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/bt:opacity-100 focus-within:opacity-100">
            {canGenerate && reading && !busy && (
              <AppTooltip content={ctx.configured ? t("editor.btColumn.cellUpdate") : t("editor.bt.needsAiTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!ctx.configured}
                  aria-label={t("editor.btColumn.cellUpdate")}
                  onClick={() => generate(stale ? "refresh" : "regenerate")}
                  className="size-5 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <RefreshCw />
                </Button>
              </AppTooltip>
            )}
            {canEdit && reading && !busy && (
              <AppTooltip content={t("editor.bt.editTooltip")}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("editor.bt.editTooltip")}
                  onClick={startEdit}
                  className="size-5 rounded-full text-muted-foreground hover:text-foreground"
                >
                  <Pencil />
                </Button>
              </AppTooltip>
            )}
          </span>
        )}
      </div>

      {editing ? (
        <div className="flex flex-col gap-1.5">
          <textarea
            autoFocus
            dir={dir}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false)
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) save()
            }}
            rows={Math.max(2, Math.ceil(draft.length / 42))}
            aria-label={t("editor.btColumn.cellText")}
            className="w-full resize-none bg-transparent text-foreground outline-none"
          />
          <p className="font-sans text-[10px] leading-relaxed text-muted-foreground/80" dir="ltr">
            {t("editor.btColumn.cellEditHint")}
          </p>
          <div className="flex items-center justify-end gap-1.5 font-sans" dir="ltr">
            <Button type="button" variant="ghost" size="xs" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" size="xs" onClick={save} disabled={!draft.trim()}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      ) : reading ? (
        <p
          dir={dir}
          data-testid="bt-cell-text"
          onDoubleClick={canEdit && !busy ? startEdit : undefined}
          className={cn(
            "text-start text-foreground/90 transition-opacity",
            (state === "stale" || busy) && "opacity-55",
          )}
        >
          {cell.backtranslation}
        </p>
      ) : state === "failed" ? (
        canGenerate && (
          <button
            type="button"
            onClick={() => generate("read-back")}
            className="self-start font-sans text-xs text-destructive underline-offset-2 hover:underline"
          >
            {t("editor.btColumn.cellRetry")}
          </button>
        )
      ) : state === "missing" && canGenerate ? (
        <AppTooltip content={ctx.configured ? undefined : t("editor.bt.needsAiTooltip")}>
          <button
            type="button"
            data-testid="bt-cell-generate"
            disabled={!ctx.configured}
            onClick={() => generate("read-back")}
            className="inline-flex items-center gap-1 self-start rounded-md font-sans text-xs text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
          >
            <Sparkles className="size-3" />
            {t("editor.btColumn.cellGenerate")}
          </button>
        </AppTooltip>
      ) : null}

      {/* A failed refresh keeps the last reading on screen; offer the retry under it. */}
      {state === "failed" && reading && canGenerate && !editing && (
        <button
          type="button"
          onClick={() => generate("refresh")}
          className="mt-1 self-start font-sans text-xs text-destructive underline-offset-2 hover:underline"
        >
          {t("editor.btColumn.cellRetry")}
        </button>
      )}

      {/* The gloss and word alignment stay in the row's details. */}
      {reading && !editing && (
        <button
          type="button"
          onClick={onOpenDetails}
          className="sr-only focus:not-sr-only focus:mt-1 focus:self-start focus:font-sans focus:text-xs focus:text-muted-foreground focus:underline"
        >
          {t("editor.bt.inlineOpen")}
        </button>
      )}
    </div>
  )
}

/**
 * The row's back-translation under its target: layout "stacked" (no room for
 * a third column), and phones even when the column is open on wider screens.
 */
export function BacktranslationRowStack(props: Pick<BacktranslationRowProps, "cell" | "stale" | "generating" | "error" | "onOpenDetails">) {
  const ctx = useContext(BacktranslationColumnContext)
  if (!ctx || ctx.layout === "none") return null
  const waiting = ctx.config.waiting.has(props.cell.id)
  return (
    <div data-testid="bt-stack" className={cn(ctx.layout === "column" && "md:hidden")}>
      <InlineBacktranslation
        reading={props.cell.backtranslation}
        stale={props.stale}
        generating={props.generating || waiting}
        error={props.error}
        onOpen={props.onOpenDetails}
      />
    </div>
  )
}
