// The Bible document layout (AQU-2559): a book's source and translation side
// by side as flowing text, with an optional live preview of the exported file.
// It replaces the cell table for one file and drives the same cell store and
// the same commit path, so everything else in the workspace keeps working.

import { useCallback, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react"
import { Heading, Link2 } from "lucide-react"
import type { EditorTableHandle } from "@/components/EditorTable"
import { EDITOR_SURFACE_TOOLBAR_CLASS } from "@/components/editor-surface-toolbar"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Toggle } from "@/components/ui/toggle"
import { AppTooltip } from "@/components/ui/tooltip"
import { readAtVersion, useCellStoreVersion, type CellStore } from "@/hooks/useActiveCellStore"
import { unitsFromCells } from "@/lib/bible-document/units"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { setBibleDocumentPanes, useBibleDocumentViewPref } from "@/lib/store/bible-document-view-pref"
import { cn } from "@/lib/utils"
import { ExportPreviewPane } from "./ExportPreviewPane"
import { SourceDocumentPane } from "./SourceDocumentPane"
import { TargetDocumentEditor, type TargetDocumentHandle } from "./TargetDocumentEditor"
import { useLinkedScroll } from "./useLinkedScroll"
import { useUsfmExportPreview } from "./useUsfmExportPreview"

/** Above this many cells one editor document is too heavy to type in. Books
 *  import one per file, and the longest (Psalms) is about 2,700. */
const DOCUMENT_UNIT_LIMIT = 6_000

const STYLES = ["p", "m", "pi", "q1", "q2", "q3", "li1", "pc"] as const
const STYLE_KEY: Record<(typeof STYLES)[number], MessageKey> = {
  p: "bibleDocument.style.p",
  m: "bibleDocument.style.m",
  pi: "bibleDocument.style.pi",
  q1: "bibleDocument.style.q1",
  q2: "bibleDocument.style.q2",
  q3: "bibleDocument.style.q3",
  li1: "bibleDocument.style.li1",
  pc: "bibleDocument.style.pc",
}

/** The HTML a table row's editor opens from: the same lines, as line breaks. */
function htmlForValue(value: string): string {
  const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return `<p>${value.split(/\r?\n/).map(escape).join("<br>")}</p>`
}

export interface BibleDocumentViewProps {
  projectId: string
  fileId: string
  lane?: string
  store: CellStore
  /** True until the store holds the whole file. */
  loading: boolean
  editable: boolean
  /** The person holding a cell's focus lock, when it is not us. */
  lockedBy: (cellId: string) => string | null
  lockVersion: unknown
  onClaimCell: (cellId: string) => void
  onReleaseCell: (cellId: string) => void
  commitTarget: (cellId: string, snapshot: { value: string; valueHtml: string }) => Promise<unknown>
  getToken: (fileId: string) => Promise<string | null>
  /** The workspace's file toolbar (layout switch, lens switch, file options). */
  toolbar?: ReactNode
  sourceDir?: "ltr" | "rtl"
  targetDir?: "ltr" | "rtl"
  sourceFontSize?: number
  targetFontSize?: number
  /** Serves the table's handle, so search results and navigation still land. */
  handleRef?: Ref<EditorTableHandle | null>
}

export function BibleDocumentView(props: BibleDocumentViewProps) {
  const { projectId, fileId, lane, store, loading, editable, lockedBy, lockVersion, onClaimCell, onReleaseCell, commitTarget, getToken } = props
  const t = useT()
  const pref = useBibleDocumentViewPref()
  const version = useCellStoreVersion(store)
  const cells = useMemo(() => readAtVersion(version, () => store.getAllCellViews()), [store, version])
  const units = useMemo(() => unitsFromCells(cells), [cells])

  const [activeCellId, setActiveCellId] = useState<string | null>(null)
  const [marker, setMarker] = useState<string | null>(null)
  const [unsaved, setUnsaved] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [failed, setFailed] = useState(0)
  const [notice, setNotice] = useState<"locked" | null>(null)

  const targetRef = useRef<TargetDocumentHandle | null>(null)
  const sourcePaneRef = useRef<HTMLDivElement | null>(null)
  const targetPaneRef = useRef<HTMLDivElement | null>(null)
  const claimedRef = useRef<string | null>(null)

  const tooLong = units.length > DOCUMENT_UNIT_LIMIT
  const canEdit = editable && !loading && !tooLong

  useLinkedScroll([sourcePaneRef, targetPaneRef], pref.linked && pref.source && !tooLong)

  const preview = useUsfmExportPreview({ enabled: pref.preview && !tooLong, projectId, fileId, lane, getToken, cells, unsaved })
  const activeRef = useMemo(
    () => (activeCellId ? units.find((u) => u.cellId === activeCellId)?.ref ?? null : null),
    [activeCellId, units],
  )

  const handleActiveCell = useCallback((cellId: string | null) => {
    if (claimedRef.current && claimedRef.current !== cellId) onReleaseCell(claimedRef.current)
    claimedRef.current = cellId
    if (cellId) {
      onClaimCell(cellId)
      // The caret left: the last verse stays marked on the source side.
      setActiveCellId(cellId)
    }
    setNotice(null)
  }, [onClaimCell, onReleaseCell])

  const handleUnsaved = useCallback((next: ReadonlyMap<string, string>, failures: number) => {
    setUnsaved(next)
    setFailed(failures)
  }, [])

  const handleCommit = useCallback(async (cellId: string, value: string) => {
    await commitTarget(cellId, { value, valueHtml: htmlForValue(value) })
  }, [commitTarget])

  const handleRejected = useCallback((reason: "skeleton" | "locked" | "read-only") => {
    if (reason === "locked") setNotice("locked")
  }, [])

  const scrollTo = useCallback((cellId: string): boolean => {
    let found = false
    for (const pane of [sourcePaneRef.current, targetPaneRef.current]) {
      const el = pane?.querySelector(`[data-cell-id="${CSS.escape(cellId)}"]`)
      if (!el) continue
      el.scrollIntoView({ block: "center" })
      found = true
    }
    return found
  }, [])

  const pickCell = useCallback((cellId: string) => {
    setActiveCellId(cellId)
    targetRef.current?.focusCell(cellId)
  }, [])

  useImperativeHandle(props.handleRef, () => ({
    scrollToCellId: (cellId) => scrollTo(cellId),
    getTopVisibleCellId: () => {
      const pane = targetPaneRef.current
      if (!pane) return null
      const top = pane.getBoundingClientRect().top
      for (const el of pane.querySelectorAll<HTMLElement>("[data-cell-id]")) {
        if (el.getBoundingClientRect().bottom >= top) return el.dataset.cellId ?? null
      }
      return null
    },
    setMediaFollow: () => {},
    focusCellEditorIndex: (index) => {
      const id = store.getCellIds()[index]
      if (id) targetRef.current?.focusCell(id)
    },
    focusCellEditorId: (cellId) => targetRef.current?.focusCell(cellId) ?? false,
    getCurrentIndex: () => (activeCellId ? store.getCellIds().indexOf(activeCellId) : -1),
    flashCell: (cellId) => {
      scrollTo(cellId)
    },
    pulseCells: (cellIds) => {
      if (cellIds[0]) scrollTo(cellIds[0])
    },
  }), [activeCellId, scrollTo, store])

  const styleItems = useMemo(() => {
    const known = STYLES.map((value) => ({ value: value as string, label: t(STYLE_KEY[value]) }))
    return marker && !known.some((s) => s.value === marker) ? [...known, { value: marker, label: `\\${marker}` }] : known
  }, [marker, t])

  const status = failed > 0
    ? t("bibleDocument.status.failed", { count: failed })
    : notice === "locked"
      ? t("bibleDocument.status.locked")
      : !editable
        ? t("bibleDocument.status.readOnly")
        : unsaved.size > 0
          ? t("bibleDocument.status.saving")
          : t("bibleDocument.status.saved")

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bible-document-view">
      <div className={cn(EDITOR_SURFACE_TOOLBAR_CLASS, "justify-between")} data-testid="bible-document-toolbar">
        <div className="flex min-w-0 items-center gap-1.5">
          <Select
            items={styleItems}
            value={marker ?? ""}
            onValueChange={(value) => { if (value) targetRef.current?.setParagraphMarker(String(value)) }}
            disabled={!canEdit || marker === null}
          >
            <SelectTrigger aria-label={t("bibleDocument.toolbar.paragraphStyle")} className="h-8 w-44">
              <SelectValue placeholder={t("bibleDocument.toolbar.paragraphStyle")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {styleItems.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" className="h-8" disabled={!canEdit || marker === null} onClick={() => targetRef.current?.insertHeading()}>
            <Heading data-icon="inline-start" aria-hidden />
            {t("bibleDocument.toolbar.heading")}
          </Button>
          <span className="mx-1 h-5 w-px bg-border" aria-hidden />
          <Toggle size="sm" variant="outline" pressed={pref.source} onPressedChange={(on) => setBibleDocumentPanes({ source: on })}>
            {t("bibleDocument.pane.source")}
          </Toggle>
          <Toggle size="sm" variant="outline" pressed={pref.preview} onPressedChange={(on) => setBibleDocumentPanes({ preview: on })}>
            {t("bibleDocument.pane.preview")}
          </Toggle>
          <AppTooltip content={t("bibleDocument.toolbar.linkedScroll")}>
            <Toggle
              size="sm"
              variant="outline"
              aria-label={t("bibleDocument.toolbar.linkedScroll")}
              pressed={pref.linked}
              disabled={!pref.source}
              onPressedChange={(on) => setBibleDocumentPanes({ linked: on })}
            >
              <Link2 aria-hidden />
            </Toggle>
          </AppTooltip>
          <span role="status" className={cn("ms-2 truncate text-xs", failed > 0 || notice ? "text-destructive" : "text-muted-foreground")}>
            {status}
          </span>
          {failed > 0 ? (
            <Button variant="ghost" size="xs" onClick={() => void targetRef.current?.flush()}>{t("common.retry")}</Button>
          ) : null}
        </div>
        {props.toolbar}
      </div>

      {tooLong ? (
        <p role="status" className="p-6 text-sm text-muted-foreground">{t("bibleDocument.tooLong")}</p>
      ) : (
        <div className="flex min-h-0 flex-1 divide-x divide-border" aria-busy={loading}>
          {pref.source ? (
            <section aria-label={t("bibleDocument.pane.source")} className="flex min-w-0 flex-1 flex-col bg-muted/20">
              <PaneTitle>{t("bibleDocument.pane.source")}</PaneTitle>
              <div ref={sourcePaneRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="bible-document-source">
                <div className="mx-auto max-w-[68ch] px-8 pb-24 pt-4">
                  <SourceDocumentPane
                    units={units}
                    activeCellId={activeCellId}
                    onPickCell={pickCell}
                    dir={props.sourceDir}
                    fontSize={props.sourceFontSize}
                  />
                </div>
              </div>
            </section>
          ) : null}
          <section aria-label={t("bibleDocument.pane.translation")} className="flex min-w-0 flex-1 flex-col">
            <PaneTitle>{t("bibleDocument.pane.translation")}</PaneTitle>
            <div ref={targetPaneRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="bible-document-target">
              <div className="mx-auto max-w-[68ch] px-8 pb-24 pt-4">
                <TargetDocumentEditor
                  ref={targetRef}
                  units={units}
                  editable={canEdit}
                  lockedBy={lockedBy}
                  lockVersion={lockVersion}
                  dir={props.targetDir}
                  fontSize={props.targetFontSize}
                  ariaLabel={t("bibleDocument.editorLabel")}
                  onCommit={handleCommit}
                  onActiveCellChange={handleActiveCell}
                  onParagraphMarkerChange={setMarker}
                  onUnsavedChange={handleUnsaved}
                  onRejected={handleRejected}
                />
              </div>
            </div>
          </section>
          {pref.preview ? (
            <section aria-label={t("bibleDocument.pane.preview")} className="flex min-w-0 flex-1 flex-col bg-muted/20">
              <PaneTitle>
                {t("bibleDocument.pane.preview")}
                {preview.status === "ready" ? (
                  <span className="ms-2 font-normal normal-case tracking-normal" data-testid="export-preview-summary">
                    {t("bibleDocument.preview.summary", { translated: preview.preview.translated, total: preview.preview.total })}
                    {preview.preview.lossy > 0 ? ` · ${t("bibleDocument.preview.lossy", { count: preview.preview.lossy })}` : ""}
                  </span>
                ) : null}
              </PaneTitle>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-24 pt-2">
                <p className="pb-2 text-xs text-muted-foreground">{t("bibleDocument.preview.hint")}</p>
                <ExportPreviewPane state={preview} activeRef={activeRef} />
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}

function PaneTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="shrink-0 truncate border-b border-border/60 px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h2>
  )
}
