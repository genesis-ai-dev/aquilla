/**
 * AQU-981: bulk audio upload, inside the Import dialog.
 *
 * `RecordingsPicker` is the drop zone (Import → Recordings, or a file's ⋯ menu
 * → Upload recordings…). `RecordingsReview` reads every name, loads the lines
 * the names point at, and shows the preview the ticket asks for: every file and
 * the line it will land on, how it was matched, parts and ranges, the files that
 * won't be uploaded and why, the rule behind an (i), a way to change a file's
 * line, to move an order-based run up or down, cancel, or confirm. Confirm
 * hands the jobs to the upload engine, whose banner takes over; the dialog
 * closes.
 *
 * Built from the Upload files screens (the drop zone, PreviewPanel's bordered
 * list) — no new visual vocabulary, and no pills.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, ArrowUp, Info } from "lucide-react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox"
import { cn } from "@/lib/utils"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"
import { formatNumber } from "@/lib/i18n/format"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { BookNameIndex, englishBookName } from "@/lib/audio/bulk-upload/book-names"
import {
  canChooseLine,
  lonePart,
  matchRecordings,
  planJobs,
  readRecordings,
  takesByNumber,
  targetsWanted,
  type Assignment,
  type MatchScope,
  type ReadRecording,
  type TargetFile,
  type TargetLine,
  type UnmatchedReason,
  type UploadJob,
} from "@/lib/audio/bulk-upload/match"
import { chosenFromDrop, chosenFromInput, type ChosenFile } from "@/lib/audio/bulk-upload/collect-files"
import { learnHeaderNames, loadTargetFile, projectFileInfos, type ProjectFileLike } from "@/lib/audio/bulk-upload/load-targets"
import { BULK_MAX_FILE_BYTES, isBulkUploadRunning, startBulkUpload } from "@/lib/audio/bulk-upload/engine"
import { takesSentence, type LineTakes } from "@/lib/audio/bulk-upload/takes-summary"

// ── The rule, behind an (i) ──────────────────────────────────────────────────

const RULE_KEYS: MessageKey[] = [
  "recordingsUpload.rules.byName",
  "recordingsUpload.rules.byNumber",
  "recordingsUpload.rules.range",
  "recordingsUpload.rules.parts",
  "recordingsUpload.rules.order",
  "recordingsUpload.rules.existing",
  "recordingsUpload.rules.unmatched",
]

export function RecordingsRulesInfo() {
  const t = useT()
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t("recordingsUpload.rules.label")}
            data-testid="recordings-rules-info"
            className="inline-flex shrink-0 align-middle text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="w-96 max-w-[calc(100vw-2rem)] gap-2 text-xs" side="bottom" align="start">
        <PopoverTitle className="text-sm">{t("recordingsUpload.rules.label")}</PopoverTitle>
        <ul className="flex list-disc flex-col gap-1.5 ps-4 text-muted-foreground" data-testid="recordings-rules">
          {RULE_KEYS.map((key) => <li key={key}>{t(key)}</li>)}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

// ── Picking the files ────────────────────────────────────────────────────────

export interface RecordingsPickerProps {
  /** Set when the upload goes into one file (its ⋯ menu). */
  fileName: string | null
  languageLabel: string | null
  onFiles: (files: ChosenFile[]) => void
}

export function RecordingsPicker({ fileName, languageLabel, onFiles }: RecordingsPickerProps) {
  const t = useT()
  const [dragOver, setDragOver] = useState(false)
  const take = (list: ChosenFile[]) => { if (list.length > 0) onFiles(list) }
  return (
    <div className="space-y-3 py-1" data-testid="recordings-picker">
      <p className="text-sm text-muted-foreground">
        {fileName ? t("recordingsUpload.pick.introFile", { fileName }) : t("recordingsUpload.pick.intro")}{" "}
        <RecordingsRulesInfo />
      </p>
      <div
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 transition-colors",
          dragOver ? "border-primary bg-primary/5" : "border-muted",
        )}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          void chosenFromDrop(e.dataTransfer).then(take)
        }}
      >
        <p className="mb-2 text-sm text-muted-foreground">{t("recordingsUpload.pick.dragDrop")}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" nativeButton={false} render={<label />}>
            {t("importExport.upload.chooseFiles")}
            <input
              type="file"
              multiple
              accept="audio/*,.wav,.mp3,.m4a,.ogg,.oga,.opus,.flac,.aac,.webm,.wma,.aif,.aiff,.amr,.caf"
              className="hidden"
              data-testid="recordings-input-files"
              onChange={(e) => { const list = e.target.files ? chosenFromInput(e.target.files) : []; e.target.value = ""; take(list) }}
            />
          </Button>
          <Button variant="outline" nativeButton={false} render={<label />}>
            {t("importExport.upload.chooseFolder")}
            <input
              type="file"
              className="hidden"
              data-testid="recordings-input-folder"
              // @ts-expect-error — webkitdirectory is a non-standard but widely supported attr
              webkitdirectory=""
              directory=""
              onChange={(e) => { const list = e.target.files ? chosenFromInput(e.target.files) : []; e.target.value = ""; take(list) }}
            />
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("recordingsUpload.pick.formats")}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        {languageLabel ? t("recordingsUpload.pick.language", { language: languageLabel }) : t("recordingsUpload.pick.languageDefault")}{" "}
        {t("recordingsUpload.pick.safe")}
      </p>
    </div>
  )
}

// ── Reviewing where each goes ────────────────────────────────────────────────

export interface RecordingsReviewProps {
  projectId: string
  /** Set when the upload goes into one file (its ⋯ menu). */
  file: { id: string; name: string } | null
  projectFiles: readonly ProjectFileLike[]
  getToken: (fileId: string) => Promise<string | null>
  /** The lane the person is on; '' for the default lane. */
  lane: string
  languageLabel: string | null
  username: string
  chosen: ChosenFile[]
  onStarted: () => void
  onCancel: () => void
}

type Phase =
  | { kind: "reading" }
  | { kind: "loading"; name: string }
  | { kind: "failed"; name: string }
  | { kind: "ready"; read: ReadRecording[]; targets: Map<string, TargetFile> }

const LOAD_CONCURRENCY = 3

async function inBatches<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++])
  }))
}

/** "Genesis 1:3", or "Welcome letter · 12" for a document's line. */
function lineLabel(file: TargetFile, line: TargetLine, position: number): string {
  const m = line.ref ? /^([1-3]?[A-Z]{2,3})\s+(\d+:\S+)$/.exec(line.ref) : null
  if (m) return `${file.bookCode ? englishBookName(file.bookCode) : file.name} ${m[2]}`
  return `${file.name} · ${position + 1}`
}

function reasonText(t: ReturnType<typeof useT>, reason: UnmatchedReason, fmt: (n: number) => string): string {
  switch (reason.code) {
    case "notAudio": return t("recordingsUpload.reason.notAudio")
    case "systemFile": return t("recordingsUpload.reason.systemFile")
    case "empty": return t("recordingsUpload.reason.empty")
    case "tooLarge": return t("recordingsUpload.reason.tooLarge", { mb: reason.mb, limit: reason.limitMb })
    case "noBook": return t("recordingsUpload.reason.noBook")
    case "bookNotInProject": return t("recordingsUpload.reason.bookNotInProject", { book: reason.book })
    case "otherBook": return t("recordingsUpload.reason.otherBook", { book: reason.book, fileName: reason.fileName })
    case "noSuchChapter": return t("recordingsUpload.reason.noSuchChapter", { book: reason.book, chapter: reason.chapter })
    case "noSuchVerse": return t("recordingsUpload.reason.noSuchVerse", { ref: reason.ref })
    case "noVerseChapter": return t("recordingsUpload.reason.noVerseChapter", { verse: reason.verse })
    case "noSuchLine": return t("recordingsUpload.reason.noSuchLine", { line: reason.line, count: reason.count })
    case "noNumber": return t("recordingsUpload.reason.noNumber")
    case "tooManyNumbers": return t("recordingsUpload.reason.tooManyNumbers")
    case "pastLastLine": return t("recordingsUpload.reason.pastLastLine", { count: reason.count })
    case "beforeFirstLine": return t("recordingsUpload.reason.beforeFirstLine")
    case "duplicate": return t("recordingsUpload.reason.duplicate", { other: reason.other, target: reason.target })
    case "rangeOnTimedFile": return t("recordingsUpload.reason.rangeOnTimedFile")
    case "chapterOrVerse":
      return t("recordingsUpload.reason.chapterOrVerse", { count: fmt(reason.count), book: reason.book, chapters: fmt(reason.chapters), verses: fmt(reason.verses) })
    case "skipped": return t("recordingsUpload.reason.skipped")
  }
}

const METHOD_KEY = {
  name: "recordingsUpload.preview.byName",
  number: "recordingsUpload.preview.byNumber",
  order: "recordingsUpload.preview.byOrder",
} as const satisfies Record<string, MessageKey>

export function RecordingsReview({
  projectId, file, projectFiles, getToken, lane, languageLabel, username, chosen, onStarted, onCancel,
}: RecordingsReviewProps) {
  const t = useT()
  const { locale } = useI18n()
  const { session } = useFrontierSession()
  const [phase, setPhase] = useState<Phase>({ kind: "reading" })
  const [attempt, setAttempt] = useState(0)
  const [overrides, setOverrides] = useState<ReadonlyMap<number, { fileId: string; cellId: string } | "skip">>(() => new Map())
  const [orderShift, setOrderShift] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [orderStart, setOrderStart] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [editing, setEditing] = useState<number | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputs = useMemo(
    () => chosen.map(({ file: f, path }) => ({ name: f.name, path, size: f.size, type: f.type, lastModified: f.lastModified })),
    [chosen],
  )

  // Read every name, learn the project's own book names where a name has a
  // book word nothing knows, then load the lines of every file named.
  useEffect(() => {
    let live = true
    void (async () => {
      setPhase({ kind: "reading" })
      const index = new BookNameIndex()
      const infos = projectFileInfos(projectFiles, index)
      const scope: MatchScope = file ? { kind: "file", fileId: file.id } : { kind: "project" }
      const opts = { scope, index, projectFiles: infos, maxBytes: BULK_MAX_FILE_BYTES }
      let read = readRecordings(inputs, opts)
      try {
        const scoped = file ? infos.filter((f) => f.fileId === file.id) : infos.filter((f) => f.bookCode)
        const wantsNames = file != null || read.some((r) => r.reading.unknownBookWord || r.targetReason?.code === "noBook")
        if (wantsNames && scoped.some((f) => f.bookCode)) {
          await inBatches(scoped, LOAD_CONCURRENCY, async (f) => {
            const jwt = await getToken(f.fileId)
            if (jwt) await learnHeaderNames(projectId, f, jwt, lane, index).catch(() => {})
          })
          read = readRecordings(inputs, opts)
        }
        const targets = new Map<string, TargetFile>()
        const wanted = targetsWanted(read).map((id) => infos.find((f) => f.fileId === id)!).filter(Boolean)
        for (const f of wanted) {
          if (!live) return
          setPhase({ kind: "loading", name: f.name })
          const jwt = await getToken(f.fileId)
          if (!jwt) throw Object.assign(new Error("no token"), { fileName: f.name })
          try {
            targets.set(f.fileId, await loadTargetFile(projectId, f, jwt, lane))
          } catch (e) {
            throw Object.assign(e instanceof Error ? e : new Error(String(e)), { fileName: f.name })
          }
        }
        if (live) setPhase({ kind: "ready", read, targets })
      } catch (e) {
        if (live) setPhase({ kind: "failed", name: (e as { fileName?: string }).fileName ?? file?.name ?? "" })
      }
    })()
    return () => { live = false }
  }, [inputs, file, projectFiles, projectId, getToken, lane, attempt])

  const ready = phase.kind === "ready" ? phase : null
  const assignments = useMemo(
    () => (ready ? matchRecordings(ready.read, ready.targets, { overrides, orderShift, orderStart }) : []),
    [ready, overrides, orderShift, orderStart],
  )
  const jobs = useMemo(() => (ready ? planJobs(assignments, ready.read) : []), [ready, assignments])

  if (phase.kind !== "ready") {
    return (
      <div className="flex flex-col items-center gap-3 py-10 text-center" data-testid="recordings-loading">
        {phase.kind === "failed" ? (
          <>
            <p className="text-sm text-destructive" role="alert">{t("recordingsUpload.loading.failed", { name: phase.name })}</p>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>
              <Button onClick={() => setAttempt((n) => n + 1)}>{t("common.retry")}</Button>
            </div>
          </>
        ) : (
          <p className="text-sm font-medium" role="status">
            {phase.kind === "reading"
              ? t("recordingsUpload.loading.reading", { count: formatNumber(chosen.length, locale) })
              : t("recordingsUpload.loading.lines", { name: phase.name })}
          </p>
        )}
      </div>
    )
  }

  return (
    <ReviewBody
      ready={ready!}
      fileOrder={projectFiles.map((f) => f.id)}
      assignments={assignments}
      jobs={jobs}
      chosen={chosen}
      file={file}
      languageLabel={languageLabel}
      editing={editing}
      setEditing={setEditing}
      starting={starting}
      error={error}
      onOverride={(index, choice) => {
        setOverrides((prev) => new Map(prev).set(index, choice))
        setEditing(null)
      }}
      onShift={(run, by) => setOrderShift((prev) => new Map(prev).set(run, (prev.get(run) ?? 0) + by))}
      onStartAt={(run, cellId) => {
        setOrderStart((prev) => new Map(prev).set(run, cellId))
        setOrderShift((prev) => new Map(prev).set(run, 0))
        setEditing(null)
      }}
      onCancel={onCancel}
      onConfirm={async () => {
        if (!session?.jwt || jobs.length === 0 || isBulkUploadRunning()) return
        setStarting(true)
        setError(null)
        const labelOf = new Map(assignments.map((a) => [a.index, a.read ?? ""]))
        try {
          // Not awaited: the engine runs on after the dialog closes, and its
          // banner reports the result.
          void startBulkUpload({
            projectId,
            session,
            username,
            ...(lane ? { targetLang: lane } : {}),
            jobs,
            files: chosen.map((c) => c.file),
            targetLabel: (job: UploadJob) => labelOf.get(job.files[0]) ?? "",
          })
          onStarted()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          setStarting(false)
        }
      }}
    />
  )
}

interface ReviewBodyProps {
  ready: Extract<Phase, { kind: "ready" }>
  /** The project's files in sidebar order, so the books list in that order. */
  fileOrder: readonly string[]
  assignments: Assignment[]
  jobs: UploadJob[]
  chosen: ChosenFile[]
  file: { id: string; name: string } | null
  languageLabel: string | null
  editing: number | null
  setEditing: (index: number | null) => void
  starting: boolean
  error: string | null
  onOverride: (index: number, choice: { fileId: string; cellId: string } | "skip") => void
  onShift: (run: string, by: number) => void
  onStartAt: (run: string, cellId: string) => void
  onCancel: () => void
  onConfirm: () => void | Promise<void>
}

function ReviewBody({
  ready, fileOrder, assignments, jobs, chosen, file, languageLabel, editing, setEditing, starting, error, onOverride, onShift, onStartAt, onCancel, onConfirm,
}: ReviewBodyProps) {
  const t = useT()
  const { locale } = useI18n()
  const fmt = (n: number) => formatNumber(n, locale)
  const { targets } = ready
  const matched = useMemo(() => assignments.filter((a) => a.cellIds && a.fileId), [assignments])
  const unmatched = useMemo(() => assignments.filter((a) => !a.cellIds || !a.fileId), [assignments])
  const uploadCount = matched.length
  const lineIds = new Set(matched.flatMap((a) => a.cellIds!.map((id) => `${a.fileId}\u0000${id}`)))
  const lineById = useMemo(() => {
    const m = new Map<string, { file: TargetFile; line: TargetLine; position: number }>()
    for (const f of targets.values()) {
      let pos = 0
      for (const line of f.lines) {
        m.set(`${f.fileId}\u0000${line.cellId}`, { file: f, line, position: line.structural ? -1 : pos })
        if (!line.structural) pos++
      }
    }
    return m
  }, [targets])
  const recordedCount = [...lineIds].filter((id) => lineById.get(id)?.line.hasRecording).length

  // Parts: how many a verse has, for "part 2 of 3".
  const partsOf = useMemo(() => {
    const m = new Map<number, { n: number; total: number }>()
    for (const job of jobs) {
      if (job.kind !== "pieces") continue
      job.files.forEach((index, i) => m.set(index, { n: i + 1, total: job.files.length }))
    }
    return m
  }, [jobs])

  // Lines given more than one take (Sam, Oct 29): every file uploads, in the
  // job's order, and the last plays. "take 2 of 2" on each row; the lines in
  // the summary ("2 takes on Genesis 1:1").
  const takes = useMemo(() => {
    const byIndex = new Map(assignments.map((a) => [a.index, a]))
    const of = new Map<number, { n: number; total: number }>()
    const lines: LineTakes[] = []
    let byNumber = false
    let byDate = false
    for (const job of jobs) {
      if (job.kind !== "single" || job.files.length < 2) continue
      job.files.forEach((index, i) => of.set(index, { n: i + 1, total: job.files.length }))
      lines.push({ target: byIndex.get(job.files[0])?.read ?? "", count: job.files.length })
      if (takesByNumber(job.files.map((i) => byIndex.get(i)!))) byNumber = true
      else byDate = true
    }
    return { of, lines, byNumber, byDate }
  }, [jobs, assignments])

  // Order runs, each with where it starts now.
  const runs = useMemo(() => {
    const m = new Map<string, { count: number; first: Assignment | null; folder: string; fileId: string }>()
    for (const a of assignments) {
      if (!a.orderRun) continue
      const run = m.get(a.orderRun) ?? { count: 0, first: null, folder: "", fileId: a.orderRun.split("\u0000")[0] }
      run.count++
      if (a.cellIds && !run.first) run.first = a
      run.folder = chosen[a.index]?.path.split("/").slice(0, -1).join("/") ?? ""
      m.set(a.orderRun, run)
    }
    return m
  }, [assignments, chosen])

  // Rows grouped by destination file, in the file's own line order.
  const groups = useMemo(() => {
    const byFile = new Map<string, Assignment[]>()
    for (const a of matched) {
      const list = byFile.get(a.fileId!) ?? []
      list.push(a)
      byFile.set(a.fileId!, list)
    }
    const position = (a: Assignment) => {
      const hit = lineById.get(`${a.fileId}\u0000${a.cellIds![0]}`)
      return hit ? hit.file.lines.indexOf(hit.line) : 0
    }
    const rank = (fileId: string) => { const i = fileOrder.indexOf(fileId); return i < 0 ? Infinity : i }
    return [...byFile.entries()]
      .sort(([a], [b]) => rank(a) - rank(b))
      .map(([fileId, list]) => ({
        file: targets.get(fileId)!,
        rows: [...list].sort((a, b) => position(a) - position(b) || (partsOf.get(a.index)?.n ?? 0) - (partsOf.get(b.index)?.n ?? 0) || (a.take ?? 0) - (b.take ?? 0)),
      }))
  }, [matched, lineById, targets, partsOf, fileOrder])

  const pickerLines = useMemo(() => {
    const out: { value: string; label: string; fileId: string; cellId: string }[] = []
    for (const f of targets.values()) {
      let pos = 0
      for (const line of f.lines) {
        const label = `${lineLabel(f, line, pos)}  ${line.text}`.trim()
        out.push({ value: `${f.fileId}\u0000${line.cellId}`, label, fileId: f.fileId, cellId: line.cellId })
        if (!line.structural) pos++
      }
    }
    return out
  }, [targets])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 py-2" data-testid="recordings-review">
      <div className="shrink-0 space-y-1">
        <p className="text-sm font-medium" data-testid="recordings-summary">
          {uploadCount > 0
            ? t("recordingsUpload.preview.summary", {
                recordings: t("recordingsUpload.preview.recordings", { count: fmt(uploadCount) }),
                lines: t("recordingsUpload.preview.lines", { count: fmt(lineIds.size) }),
              })
            : t("recordingsUpload.preview.nothing")}{" "}
          <RecordingsRulesInfo />
        </p>
        <p className="text-xs text-muted-foreground">{t("recordingsUpload.preview.instructions")}</p>
        {takes.lines.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="recordings-takes-note">
            {takesSentence(t, locale, takes.lines)}
            {takes.byDate && <> {t("recordingsUpload.preview.takesNewest")}</>}
            {takes.byNumber && <> {t("recordingsUpload.preview.takesHighest")}</>}
          </p>
        )}
        {recordedCount > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="recordings-recorded-note">
            {t("recordingsUpload.preview.recordedCount", { count: fmt(recordedCount) })}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {languageLabel ? t("recordingsUpload.pick.language", { language: languageLabel }) : t("recordingsUpload.pick.languageDefault")}
        </p>
        {[...runs.entries()].map(([run, info], runIndex) => (
          <div key={run} className="flex flex-col gap-1.5 pt-1 text-xs text-muted-foreground" data-testid="recordings-order-run">
            <span>
              {t("recordingsUpload.preview.orderNote", {
                count: fmt(info.count),
                folder: info.folder ? `“${info.folder}”` : t("recordingsUpload.preview.topFolder"),
                first: info.first?.read ?? "—",
              })}
            </span>
            <span className="flex flex-wrap items-center gap-2">
            <Button type="button" size="xs" variant="outline" onClick={() => onShift(run, -1)} data-testid="recordings-order-earlier">
              <ArrowUp className="h-3 w-3" />
              {t("recordingsUpload.preview.orderEarlier")}
            </Button>
            <Button type="button" size="xs" variant="outline" onClick={() => onShift(run, 1)} data-testid="recordings-order-later">
              <ArrowDown className="h-3 w-3" />
              {t("recordingsUpload.preview.orderLater")}
            </Button>
            {editing === ORDER_START_EDIT - runIndex ? (
              <LinePicker
                lines={pickerLines.filter((l) => l.fileId === info.fileId)}
                current={info.first ? `${info.first.fileId}\u0000${info.first.cellIds![0]}` : null}
                label={t("recordingsUpload.preview.orderStartAt")}
                allowSkip={false}
                onPick={(choice) => { if (choice !== "skip") onStartAt(run, choice.cellId) }}
                onClose={() => setEditing(null)}
              />
            ) : (
              <Button type="button" size="xs" variant="outline" onClick={() => setEditing(ORDER_START_EDIT - runIndex)} data-testid="recordings-order-start">
                {t("recordingsUpload.preview.orderStartAt")}
              </Button>
            )}
            </span>
          </div>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border" data-testid="recordings-list">
        {unmatched.length > 0 && (
          <div className="border-b bg-muted/40 p-3" data-testid="recordings-unmatched">
            <p className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-400">
              {t("recordingsUpload.preview.notUploaded", { count: fmt(unmatched.length) })}
            </p>
            <ul className="space-y-1.5">
              {unmatched.map((a) => (
                <li key={a.index} className="flex items-start gap-2 text-xs" data-testid="recordings-unmatched-row" data-name={chosen[a.index]?.file.name}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground/90">{chosen[a.index]?.path}</span>
                    <span className="block text-muted-foreground" data-testid="recordings-reason">{a.reason ? reasonText(t, a.reason, fmt) : ""}</span>
                  </span>
                  {canChooseLine(a) && pickerLines.length > 0 && (
                    editing === a.index ? (
                      <LinePicker
                        lines={pickerLines}
                        current={null}
                        label={t("recordingsUpload.preview.chooseLineLabel", { name: chosen[a.index]?.file.name ?? "" })}
                        onPick={(choice) => onOverride(a.index, choice)}
                        onClose={() => setEditing(null)}
                      />
                    ) : (
                      <Button type="button" size="xs" variant="outline" onClick={() => setEditing(a.index)} data-testid="recordings-choose-line">
                        {t("recordingsUpload.preview.chooseLine")}
                      </Button>
                    )
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="divide-y">
          {groups.map((group) => (
            <div key={group.file.fileId} className="p-3" data-testid="recordings-group">
              {!file && (
                <p className="mb-2 text-xs font-semibold text-foreground/80">
                  {group.file.bookCode ? englishBookName(group.file.bookCode) : group.file.name}
                  <span className="ms-2 font-normal text-muted-foreground">
                    {t("recordingsUpload.preview.recordings", { count: fmt(group.rows.length) })}
                  </span>
                </p>
              )}
              <ul className="space-y-1">
                {group.rows.map((a) => {
                  const hit = lineById.get(`${a.fileId}\u0000${a.cellIds![0]}`)
                  const parts = partsOf.get(a.index)
                  const recorded = a.cellIds!.some((id) => lineById.get(`${a.fileId}\u0000${id}`)?.line.hasRecording)
                  const notes: string[] = [a.chosen ? t("recordingsUpload.preview.chosen") : t(METHOD_KEY[a.method ?? "name"])]
                  if (a.fromFolder) notes.push(t("recordingsUpload.preview.fromFolder", { folder: a.fromFolder }))
                  if (a.cellIds!.length > 1) notes.push(t("recordingsUpload.preview.range", { count: fmt(a.cellIds!.length) }))
                  if (parts) notes.push(t("recordingsUpload.preview.part", { n: parts.n, total: parts.total }))
                  else if (lonePart(a, assignments)) notes.push(t("recordingsUpload.preview.lonePart"))
                  const takeOf = takes.of.get(a.index)
                  if (takeOf) {
                    notes.push(t("recordingsUpload.preview.takeOf", { n: takeOf.n, total: takeOf.total }))
                    if (takeOf.n === takeOf.total) notes.push(t("recordingsUpload.preview.plays"))
                  } else if (a.take != null) notes.push(t("recordingsUpload.preview.take", { n: a.take }))
                  const current = `${a.fileId}\u0000${a.cellIds![0]}`
                  return (
                    <li
                      key={a.index}
                      className="flex items-baseline gap-2 text-xs"
                      data-testid="recordings-row"
                      data-name={chosen[a.index]?.file.name}
                      data-target={a.read}
                      data-method={a.chosen ? "chosen" : a.method}
                    >
                      <span className="w-28 shrink-0 truncate font-mono text-muted-foreground" title={a.read}>{a.read}</span>
                      <span className="min-w-0 flex-1 truncate text-foreground/80" title={hit?.line.text}>{hit?.line.text}</span>
                      <span className="w-40 shrink-0 truncate text-muted-foreground" title={chosen[a.index]?.path}>{chosen[a.index]?.file.name}</span>
                      <span className="w-48 shrink-0 leading-snug text-muted-foreground" data-testid="recordings-how">
                        {notes.join(" · ")}
                        {recorded && (
                          <span className="text-amber-700 dark:text-amber-400"> · {t("recordingsUpload.preview.hasRecording")}</span>
                        )}
                      </span>
                      {editing === a.index ? (
                        <LinePicker
                          lines={pickerLines}
                          current={current}
                          label={t("recordingsUpload.preview.changeLabel", { name: chosen[a.index]?.file.name ?? "" })}
                          onPick={(choice) => onOverride(a.index, choice)}
                          onClose={() => setEditing(null)}
                        />
                      ) : (
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          className="shrink-0"
                          onClick={() => setEditing(a.index)}
                          aria-label={t("recordingsUpload.preview.changeLabel", { name: chosen[a.index]?.file.name ?? "" })}
                          data-testid="recordings-change"
                        >
                          {t("recordingsUpload.preview.change")}
                        </Button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="flex shrink-0 justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={starting}>{t("common.cancel")}</Button>
        <Button onClick={() => void onConfirm()} disabled={starting || uploadCount === 0} data-testid="recordings-confirm">
          {t("recordingsUpload.preview.confirm", { count: fmt(uploadCount) })}
        </Button>
      </div>
    </div>
  )
}

/** `editing` value while an order run's start is being chosen (minus the run's index). */
const ORDER_START_EDIT = -1

// ── Choosing a line by hand ──────────────────────────────────────────────────

interface PickerLine { value: string; label: string; fileId: string; cellId: string }
type PickerRow = PickerLine | { value: "skip"; label: string }

/** How many lines show before the person types: the ones around the current. */
const BROWSE_WINDOW = 150

function LinePicker({
  lines, current, label, onPick, onClose, allowSkip = true,
}: {
  lines: readonly PickerLine[]
  current: string | null
  label: string
  onPick: (choice: { fileId: string; cellId: string } | "skip") => void
  onClose: () => void
  /** Offer "Don't upload" at the top. */
  allowSkip?: boolean
}) {
  const t = useT()
  const [query, setQuery] = useState("")
  const anchor = useRef<HTMLButtonElement | null>(null)
  const skip: PickerRow = useMemo(() => ({ value: "skip", label: t("recordingsUpload.preview.dontUpload") }), [t])
  const rows = useMemo<PickerRow[]>(() => {
    const q = query.trim().toLowerCase()
    const head = allowSkip ? [skip] : []
    if (q) return [...head, ...lines.filter((l) => l.label.toLowerCase().includes(q)).slice(0, 300)]
    const at = Math.max(0, lines.findIndex((l) => l.value === current))
    const from = Math.max(0, at - Math.floor(BROWSE_WINDOW / 3))
    return [...head, ...lines.slice(from, from + BROWSE_WINDOW)]
  }, [lines, query, current, skip, allowSkip])
  const selected = rows.find((r) => r.value === current) ?? null
  const onOpenChange = useCallback((next: boolean) => { if (!next) onClose() }, [onClose])
  return (
    <ComboboxPrimitive.Root
      items={rows}
      value={selected}
      defaultOpen
      onOpenChange={onOpenChange}
      inputValue={query}
      onInputValueChange={(next: string) => setQuery(next)}
      autoHighlight
      onValueChange={(row: PickerRow | null) => {
        if (!row) return
        if (row.value === "skip") onPick("skip")
        else onPick({ fileId: (row as PickerLine).fileId, cellId: (row as PickerLine).cellId })
      }}
      itemToStringLabel={(row: PickerRow) => row.label}
      itemToStringValue={(row: PickerRow) => row.value}
      isItemEqualToValue={(a: PickerRow, b: PickerRow) => a.value === b.value}
      filter={() => true}
    >
      <ComboboxPrimitive.Trigger
        render={
          <Button ref={anchor} type="button" size="xs" variant="outline" className="shrink-0" aria-label={label} data-testid="recordings-line-picker">
            {t("recordingsUpload.preview.chooseLine")}
          </Button>
        }
      />
      <ComboboxContent align="end" className="w-96 max-w-[calc(100vw-2rem)]">
        <ComboboxInput showTrigger={false} showSearchIcon placeholder={t("recordingsUpload.preview.searchLines")} aria-label={t("recordingsUpload.preview.searchLines")} />
        <ComboboxEmpty>{t("recordingsUpload.preview.noLines")}</ComboboxEmpty>
        <ComboboxList>
          {(row: PickerRow) => (
            <ComboboxItem key={row.value} value={row} data-testid="recordings-line-option">
              <span className={cn("min-w-0 truncate", row.value === "skip" && "text-muted-foreground")}>{row.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  )
}
