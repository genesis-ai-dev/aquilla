/**
 * Smart Extensions apiRev 8 — native EditorTable integration surfaces.
 *
 * All four real-editor hooks live here so `EditorTable.tsx` and
 * `ProjectWorkspace.tsx` stay lean and zero iframes are mounted per row:
 *   1. `ExtensionColumnsProvider` / `useNativeExtensionColumns` /
 *      `ExtensionColumnHeaders` / `ExtensionRowColumns` / `ExtensionRowColumnStack`
 *      / `ExtensionColumnToggles` — read-only columns declared in
 *      `manifest.columns`, rendered natively alongside Source/Target.
 *   2. `ExtensionRowAnnotations` — per-cell badges, source/target text span
 *      highlights, click popovers, and optional one-click target quick-fixes
 *      published via `aquilla.editor.annotate(...)`.
 *   3. `CellExtensionActions` — `manifest.actions` with `where: ["cell"]`,
 *      rendered inside native `CellSourceMenu`.
 *   4. `SelectionExtensionActions` — `manifest.actions` with `where: ["selection"]`,
 *      rendered inside native `SourceSelectionToolbar`.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react"
import { Columns3, PanelLeft, Play, Sparkles, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"
import type { ToolColumn } from "../../../shared/tools/manifest"
import { applySpanFix, type AnnotationTone } from "../../../shared/tools/native-editor"
import { EMPTY_CELL_ANNOTATIONS, type ResolvedBadge, type ResolvedSpan } from "@/lib/tools/native-editor-store"
import { ExtensionMarker } from "./ExtensionMarker"
import { useToolsMount } from "./ToolsMountContext"

const MIN_TEXT_COLUMN_PX = 200
const MD_PX = 768
const MAX_EXTENSION_COLUMNS = 3

export type ExtensionColumnsLayout = "none" | "columns" | "stacked"

export interface ActiveExtensionColumn {
  key: string
  toolId: string
  toolName: string
  column: ToolColumn
  placement: "before" | "after"
}

export interface ExtensionColumnsValue {
  all: ActiveExtensionColumn[]
  visible: ActiveExtensionColumn[]
  before: ActiveExtensionColumn[]
  after: ActiveExtensionColumn[]
  layout: ExtensionColumnsLayout
  hide: (key: string) => void
  show: (key: string) => void
}

const ExtensionColumnsContext = createContext<ExtensionColumnsValue | null>(null)

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

export function extensionColumnsLayout(width: number, gutterPx: number, count: number, extraTracks = 0): ExtensionColumnsLayout {
  if (count === 0) return "none"
  if (count > MAX_EXTENSION_COLUMNS || width < MD_PX) return "stacked"
  const tracks = count + 2 + extraTracks
  const usable = width - gutterPx - 26 - 8 * tracks
  return usable / tracks >= MIN_TEXT_COLUMN_PX ? "columns" : "stacked"
}

export function useNativeExtensionColumns(args: {
  widthRef: RefObject<HTMLElement | null>
  gutterPx: number
  /** Existing extra text tracks (Bible columns + Back-translation column). */
  extraTracks: number
}): ExtensionColumnsValue | null {
  const ctx = useToolsMount()
  const width = useElementWidth(args.widthRef)
  const store = ctx?.nativeEditor ?? null
  const storeVersion = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getVersion : zeroSnapshot,
    zeroSnapshot,
  )

  return useMemo(() => {
    void storeVersion
    if (!ctx) return null
    const all: ActiveExtensionColumn[] = []
    for (const tool of ctx.tools) {
      for (const col of tool.manifest.columns ?? []) {
        all.push({
          key: `${tool.id}:${col.id}`,
          toolId: tool.id,
          toolName: tool.name,
          column: col,
          placement: col.placement === "before" ? "before" : "after",
        })
      }
    }
    if (all.length === 0) return null
    const visible = all.filter((c) => {
      const pref = ctx.columnPrefs[c.key]
      if (pref === "shown") return true
      if (pref === "hidden") return false
      // Auto-open once the extension actually writes values for this column.
      return ctx.nativeEditor.hasPopulatedColumn(c.toolId, c.column.id)
    })
    const layout = extensionColumnsLayout(width, args.gutterPx, visible.length, args.extraTracks)
    const before = visible.filter((c) => c.placement === "before")
    const after = visible.filter((c) => c.placement === "after")
    return {
      all,
      visible,
      before,
      after,
      layout,
      show: (key) => ctx.setColumnPref(key, "shown"),
      hide: (key) => ctx.setColumnPref(key, "hidden"),
    }
  }, [ctx, width, args.gutterPx, args.extraTracks, storeVersion])
}

export function ExtensionColumnsProvider({ value, children }: { value: ExtensionColumnsValue | null; children: ReactNode }) {
  return <ExtensionColumnsContext.Provider value={value}>{children}</ExtensionColumnsContext.Provider>
}

// ── 1. Extension-contributed native columns ─────────────────────────────────

export function ExtensionColumnHeaders({ placement }: { placement: "before" | "after" }) {
  const t = useT()
  const colCtx = useContext(ExtensionColumnsContext)
  if (!colCtx || colCtx.layout !== "columns") return null
  const list = placement === "before" ? colCtx.before : colCtx.after
  if (list.length === 0) return null
  return (
    <>
      {list.map((item) => (
        <div
          key={item.key}
          data-testid={`extension-column-header-${item.column.id}`}
          className="hidden min-w-0 items-center gap-1.5 border-s border-border/50 px-2 md:flex"
        >
          <ExtensionMarker iconOnly />
          <span className="min-w-0 truncate">{item.column.label}</span>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={() => colCtx.hide(item.key)}
            className="ms-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" aria-hidden />
          </button>
        </div>
      ))}
    </>
  )
}

const TONE_BADGE: Record<AnnotationTone, string> = {
  neutral: "border-border bg-muted/60 text-foreground",
  info: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  error: "border-destructive/40 bg-destructive/10 text-destructive",
  success: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
}

const TONE_SPAN: Record<AnnotationTone, string> = {
  neutral: "decoration-muted-foreground/70 bg-muted/40",
  info: "decoration-sky-500 bg-sky-500/10 text-sky-900 dark:text-sky-200",
  warn: "decoration-amber-500 bg-amber-500/10 text-amber-900 dark:text-amber-200",
  error: "decoration-destructive bg-destructive/10 text-destructive",
  success: "decoration-emerald-500 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
}

export function ExtensionRowColumns({
  fileId,
  cellId,
  placement,
  fontSize,
  dir,
}: {
  fileId: string
  cellId: string
  placement: "before" | "after"
  fontSize?: number
  dir?: "ltr" | "rtl" | "auto"
}) {
  const colCtx = useContext(ExtensionColumnsContext)
  const toolsCtx = useToolsMount()
  const store = toolsCtx?.nativeEditor ?? null
  useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getVersion : zeroSnapshot,
    zeroSnapshot,
  )
  if (!colCtx || !store || colCtx.layout !== "columns") return null
  const list = placement === "before" ? colCtx.before : colCtx.after
  if (list.length === 0) return null
  return (
    <>
      {list.map((item) => {
        const entry = store.getColumnCell(fileId, item.toolId, item.column.id, cellId)
        return (
          <div
            key={item.key}
            data-testid={`extension-column-cell-${item.column.id}`}
            dir={entry?.dir ?? dir ?? "auto"}
            style={fontSize ? { fontSize: `${fontSize}px`, lineHeight: "1.6" } : undefined}
            className="hidden min-w-0 flex-col gap-1 border-s border-border/50 px-2 py-1.5 text-muted-foreground md:flex"
          >
            {entry?.badge && (
              <span className={cn("inline-flex w-fit items-center rounded border px-1.5 py-0.5 text-[10px] font-medium leading-3", TONE_BADGE[entry.tone ?? "neutral"])}>
                {entry.badge}
              </span>
            )}
            {entry?.text ? (
              <p className="whitespace-pre-wrap break-words text-foreground/90">{entry.text}</p>
            ) : (
              <span className="text-xs text-muted-foreground/40">—</span>
            )}
          </div>
        )
      })}
    </>
  )
}

export function ExtensionRowColumnStack({ fileId, cellId }: { fileId: string; cellId: string }) {
  const colCtx = useContext(ExtensionColumnsContext)
  const toolsCtx = useToolsMount()
  const store = toolsCtx?.nativeEditor ?? null
  useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getVersion : zeroSnapshot,
    zeroSnapshot,
  )
  if (!colCtx || !store || colCtx.layout !== "stacked" || colCtx.visible.length === 0) return null
  const populated = colCtx.visible
    .map((item) => ({ item, entry: store.getColumnCell(fileId, item.toolId, item.column.id, cellId) }))
    .filter((x) => x.entry && (x.entry.text || x.entry.badge))
  if (populated.length === 0) return null
  return (
    <div className="mt-1.5 flex flex-col gap-1 border-t border-border/40 pt-1.5 text-xs" data-testid="extension-column-stack">
      {populated.map(({ item, entry }) => (
        <div key={item.key} className="flex flex-col gap-0.5 rounded bg-muted/30 px-2 py-1" dir={entry?.dir ?? "auto"}>
          <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
            <ExtensionMarker iconOnly />
            <span>{item.column.label}</span>
            {entry?.badge && (
              <span className={cn("ms-auto rounded border px-1 py-0 text-[10px]", TONE_BADGE[entry.tone ?? "neutral"])}>
                {entry.badge}
              </span>
            )}
          </div>
          {entry?.text && <p className="whitespace-pre-wrap break-words text-foreground/90">{entry.text}</p>}
        </div>
      ))}
    </div>
  )
}

/** Column toggles shown in `ExtensionsBar` when any installed extension declares `manifest.columns`. */
export function ExtensionColumnToggles() {
  const ctx = useToolsMount()
  const store = ctx?.nativeEditor ?? null
  useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getVersion : zeroSnapshot,
    zeroSnapshot,
  )
  if (!ctx || !store) return null
  const cols = ctx.tools.flatMap((tool) =>
    (tool.manifest.columns ?? []).map((col) => {
      const key = `${tool.id}:${col.id}`
      const pref = ctx.columnPrefs[key]
      const shown = pref === "shown" || (pref !== "hidden" && store.hasPopulatedColumn(tool.id, col.id))
      return { key, tool, col, shown }
    }),
  )
  if (cols.length === 0) return null
  return (
    <>
      {cols.map(({ key, tool, col, shown }) => (
        <Button
          key={key}
          size="xs"
          variant={shown ? "secondary" : "outline"}
          aria-pressed={shown}
          title={col.description || `${tool.name}: ${col.label}`}
          data-testid={`extension-column-toggle-${col.id}`}
          onClick={() => ctx.setColumnPref(key, shown ? "hidden" : "shown")}
        >
          <ExtensionMarker iconOnly />
          <Columns3 className="size-3" aria-hidden />
          {col.label}
        </Button>
      ))}
    </>
  )
}

// ── 2. Declarative native row badges, span highlights & quick-fixes ─────────

function BadgeChip({
  badge,
  fileId,
  cellId,
  cellRef,
}: {
  badge: ResolvedBadge
  fileId: string
  cellId: string
  cellRef: string | null
}) {
  const t = useT()
  const ctx = useToolsMount()
  const toneClass = TONE_BADGE[badge.tone ?? "neutral"]

  const onDirectClick = () => {
    if (!ctx) return
    if (badge.actionId) {
      ctx.runAction(badge.toolId, badge.actionId, "cell", { cell: { fileId, cellId, ref: cellRef } })
    } else if (badge.openPanel) {
      ctx.openInPanel(badge.toolId)
    }
  }

  // If the badge has a tooltip (or both tooltip + action/panel), clicking opens
  // a compact popover (AQU-2260: accessible on click, never hover-only).
  if (badge.tooltip) {
    return (
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid="extension-row-badge"
              data-extension-tool={badge.toolId}
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-3 transition-colors hover:opacity-85",
                toneClass,
              )}
            />
          }
        >
          <ExtensionMarker iconOnly />
          <span>{badge.label}</span>
        </PopoverTrigger>
        <PopoverContent className="w-72 space-y-2 p-2.5 text-xs" align="start">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <ExtensionMarker iconOnly />
            <span className="truncate">{badge.toolName}</span>
            <span className="text-muted-foreground">· {badge.label}</span>
          </div>
          <p className="leading-relaxed text-muted-foreground">{badge.tooltip}</p>
          {(badge.actionId || badge.openPanel) && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {badge.actionId && (
                <Button size="xs" variant="secondary" onClick={onDirectClick}>
                  <Play className="size-3" aria-hidden />
                  {t("extensions.action.runLabel", { action: badge.label })}
                </Button>
              )}
              {badge.openPanel && (
                <Button size="xs" variant="outline" onClick={() => ctx?.openInPanel(badge.toolId)}>
                  <PanelLeft className="size-3" aria-hidden />
                  {t("extensions.palette.openPanel", { name: badge.toolName })}
                </Button>
              )}
            </div>
          )}
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <button
      type="button"
      data-testid="extension-row-badge"
      data-extension-tool={badge.toolId}
      onClick={onDirectClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-3 transition-colors hover:opacity-85",
        toneClass,
      )}
    >
      <ExtensionMarker iconOnly />
      <span>{badge.label}</span>
    </button>
  )
}

function SpanChip({
  span,
  excerpt,
  editable,
  targetText,
  onApplyTargetFix,
}: {
  span: ResolvedSpan
  excerpt: string
  editable: boolean
  targetText: string
  onApplyTargetFix?: (nextTarget: string) => void
}) {
  const t = useT()
  const ctx = useToolsMount()
  const [open, setOpen] = useState(false)
  const canFix = Boolean(span.fix && editable && onApplyTargetFix)

  const handleFix = () => {
    if (!canFix || !onApplyTargetFix) return
    const next = applySpanFix(targetText, span)
    if (next !== null) {
      onApplyTargetFix(next)
      setOpen(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-testid="extension-row-span"
            data-extension-side={span.side}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] leading-4 underline decoration-wavy underline-offset-2 transition-colors hover:opacity-85",
              TONE_SPAN[span.tone ?? "info"],
            )}
          />
        }
      >
        <ExtensionMarker iconOnly />
        <span className="truncate">{excerpt || span.label || span.side}</span>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2 p-3 text-xs" align="start">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <ExtensionMarker iconOnly />
          <span className="truncate">{span.label || span.toolName}</span>
          <span className="ms-auto rounded bg-muted px-1 py-0.5 text-[10px] font-normal uppercase text-muted-foreground">
            {span.side}
          </span>
        </div>
        {excerpt && (
          <p className="rounded bg-muted/50 px-2 py-1 font-mono text-[11px] text-foreground">
            “{excerpt}”
          </p>
        )}
        <p className="leading-relaxed text-muted-foreground">{span.message}</p>
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {canFix && span.fix && (
            <Button size="xs" variant="default" data-testid="extension-span-apply-fix" onClick={handleFix}>
              <Sparkles className="size-3" aria-hidden />
              {span.fix.label}
            </Button>
          )}
          {span.openPanel && (
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                ctx?.openInPanel(span.toolId)
                setOpen(false)
              }}
            >
              <PanelLeft className="size-3" aria-hidden />
              {t("extensions.palette.openPanel", { name: span.toolName })}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function ExtensionRowAnnotations({
  fileId,
  cellId,
  cellRef,
  sourceText,
  targetText,
  editable,
  onApplyTargetFix,
}: {
  fileId: string
  cellId: string
  cellRef: string | null
  sourceText: string
  targetText: string
  editable: boolean
  onApplyTargetFix?: (nextTarget: string) => void
}) {
  const ctx = useToolsMount()
  const store = ctx?.nativeEditor ?? null
  const annotations = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    () => (store ? store.getCellAnnotations(fileId, cellId) : EMPTY_CELL_ANNOTATIONS),
    () => EMPTY_CELL_ANNOTATIONS,
  )
  if (annotations.badges.length === 0 && annotations.spans.length === 0) return null

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="extension-row-annotations" dir="ltr">
      {annotations.badges.map((badge, i) => (
        <BadgeChip key={`${badge.toolId}:${badge.layer}:${badge.id ?? i}`} badge={badge} fileId={fileId} cellId={cellId} cellRef={cellRef} />
      ))}
      {annotations.spans.map((span, i) => {
        const text = span.side === "source" ? sourceText : targetText
        const excerpt = text.slice(Math.max(0, span.start), Math.min(text.length, span.end)).trim()
        return (
          <SpanChip
            key={`${span.toolId}:${span.layer}:${span.id ?? i}`}
            span={span}
            excerpt={excerpt}
            editable={editable}
            targetText={targetText}
            onApplyTargetFix={onApplyTargetFix}
          />
        )
      })}
    </div>
  )
}

// ── 3. Cell menu actions (`where: ["cell"]`) ────────────────────────────────

export function CellExtensionActions({
  fileId,
  cellId,
  cellRef,
}: {
  fileId: string
  cellId: string
  cellRef: string | null
}) {
  const ctx = useToolsMount()
  if (!ctx || ctx.tools.length === 0) return null
  const items = ctx.tools.flatMap((tool) =>
    (tool.manifest.actions ?? [])
      .filter((a) => a.where.includes("cell"))
      .map((action) => ({ tool, action })),
  )
  if (items.length === 0) return null
  return (
    <>
      <ContextMenuSeparator />
      {items.map(({ tool, action }) => (
        <ContextMenuItem
          key={`${tool.id}:${action.id}`}
          data-testid={`cell-menu-extension-${action.id}`}
          onClick={() => ctx.runAction(tool.id, action.id, "cell", { cell: { fileId, cellId, ref: cellRef } })}
        >
          <span className="mr-2 inline-flex shrink-0 items-center" aria-hidden>
            <ExtensionMarker iconOnly />
          </span>
          <span className="truncate">{action.label}</span>
        </ContextMenuItem>
      ))}
    </>
  )
}

// ── 4. Source selection toolbar actions (`where: ["selection"]`) ────────────

export function useHasSelectionExtensionActions(): boolean {
  const ctx = useToolsMount()
  return (ctx?.tools ?? []).some((t) => (t.manifest.actions ?? []).some((a) => a.where.includes("selection")))
}

export function SelectionExtensionActions({
  fileId,
  cellId,
  cellRef,
  selectionText,
  onMouseDown,
}: {
  fileId: string
  cellId: string
  cellRef: string | null
  selectionText: string
  onMouseDown?: (e: MouseEvent) => void
}) {
  const ctx = useToolsMount()
  if (!ctx || !selectionText.trim() || ctx.tools.length === 0) return null
  const items = ctx.tools.flatMap((tool) =>
    (tool.manifest.actions ?? [])
      .filter((a) => a.where.includes("selection"))
      .map((action) => ({ tool, action })),
  )
  if (items.length === 0) return null
  return (
    <>
      {items.map(({ tool, action }) => (
        <Button
          key={`${tool.id}:${action.id}`}
          type="button"
          size="xs"
          variant="ghost"
          data-testid={`selection-extension-${action.id}`}
          title={tool.name}
          onMouseDown={onMouseDown}
          onClick={() =>
            ctx.runAction(tool.id, action.id, "selection", {
              cell: { fileId, cellId, ref: cellRef },
              selection: { fileId, cellId, side: "source", text: selectionText },
            })
          }
        >
          <ExtensionMarker iconOnly />
          {action.label}
        </Button>
      ))}
    </>
  )
}

const noopSubscribe = () => () => {}
const zeroSnapshot = () => 0
