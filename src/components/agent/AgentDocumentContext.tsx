import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { FileText } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { useT } from "@/lib/i18n/I18nProvider"
import { AgentContextRows } from "./AgentContextPane"
import type { AgentWorkbenchProps } from "./AgentWorkbench"

export interface AgentDocumentContextProps {
  /** Reports this mounted viewport; the workspace owner clears visibility when leaving Document. */
  workspace: NonNullable<AgentWorkbenchProps["workspace"]>
  onChooseFile?: () => void
  /** Reports focus within a paired row, including its read surfaces and actions. */
  onFocusedCellIdChange?: (cellId: string) => void
}

/** One document viewport and one height-owning grid row per source/target pair. */
export function AgentDocumentContext({ workspace, onChooseFile, onFocusedCellIdChange }: AgentDocumentContextProps) {
  const t = useT()
  const scrollRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef<HTMLDivElement>(null)
  const visibleCallbackRef = useRef(workspace.onVisibleCellIdsChange)
  const requestedCellRef = useRef(workspace.focusedCellId)
  const lastReportRef = useRef<{ ids: string[]; callback: typeof workspace.onVisibleCellIdsChange } | null>(null)
  const navigatedCellRef = useRef<string | null>(null)
  const [focus, setFocus] = useState({ requested: workspace.focusedCellId, cellId: workspace.focusedCellId ?? null })
  if (focus.requested !== workspace.focusedCellId) {
    setFocus({ requested: workspace.focusedCellId, cellId: workspace.focusedCellId ?? null })
  }

  const reportVisibleCells = useCallback(() => {
    const root = scrollRef.current
    const callback = visibleCallbackRef.current
    if (!root) return
    const rows = Array.from(root.querySelectorAll<HTMLElement>("article[data-cell-id]"))
    const viewport = root.getBoundingClientRect()
    // A hidden/unmeasured view is not an empty reading scope.
    if (rows.length > 0 && viewport.bottom <= viewport.top) return
    const requested = requestedCellRef.current
    if (requested && navigatedCellRef.current !== requested) {
      const row = rows.find((candidate) => candidate.dataset.cellId === requested)
      const rect = row?.getBoundingClientRect()
      if (rect && rect.bottom > rect.top) {
        if (rect.top < viewport.top) root.scrollTop += rect.top - viewport.top
        else if (rect.bottom > viewport.bottom) root.scrollTop += Math.min(rect.top - viewport.top, rect.bottom - viewport.bottom)
        navigatedCellRef.current = requested
      }
    }
    if (!callback) return
    const ids = rows.filter((row) => {
      const rect = row.getBoundingClientRect()
      return rect.bottom > viewport.top && rect.top < viewport.bottom
    }).flatMap((row) => row.dataset.cellId ? [row.dataset.cellId] : [])
    const previous = lastReportRef.current
    if (previous?.callback === callback && previous.ids.length === ids.length
      && previous.ids.every((id, index) => id === ids[index])) return
    lastReportRef.current = { ids, callback }
    callback(ids)
  }, [])

  useLayoutEffect(() => {
    visibleCallbackRef.current = workspace.onVisibleCellIdsChange
    requestedCellRef.current = workspace.focusedCellId
    if (!workspace.focusedCellId) navigatedCellRef.current = null
    reportVisibleCells()
  }, [workspace.cells, workspace.focusedCellId, workspace.onVisibleCellIdsChange, reportVisibleCells])

  useEffect(() => {
    const root = scrollRef.current
    const rows = rowsRef.current
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(reportVisibleCells) : null
    if (root) observer?.observe(root)
    if (rows) observer?.observe(rows)
    const frame = requestAnimationFrame(reportVisibleCells)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [reportVisibleCells])

  const sourceLabel = [t("editor.column.source"), workspace.sourceLanguage].filter(Boolean).join(" · ")
  const targetLabel = [t("editor.column.target"), workspace.targetLanguage].filter(Boolean).join(" · ")
  const hasScope = workspace.scopeAvailable !== false && Boolean(workspace.fileName)
  const emptyTitle = workspace.loading ? t("common.loading")
    : hasScope ? t("editor.file.emptyNamedTitle", { fileName: workspace.fileName! }) : t("agentWorkspace.chooseFile")

  return (
    <section
      aria-label={workspace.fileName || t("common.file")}
      aria-busy={workspace.loading || undefined}
      data-testid="agent-document-context"
      className="@container flex h-full min-h-0 min-w-0 flex-col bg-background"
    >
      <header className="shrink-0 border-b border-border/70">
        <div className="flex min-h-10 items-center gap-3 px-4 py-2">
          <h2 className="min-w-0 truncate text-sm font-medium">{workspace.fileName || t("agentWorkspace.chooseFile")}</h2>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {t("common.cellCount", { count: workspace.totalCells ?? workspace.cells.length })}
          </span>
          {onChooseFile && workspace.cells.length > 0 && (
            <Button variant="ghost" size="sm" onClick={onChooseFile}>
              <FileText data-icon="inline-start" />
              {t("agentWorkspace.chooseFile")}
            </Button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 px-4 pb-2 text-xs text-muted-foreground">
          <h3 className="min-w-0 truncate">{sourceLabel}</h3>
          <h3 className="min-w-0 truncate">{targetLabel}</h3>
        </div>
      </header>
      <div
        ref={scrollRef}
        data-testid="document-context-scroll"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        onScroll={reportVisibleCells}
        onFocusCapture={(event) => {
          const row = (event.target as HTMLElement).closest<HTMLElement>("article[data-cell-id]")
          const cellId = row?.dataset.cellId
          if (!cellId || !event.currentTarget.contains(row)) return
          setFocus({ requested: workspace.focusedCellId, cellId })
          if (!row.contains(event.relatedTarget as Node | null)) onFocusedCellIdChange?.(cellId)
        }}
      >
        <div ref={rowsRef} className="min-w-0 divide-y divide-border/60">
          <AgentContextRows {...workspace} kind="target" language={workspace.targetLanguage} paired focusedCellId={focus.cellId} />
        </div>
        {workspace.cells.length === 0 && (
          <Empty className="min-h-48">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileText /></EmptyMedia>
              <EmptyTitle>{emptyTitle}</EmptyTitle>
              <EmptyDescription>
                {workspace.loading ? t("common.loading")
                  : hasScope ? t("editor.file.emptyTitle") : t("editor.sync.noFileOpenTooltip")}
              </EmptyDescription>
            </EmptyHeader>
            {onChooseFile && !workspace.loading && (
              <EmptyContent>
                <Button variant="outline" size="sm" onClick={onChooseFile}>
                  <FileText data-icon="inline-start" />
                  {t("agentWorkspace.chooseFile")}
                </Button>
              </EmptyContent>
            )}
          </Empty>
        )}
      </div>
    </section>
  )
}
