// The Transcribe lens (docs/superpowers/specs/2026-10-23-transcript-cleanup-design.md §2–3).
//
// Every line of the file that has a clip, one row each. "Transcribe all" runs
// speech recognition only, on every row with nothing transcribed yet, a few at
// a time. The AI cleanup stays a person's call: the sparkle on a row, or
// "Clean up selected" for the rows ticked (Shift-click ticks a range). It
// transcribes a row first when nothing ASR heard is saved yet, and is taught by
// the corrections already made in this file's rows of the same language.
//
// The toolbar picks the speech model, Fast or Smart (transcribe-speed.ts), and
// the view wakes that model as it opens. On Fast it also starts the
// speech-recognition pass by itself. A row shows each step as it happens: see
// TranscribeRow.tsx.
//
// What keeps the list responsive (AQU-2654, docs/decisions/0013):
//   - What a row is doing lives in the row store (row-live-store.ts), not in
//     this component's state: a step, or a token of a streaming cleanup,
//     renders the one row it belongs to and never the list.
//   - Rows keep their identity while their line says the same
//     (`stableTranscriptRows`), and the handlers a row is given never change,
//     so a memoized row renders only for its own line.
//   - A write does not wait to be flushed and read back. The new text is on
//     the row as the write is queued; the write itself tells the file's audio
//     read what changed on that take (transcript-cleanup/save.ts,
//     audio/transcribe.ts), the app's outbox flusher delivers it, and a pass
//     over many rows moves to its next row at once. A save the flusher gives
//     up on is reported on its row (save-watch.ts).

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react"
import { AudioLines, Sparkles, Square, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { CellData } from "@/hooks/useCells"
import { useT } from "@/lib/i18n/I18nProvider"
import type { FrontierSession } from "@/lib/frontier/types"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"
import type { WordTiming } from "@/lib/codex-editor/types"
import { firstActuallyVisibleIndex } from "@/lib/chapter-navigation"
import { PENDING_CELL_SCROLL_MAX_ATTEMPTS } from "@/components/pending-cell-scroll"
import { loadTranscriptCorrections } from "@/lib/store/transcript-corrections-store"
import { applyCorrections } from "@/lib/audio/transcript-corrections"
import { isHumanCorrected, NO_TRANSCRIPT_ROWS, stableTranscriptRows, type TranscriptRow } from "@/lib/transcript-cleanup/rows"
import {
  rowLanguage, transcribeAndCleanUp, transcribeRow, type RowProgress, type SparkleOutcome,
} from "@/lib/transcript-cleanup/run"
import { clearTranscript, saveTranscript } from "@/lib/transcript-cleanup/save"
import { usesHostedTranscription } from "@/lib/audio/transcription-preference"
import type { OmniModelName } from "@/lib/audio/omni-warmup"
import { TranscribeRow } from "./TranscribeRow"
import { createRowLiveStore, useBatchProgress, type RowLive, type RowLiveStore, type RowStatus } from "./row-live-store"
import { watchTranscriptWrites } from "./save-watch"
import { SpeechModelBanner } from "./SpeechModelStatus"
import { useSpeechModelWarmup } from "./useSpeechModelWarmup"
import {
  modelToWake, setTranscribeSpeed, speechChoice, TRANSCRIBE_SPEEDS, useTranscribeSpeed, type TranscribeSpeed,
} from "./transcribe-speed"

/** Rows sent at once. Omnilingual CTC runs up to 4 containers; the per-user
 *  limit (60 requests a window) is waited out, not failed. */
const CONCURRENCY = 3

/** How long a finished run's text stays on a row that has not shown it from
 *  its own data yet. The row normally catches up at once (the write hands the
 *  take's new words to the file's audio read); this only bounds a row that
 *  never does, so it cannot hide a later change for good. */
const LIVE_TEXT_MAX_MS = 10_000

/** Run `work` once the browser has nothing more urgent (the view's first
 *  paint, a click already waiting), or within a second. Returns a cancel. */
function whenIdle(work: () => void): () => void {
  if (typeof requestIdleCallback === "function") {
    const id = requestIdleCallback(work, { timeout: 1000 })
    return () => cancelIdleCallback(id)
  }
  const id = setTimeout(work, 0)
  return () => clearTimeout(id)
}

/** "3 of 30" while a pass runs. Its own component, so a row finishing renders
 *  these few words and not the list. */
function BatchProgressText({ store }: { store: RowLiveStore }) {
  const t = useT()
  const batch = useBatchProgress(store)
  if (!batch) return null
  return (
    <span className="text-xs text-muted-foreground" data-testid="transcribe-progress">
      {t("transcribe.runAllProgress", { done: batch.done, total: batch.total })}
    </span>
  )
}

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
  /** Flush the outbox and refetch the cell (the editor's onCellCommitted).
   *  Only called for a source segment, whose transcript is also its line's
   *  text, and never awaited: a take's words change nothing on its cell. */
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

export const TranscribeEditor = memo(forwardRef<TranscribeEditorHandle, Props>(function TranscribeEditor(
  { project, cells, session, targetLang, concepts, editable, onCommitted, audioLoaded = true, initialTopCellId = null },
  ref,
) {
  const t = useT()
  // `cells` is a new array of new objects on every change to any cell of the
  // file. The rows made from it keep their identity where the line did not
  // change (adjusted during render, from the rows of the render before).
  const [listed, setListed] = useState(() => ({ cells, list: stableTranscriptRows(cells, NO_TRANSCRIPT_ROWS) }))
  const list = listed.cells === cells ? listed.list : stableTranscriptRows(cells, listed.list)
  if (listed.cells !== cells) setListed({ cells, list })
  const rows = list.rows
  // What each row is doing, and the pass's progress: outside React state, so
  // a row's step renders that row alone.
  const [store] = useState(createRowLiveStore)
  useEffect(() => () => store.dispose(), [store])
  /** A pass is running. Its progress count is the store's. */
  const [running, setRunning] = useState(false)
  const stopRef = useRef(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  /** The last row ticked, where a Shift-click range starts. */
  const anchorRef = useRef<string | null>(null)
  const speed = useTranscribeSpeed(session?.username)
  const hosted = usesHostedTranscription(session, project.id)
  const choiceFor = useCallback(
    (row: TranscriptRow) => speechChoice(speed, session?.username, rowLanguage(project, row, targetLang)),
    [speed, session?.username, project, targetLang],
  )
  // The model most of this file's rows will run on is the one to wake.
  const wakeModel = useMemo(() => {
    const votes = new Map<OmniModelName, number>()
    for (const row of rows) {
      const model = modelToWake(choiceFor(row), rowLanguage(project, row, targetLang))
      if (model) votes.set(model, (votes.get(model) ?? 0) + 1)
    }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
  }, [rows, choiceFor, project, targetLang])
  const modelState = useSpeechModelWarmup(editable ? session : null, project.id, wakeModel)
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
    store.setStatus(cellId, status)
  }, [store])

  const setLive = useCallback((cellId: string, live: RowLive | null) => {
    store.setLive(cellId, live)
  }, [store])

  /** Keep what a row shows ahead of its data for LIVE_TEXT_MAX_MS at most,
   *  counted from the row's LATEST action: an earlier action's deadline must
   *  not take a newer one's text off the row. */
  const liveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const boundLive = useCallback((cellId: string) => {
    const timers = liveTimers.current
    clearTimeout(timers.get(cellId))
    timers.set(cellId, setTimeout(() => {
      timers.delete(cellId)
      store.setLive(cellId, null)
    }, LIVE_TEXT_MAX_MS))
  }, [store])
  useEffect(() => {
    const timers = liveTimers.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // A save the outbox flusher has given up on: the row says so, and shows the
  // words the server still has.
  const watch = useMemo(() => watchTranscriptWrites({
    projectId: project.id,
    onFailed: (cellId, detail) => {
      store.setLive(cellId, null)
      store.setStatus(cellId, { kind: "failed", step: "save", ...(detail ? { detail } : {}) })
    },
  }), [project.id, store])
  useEffect(() => () => watch.stop(), [watch])

  const onCommittedRef = useRef(onCommitted)
  useEffect(() => {
    onCommittedRef.current = onCommitted
  }, [onCommitted])

  /**
   * A row's words were queued (`since`: when the action that queued them
   * began). Nothing here is awaited — the row already shows the result, and
   * the app's outbox flusher is woken by the enqueue itself.
   *
   * A source segment's transcript is also its line's text, so that one cell is
   * flushed and read back, in the background. A take's words change nothing on
   * its cell: it used to cost three cell reads, a stats read and two reads of
   * the whole file's audio, all awaited before the next row could start.
   */
  const written = useCallback((row: TranscriptRow, since: number) => {
    watch.note(row.cell.fileId, row.cell.id, since)
    if (!row.isSourceSegment) return
    void (async () => {
      try {
        await onCommittedRef.current?.(row.cell.id)
      } catch (err) {
        store.setStatus(row.cell.id, { kind: "failed", step: "save", detail: err instanceof Error ? err.message : String(err) })
      }
    })()
  }, [watch, store])

  /** A step of a running row: show it, and keep what it produced on the row
   *  until the row's own data has it. */
  const onProgress = useCallback((row: TranscriptRow, progress: RowProgress) => {
    setStatus(row.cell.id, { kind: "working", progress })
    if (progress.stage === "heard") setLive(row.cell.id, { heard: progress.heard, transcript: progress.transcript })
  }, [setStatus, setLive])

  const finish = useCallback((row: TranscriptRow, outcome: SparkleOutcome, since: number) => {
    if (outcome.kind === "cleaned") setLive(row.cell.id, { transcript: outcome.text, aiCleaned: true })
    setStatus(row.cell.id, outcome.kind === "cleaned" || outcome.kind === "transcribed" ? { kind: "idle" } : outcome)
    written(row, since)
    boundLive(row.cell.id)
  }, [setStatus, setLive, written, boundLive])

  const cleanUp = useCallback(async (row: TranscriptRow, forceAsr: boolean) => {
    if (!session) return
    const since = Date.now()
    setLive(row.cell.id, null)
    finish(row, await transcribeAndCleanUp({
      row,
      rows,
      cells,
      project,
      session,
      ...(targetLang ? { targetLang } : {}),
      concepts,
      learned: loadTranscriptCorrections(project.id),
      forceAsr,
      onProgress: (progress) => onProgress(row, progress),
      ...(hosted ? { speech: choiceFor(row) } : {}),
    }), since)
  }, [session, rows, cells, project, targetLang, concepts, hosted, choiceFor, setLive, onProgress, finish])

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
    setRunning(true)
    store.setBatch({ done: 0, total: todo.length })
    await runPool(todo, CONCURRENCY, () => stopRef.current, async (row) => {
      await work(row)
      store.setBatch((b) => b && { ...b, done: b.done + 1 })
    })
    store.setBatch(null)
    setRunning(false)
  }, [store])

  // ASR only, on rows with nothing transcribed yet.
  const runAll = useCallback(async () => {
    if (!session) return
    const todo = rows.filter((r) => !r.validated && !r.heard && !r.transcript)
    await runBatch(todo, async (row) => {
      const since = Date.now()
      setLive(row.cell.id, null)
      // The worker moves to its next row as soon as this one has answered:
      // nothing below waits on a flush or a read.
      finish(row, await transcribeRow({
        row, project, session, ...(targetLang ? { targetLang } : {}), onRateLimited: waitOutLimit,
        onProgress: (progress) => onProgress(row, progress),
        ...(hosted ? { speech: choiceFor(row) } : {}),
      }), since)
    })
  }, [session, rows, project, targetLang, hosted, choiceFor, runBatch, setLive, onProgress, finish, waitOutLimit])

  // Opening the view starts the first pass by itself (Ryder, 2026-11-18): the
  // fast model costs little and its text is only a draft, so there is no
  // reason to make a person ask for it. The cleanup stays theirs to start,
  // because it learns from the lines they have corrected by then.
  //
  // Only the Fast choice does this. Smart can mean zero-shot, the expensive
  // model, and on-device transcription would open a download prompt; those
  // wait for "Transcribe all". Once per file per visit, so pressing Stop is
  // not undone by the next row that arrives.
  //
  // It starts once the browser is idle, not in the commit that mounts the
  // list: the rows are painted, and a click already made is handled, before
  // thirty clips start being fetched and decoded.
  const autoRanFor = useRef<string | null>(null)
  const fileId = rows[0]?.cell.fileId ?? null
  const autoRun = editable && session !== null && hosted && speed === "fast" && audioLoaded
    && fileId !== null && !running
    && rows.some((r) => !r.validated && !r.heard && !r.transcript)
  const runAllRef = useRef(runAll)
  useEffect(() => {
    runAllRef.current = runAll
  }, [runAll])
  useEffect(() => {
    if (!autoRun || autoRanFor.current === fileId) return
    return whenIdle(() => {
      if (autoRanFor.current === fileId) return
      autoRanFor.current = fileId
      void runAllRef.current()
    })
  }, [autoRun, fileId])

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
    const since = Date.now()
    // On the row now; the save is queued behind it.
    setLive(row.cell.id, { transcript: text, aiCleaned: false })
    try {
      const saved = await saveTranscript({
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
      if (!saved) {
        // Nothing to save onto: the row keeps what it had.
        setLive(row.cell.id, null)
        return
      }
      written(row, since)
      boundLive(row.cell.id)
    } catch (err) {
      // Not saved: show what is stored again.
      setLive(row.cell.id, null)
      setStatus(row.cell.id, { kind: "failed", step: "save", detail: err instanceof Error ? err.message : String(err) })
    }
  }, [project.id, targetLang, session, setStatus, setLive, written, boundLive])

  const clear = useCallback(async (row: TranscriptRow) => {
    const attachment = row.cell.attachments?.[row.audioId]
    if (!attachment || !window.confirm(t("transcribe.confirmClear"))) return
    // Empty at once, and kept empty until the read-back shows it: the row used
    // to wait on that read, and kept its words until a page refresh when the
    // read came back before the clear (reported 2026-11-18).
    const since = Date.now()
    setLive(row.cell.id, { heard: null, transcript: "", aiCleaned: false })
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
      written(row, since)
      boundLive(row.cell.id)
    } catch (err) {
      // Not saved: the words are still there, so show them again.
      setLive(row.cell.id, null)
      setStatus(row.cell.id, { kind: "failed", step: "save", detail: err instanceof Error ? err.message : String(err) })
    }
  }, [project.id, targetLang, session, setStatus, setLive, written, boundLive, t])

  const save = useCallback(async (row: TranscriptRow, text: string) => {
    const attachment = row.cell.attachments?.[row.audioId]
    const timings = row.cell.audioTimings?.[row.audioId] as WordTiming[] | undefined
    if (!attachment || !timings || timings.length === 0) return
    const since = Date.now()
    // On the row now, as a person's own text (no AI mark); the save is queued
    // behind it.
    setLive(row.cell.id, { transcript: text, aiCleaned: false })
    try {
      const saved = await saveTranscript({
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
      if (!saved) {
        // Nothing to save onto: the row keeps what it had.
        setLive(row.cell.id, null)
        return
      }
      written(row, since)
      boundLive(row.cell.id)
    } catch (err) {
      // Not saved: show what is stored again.
      setLive(row.cell.id, null)
      setStatus(row.cell.id, { kind: "failed", step: "save", detail: err instanceof Error ? err.message : String(err) })
    }
  }, [project.id, targetLang, session, setStatus, setLive, written, boundLive])

  // The handlers every row is given. They never change identity (a memoized
  // row would otherwise render for every render of the list); each looks its
  // line up by cell id and runs the newest version of the action above.
  const actions = { rows, toggleSelect, runOne, save, revert, clear }
  const actionsRef = useRef(actions)
  useEffect(() => {
    actionsRef.current = actions
  })
  const withRow = useCallback((cellId: string, act: (now: typeof actions, row: TranscriptRow) => void) => {
    const now = actionsRef.current
    const row = now.rows.find((r) => r.cell.id === cellId)
    if (row) act(now, row)
  }, [])
  const onRowToggle = useCallback((cellId: string, range: boolean) => withRow(cellId, (now, row) => now.toggleSelect(row, range)), [withRow])
  const onRowRun = useCallback((cellId: string, forceAsr: boolean) => withRow(cellId, (now, row) => now.runOne(row, forceAsr)), [withRow])
  const onRowSave = useCallback((cellId: string, text: string) => withRow(cellId, (now, row) => void now.save(row, text)), [withRow])
  const onRowRevert = useCallback((cellId: string) => withRow(cellId, (now, row) => void now.revert(row)), [withRow])
  const onRowClear = useCallback((cellId: string) => withRow(cellId, (now, row) => void now.clear(row)), [withRow])

  if (rows.length === 0) {
    // Nothing until the read answers: a file whose takes are still on their
    // way is not a file with no audio (AQU-2146).
    if (!audioLoaded) return null
    return <p className="px-4 py-10 text-center text-sm text-muted-foreground" data-testid="transcribe-empty">{t("transcribe.empty")}</p>
  }

  const canRun = editable && session !== null
  const speedItems = TRANSCRIBE_SPEEDS.map((value) => ({ value, label: t(`transcribe.speed.${value}`) }))
  return (
    <div ref={listRef} className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-testid="transcribe-editor">
      <div ref={toolbarRef} className="sticky top-0 z-10 flex flex-wrap items-center justify-end gap-2 border-b border-border bg-background px-4 py-2">
        <div className="mr-auto flex min-w-0 items-center gap-3">
          {/* The choice only exists for hosted transcription: on-device
              transcription has the one model the device downloaded. */}
          {canRun && hosted && (
            <Select
              items={speedItems}
              value={speed}
              onValueChange={(value) => setTranscribeSpeed(session?.username, value === "smart" ? "smart" : "fast")}
              disabled={running}
            >
              <SelectTrigger size="sm" aria-label={t("transcribe.speed.label")} data-testid="transcribe-speed">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {TRANSCRIBE_SPEEDS.map((value: TranscribeSpeed) => (
                    <SelectItem key={value} value={value} multiline data-testid={`transcribe-speed-${value}`}>
                      <span className="flex flex-col">
                        <span>{t(`transcribe.speed.${value}`)}</span>
                        <span className="max-w-64 text-xs text-muted-foreground">{t(`transcribe.speed.${value}Hint`)}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          )}
          <SpeechModelBanner state={modelState} />
        </div>
        {!session && <span className="text-xs text-muted-foreground">{t("transcribe.signIn")}</span>}
        {running && (
          <>
            <BatchProgressText store={store} />
            <Button type="button" variant="outline" size="sm" onClick={() => { stopRef.current = true }}>
              <Square />
              {t("transcribe.stop")}
            </Button>
          </>
        )}
        {canRun && !running && selected.size > 0 && (
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
        {canRun && !running && (
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
          label={list.labels.get(row.cell.id) ?? String(i + 1)}
          editable={editable}
          // During a transcription pass a row that already has its text can
          // still be cleaned up: the pass only touches rows with none.
          canRun={canRun && (!running || Boolean(row.heard || row.transcript))}
          store={store}
          modelWaking={modelState.kind === "starting"}
          selected={selected.has(row.cell.id)}
          onToggleSelect={onRowToggle}
          onRun={onRowRun}
          onSave={onRowSave}
          onRevert={onRowRevert}
          onClear={onRowClear}
        />
      ))}
    </div>
  )
}))
