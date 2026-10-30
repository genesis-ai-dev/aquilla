// The Transcribe lens (docs/superpowers/specs/2026-10-23-transcript-cleanup-design.md §2–3).
//
// Every line of the file that has a clip, one row each. "Transcribe all" runs
// speech recognition only, on every row with nothing transcribed yet, a few at
// a time. The AI cleanup stays a person's call: the sparkle on a row, or
// "Clean up selected" for the rows ticked (Shift-click ticks a range). It
// transcribes a row first when nothing ASR heard is saved yet, and is taught by
// the corrections already made in this file's rows of the same language.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { AudioLines, Sparkles, Square, X } from "lucide-react"
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
import { applyCorrections } from "@/lib/audio/transcript-corrections"
import { isHumanCorrected, transcriptRowOf, type TranscriptRow } from "@/lib/transcript-cleanup/rows"
import { rowLanguage, transcribeAndCleanUp, transcribeRow, type SparkleOutcome } from "@/lib/transcript-cleanup/run"
import { clearTranscript, saveTranscript } from "@/lib/transcript-cleanup/save"
import { TranscribeRow, type RowStatus } from "./TranscribeRow"
import { SpeechModelBanner } from "./SpeechModelStatus"
import { routesToCtc, useSpeechModelWarmup } from "./useSpeechModelWarmup"

/** Rows sent at once. Omnilingual CTC runs up to 4 containers; the per-user
 *  limit (60 requests a window) is waited out, not failed. */
const CONCURRENCY = 3

/** Run `work` over `items`, `size` at a time, until done or `stopped()`. */
async function runPool<T>(items: readonly T[], size: number, stopped: () => boolean, work: (item: T) => Promise<void>) {
  let next = 0
  const worker = async () => {
    while (!stopped() && next < items.length) await work(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))
}

class StoppedError extends Error {
  constructor() {
    super("Stopped")
    this.name = "StoppedError"
  }
}

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
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  /** The last row ticked, where a Shift-click range starts. */
  const anchorRef = useRef<string | null>(null)
  const needsCtc = useMemo(
    () => rows.some((row) => routesToCtc(session?.username, rowLanguage(project, row, targetLang))),
    [rows, session?.username, project, targetLang],
  )
  const modelState = useSpeechModelWarmup(editable ? session : null, project.id, needsCtc)
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

  const finish = useCallback(async (row: TranscriptRow, outcome: SparkleOutcome) => {
    setStatus(row.cell.id, outcome.kind === "cleaned" || outcome.kind === "transcribed" ? { kind: "idle" } : outcome)
    await refresh(row)
  }, [setStatus, refresh])

  const cleanUp = useCallback(async (row: TranscriptRow, forceAsr: boolean) => {
    if (!session) return
    setStatus(row.cell.id, { kind: "working" })
    await finish(row, await transcribeAndCleanUp({
      row,
      rows,
      project,
      session,
      ...(targetLang ? { targetLang } : {}),
      concepts,
      learned: loadTranscriptCorrections(project.id),
      forceAsr,
    }))
  }, [session, rows, project, targetLang, concepts, setStatus, finish])

  const runOne = useCallback((row: TranscriptRow, forceAsr: boolean) => {
    // Human work wins: replacing a hand-corrected transcript asks first.
    if (isHumanCorrected(row, loadTranscriptCorrections(project.id)) && !window.confirm(t("transcribe.confirmReplace"))) return
    void cleanUp(row, forceAsr)
  }, [project.id, cleanUp, t])

  /** Wait out the per-user limit; Stop ends the wait. */
  const waitOutLimit = useCallback(async (seconds: number) => {
    const until = Date.now() + seconds * 1000
    while (Date.now() < until) {
      if (stopRef.current) throw new StoppedError()
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }, [])

  const runBatch = useCallback(async (todo: readonly TranscriptRow[], work: (row: TranscriptRow) => Promise<void>) => {
    stopRef.current = false
    setBatch({ done: 0, total: todo.length })
    await runPool(todo, CONCURRENCY, () => stopRef.current, async (row) => {
      await work(row)
      setBatch((b) => b && { ...b, done: b.done + 1 })
    })
    setBatch(null)
  }, [])

  // ASR only, on rows with nothing transcribed yet.
  const runAll = useCallback(async () => {
    if (!session) return
    const todo = rows.filter((r) => !r.validated && !r.heard && !r.transcript)
    await runBatch(todo, async (row) => {
      setStatus(row.cell.id, { kind: "working" })
      await finish(row, await transcribeRow({
        row, project, session, ...(targetLang ? { targetLang } : {}), onRateLimited: waitOutLimit,
      }))
    })
  }, [session, rows, project, targetLang, runBatch, setStatus, finish, waitOutLimit])

  const cleanUpSelected = useCallback(async () => {
    const learned = loadTranscriptCorrections(project.id)
    const todo = rows.filter((r) => selected.has(r.cell.id) && !r.validated)
    const corrected = todo.filter((r) => isHumanCorrected(r, learned)).length
    if (corrected > 0 && !window.confirm(t("transcribe.confirmReplaceSelected", { count: corrected }))) return
    await runBatch(todo, (row) => cleanUp(row, false))
    setSelected(new Set())
  }, [project.id, rows, selected, runBatch, cleanUp, t])

  const toggleSelect = useCallback((row: TranscriptRow, range: boolean) => {
    const anchor = range ? rows.findIndex((r) => r.cell.id === anchorRef.current) : -1
    const at = rows.indexOf(row)
    setSelected((prev) => {
      const next = new Set(prev)
      if (anchor >= 0) {
        // A range takes the state the clicked row is about to get.
        const on = !prev.has(row.cell.id)
        for (const r of rows.slice(Math.min(anchor, at), Math.max(anchor, at) + 1)) {
          if (on) next.add(r.cell.id)
          else next.delete(r.cell.id)
        }
      } else if (next.has(row.cell.id)) next.delete(row.cell.id)
      else next.add(row.cell.id)
      return next
    })
    anchorRef.current = row.cell.id
  }, [rows])

  const revert = useCallback(async (row: TranscriptRow) => {
    if (!row.heard) return
    // What transcription stores: ASR's words with the learned fixes applied.
    const text = applyCorrections(row.heard, loadTranscriptCorrections(project.id))
    const attachment = row.cell.attachments?.[row.audioId]
    const timings = row.cell.audioTimings?.[row.audioId] as WordTiming[] | undefined
    if (!attachment || !timings || timings.length === 0) return
    if (text === row.transcript && !row.aiCleaned) return
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
        learn: false,
      })
      setStatus(row.cell.id, { kind: "idle" })
      await refresh(row)
    } catch (err) {
      setStatus(row.cell.id, { kind: "failed", step: "save", detail: err instanceof Error ? err.message : String(err) })
    }
  }, [project.id, targetLang, session, setStatus, refresh])

  const clear = useCallback(async (row: TranscriptRow) => {
    const attachment = row.cell.attachments?.[row.audioId]
    if (!attachment || !window.confirm(t("transcribe.confirmClear"))) return
    try {
      await clearTranscript({
        projectId: project.id,
        owner: row.cell,
        audioId: row.audioId,
        attachment,
        ...(targetLang && !row.isSourceSegment ? { targetLang } : {}),
        author: session?.username ?? "local",
      })
      setStatus(row.cell.id, { kind: "idle" })
      await refresh(row)
    } catch (err) {
      setStatus(row.cell.id, { kind: "failed", step: "save", detail: err instanceof Error ? err.message : String(err) })
    }
  }, [project.id, targetLang, session, setStatus, refresh, t])

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
      setStatus(row.cell.id, { kind: "failed", step: "save", detail: err instanceof Error ? err.message : String(err) })
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
        <SpeechModelBanner state={modelState} />
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
        {canRun && !batch && selected.size > 0 && (
          <>
            <Button type="button" variant="ghost" size="sm" onClick={() => setSelected(new Set())} data-testid="transcribe-select-none">
              <X />
              {t("transcribe.selectNone")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void cleanUpSelected()} data-testid="transcribe-clean-selected">
              <Sparkles />
              {t("transcribe.cleanSelected", { count: selected.size })}
            </Button>
          </>
        )}
        {canRun && !batch && (
          <Button type="button" variant="outline" size="sm" onClick={() => void runAll()} data-testid="transcribe-run-all">
            <AudioLines />
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
          selected={selected.has(row.cell.id)}
          onToggleSelect={(range) => toggleSelect(row, range)}
          onRun={(forceAsr) => runOne(row, forceAsr)}
          onSave={(text) => void save(row, text)}
          onRevert={() => void revert(row)}
          onClear={() => void clear(row)}
        />
      ))}
    </div>
  )
})
