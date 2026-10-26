// The Transcribe lens (docs/superpowers/specs/2026-10-23-transcript-cleanup-design.md §2–3).
//
// Every line of the file that has a clip, one row each. The sparkle on a row
// transcribes it (when nothing ASR heard is saved yet) and cleans the
// transcript up with AI, taught by the corrections already made in this file's
// rows of the same language. "Transcribe and clean up all" works through the
// rows that are neither validated nor corrected by hand, one at a time.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { Sparkles, Square } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { CellData } from "@/hooks/useCells"
import { useT } from "@/lib/i18n/I18nProvider"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"
import type { WordTiming } from "@/lib/codex-editor/types"
import { notifyAudioAttachmentsChanged } from "@/lib/audio/audio-attachments-bus"
import { firstActuallyVisibleIndex } from "@/lib/chapter-navigation"
import { PENDING_CELL_SCROLL_MAX_ATTEMPTS } from "@/components/pending-cell-scroll"
import { loadTranscriptCorrections } from "@/lib/store/transcript-corrections-store"
import { isHumanCorrected, transcriptRowOf, type TranscriptRow } from "@/lib/transcript-cleanup/rows"
import { transcribeAndCleanUp } from "@/lib/transcript-cleanup/run"
import { saveTranscript } from "@/lib/transcript-cleanup/save"
import { TranscribeRow, type RowStatus } from "./TranscribeRow"

interface Props {
  project: ProjectRecord
  /** The active file's cells, merged with their audio attachments. */
  cells: readonly CellData[]
  session: FrontierSession | null
  /** The active target lane's tag; takes are transcribed and saved in it. */
  targetLang?: string
  /** Key terms, already filtered to the active lane. */
  concepts: readonly Concept[]
  editable: boolean
  /** Flush the outbox and refetch the cell (the editor's onCellCommitted). */
  onCommitted?: (cellId?: string) => Promise<void> | void
  /** Whether the file's audio attachments have been read (the attachments
   *  hook's `hasLoaded`). Until then an empty row list means "not read yet",
   *  not "no audio", so the empty state waits for it. Omitted reads as read. */
  audioLoaded?: boolean
  /**
   * AQU-2153: the line to put back at the top of the list, remembered when
   * this view was last left for Text or Media. Anchored by CELL, not by pixel
   * offset, because a cleanup run filling in earlier rows grows them.
   */
  initialTopCellId?: string | null
}

export interface TranscribeEditorHandle {
  /** AQU-2153: the cell of the line at the top of the list, for the workspace
   *  to remember as this view is torn down. Null when no row is measurable. */
  getTopVisibleCellId: () => string | null
}

export const TranscribeEditor = forwardRef<TranscribeEditorHandle, Props>(function TranscribeEditor(
  { project, cells, session, targetLang, concepts, editable, onCommitted, audioLoaded = true, initialTopCellId = null },
  ref,
) {
  const t = useT()
  const rows = useMemo(
    () => cells.map(transcriptRowOf).filter((r): r is TranscriptRow => r !== null),
    [cells],
  )
  const [statusById, setStatusById] = useState<Record<string, RowStatus>>({})
  const [batch, setBatch] = useState<{ done: number; total: number } | null>(null)
  const stopRef = useRef(false)
  // AQU-2153: the scroll container and the sticky toolbar that overlays its
  // top edge — the toolbar's bottom IS the top of the visible content, so it
  // is what both the measure and the restore below line rows up against.
  const listRef = useRef<HTMLDivElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)

  /** Where the visible content starts: below the sticky toolbar drawn over it. */
  const contentTop = useCallback((list: HTMLElement) => (
    toolbarRef.current?.getBoundingClientRect().bottom ?? list.getBoundingClientRect().top
  ), [])

  useImperativeHandle(ref, () => ({
    getTopVisibleCellId: () => {
      const list = listRef.current
      if (!list) return null
      const rowEls = Array.from(list.querySelectorAll<HTMLElement>("[data-cell-id]"))
      // -1 as the fallback so "nothing measurable" reads as null rather than
      // claiming the first line — remembering line 1 by accident would put
      // the view back at the top, which is the bug being fixed.
      const index = firstActuallyVisibleIndex(
        rowEls.map((row, i) => {
          const rect = row.getBoundingClientRect()
          return { index: i, top: rect.top, bottom: rect.bottom }
        }),
        contentTop(list),
        -1,
      )
      return index < 0 ? null : rowEls[index]?.dataset.cellId ?? null
    },
  }), [contentTop])

  // Restore the remembered line. The rows stream in with the file's takes, so
  // this keeps trying as they arrive — under the same attempt budget the
  // parked-cell machine uses, because a line deleted or re-imported since is
  // never going to turn up and must not be hunted on every later commit.
  const restoreAttemptsRef = useRef(0)
  const restoredCellIdRef = useRef<string | null>(null)
  useEffect(() => {
    const list = listRef.current
    if (!initialTopCellId || !list || restoredCellIdRef.current === initialTopCellId) return
    restoreAttemptsRef.current += 1
    const row = list.querySelector<HTMLElement>(`[data-cell-id="${CSS.escape(initialTopCellId)}"]`)
    if (row) {
      list.scrollTop += row.getBoundingClientRect().top - contentTop(list)
      restoredCellIdRef.current = initialTopCellId
    } else if (restoreAttemptsRef.current >= PENDING_CELL_SCROLL_MAX_ATTEMPTS) {
      // Give up on the top of the list rather than retrying forever.
      restoredCellIdRef.current = initialTopCellId
    }
    // `rows` is the retry trigger: the takes stream in, so the remembered line
    // is routinely absent for the first render or two after the switch.
  }, [contentTop, initialTopCellId, rows])

  const setStatus = useCallback((cellId: string, status: RowStatus) => {
    setStatusById((prev) => ({ ...prev, [cellId]: status }))
  }, [])

  const refresh = useCallback(async (row: TranscriptRow) => {
    await onCommitted?.(row.cell.id)
    notifyAudioAttachmentsChanged(row.cell.fileId)
  }, [onCommitted])

  const run = useCallback(async (row: TranscriptRow, forceAsr: boolean) => {
    if (!session) return
    setStatus(row.cell.id, { kind: "working" })
    const outcome = await transcribeAndCleanUp({
      row,
      rows,
      project,
      session,
      ...(targetLang ? { targetLang } : {}),
      concepts,
      learned: loadTranscriptCorrections(project.id),
      forceAsr,
    })
    setStatus(row.cell.id, outcome.kind === "cleaned" ? { kind: "idle" } : outcome)
    await refresh(row)
  }, [session, rows, project, targetLang, concepts, setStatus, refresh])

  const runOne = useCallback((row: TranscriptRow, forceAsr: boolean) => {
    // Human work wins: replacing a hand-corrected transcript asks first.
    if (isHumanCorrected(row, loadTranscriptCorrections(project.id)) && !window.confirm(t("transcribe.confirmReplace"))) return
    void run(row, forceAsr)
  }, [project.id, run, t])

  const runAll = useCallback(async () => {
    const learned = loadTranscriptCorrections(project.id)
    const todo = rows.filter((r) => !r.validated && !r.aiCleaned && !isHumanCorrected(r, learned))
    stopRef.current = false
    setBatch({ done: 0, total: todo.length })
    for (let i = 0; i < todo.length; i++) {
      if (stopRef.current) break
      await run(todo[i], false)
      setBatch({ done: i + 1, total: todo.length })
    }
    setBatch(null)
  }, [project.id, rows, run])

  const save = useCallback(async (row: TranscriptRow, text: string) => {
    const attachment = row.cell.attachments?.[row.audioId]
    const timings = row.cell.audioTimings?.[row.audioId] as WordTiming[] | undefined
    if (!attachment || !timings || timings.length === 0) return
    try {
      await saveTranscript({
        projectId: project.id,
        owner: row.cell,
        audioId: row.audioId,
        attachment,
        timings,
        text,
        ...(targetLang && !row.isSourceSegment ? { targetLang } : {}),
        author: session?.username ?? "local",
      })
      setStatus(row.cell.id, { kind: "idle" })
      await refresh(row)
    } catch (err) {
      console.warn("[transcribe] save failed:", err)
      setStatus(row.cell.id, { kind: "failed" })
    }
  }, [project.id, targetLang, session, setStatus, refresh])

  if (rows.length === 0) {
    // Nothing until the read answers: a file whose takes are still on their
    // way is not a file with no audio (AQU-2146).
    if (!audioLoaded) return null
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground" data-testid="transcribe-empty">{t("transcribe.empty")}</p>
  }

  const canRun = editable && session !== null
  return (
    <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="transcribe-editor">
      <div ref={toolbarRef} className="sticky top-0 z-10 flex items-center justify-end gap-2 border-b border-border bg-background px-4 py-2">
        {!session && <span className="text-xs text-muted-foreground">{t("transcribe.signIn")}</span>}
        {batch && (
          <>
            <span className="text-xs text-muted-foreground" data-testid="transcribe-progress">
              {t("transcribe.runAllProgress", { done: batch.done, total: batch.total })}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={() => { stopRef.current = true }}>
              <Square />
              {t("transcribe.stop")}
            </Button>
          </>
        )}
        {canRun && !batch && (
          <Button type="button" variant="outline" size="sm" onClick={() => void runAll()} data-testid="transcribe-run-all">
            <Sparkles />
            {t("transcribe.runAll")}
          </Button>
        )}
      </div>
      {rows.map((row, i) => (
        <TranscribeRow
          key={row.cell.id}
          project={project}
          row={row}
          label={row.cell.cellLabel ?? String(cells.indexOf(row.cell) + 1 || i + 1)}
          editable={editable}
          canRun={canRun && !batch}
          status={statusById[row.cell.id] ?? { kind: "idle" }}
          onRun={(forceAsr) => runOne(row, forceAsr)}
          onSave={(text) => void save(row, text)}
        />
      ))}
    </div>
  )
})
