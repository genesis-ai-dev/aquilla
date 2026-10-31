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
  needsLength,
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
import { readLengths } from "@/lib/audio/bulk-upload/read-length"
import { mapWithConcurrency } from "@/lib/concurrency"
import { InfoReveal, InfoToggle, useInfoOpen } from "@/components/ui/info-tip"
import { applyNamingRule, judgeRule, projectBooksOf, projectOutline, ruleEligible, sampleNames, shapesOf, type NamingRule, type NotKeptReason, type RuleContext, type RuleFailure } from "@/lib/audio/bulk-upload/naming-rule"
import { askForNamingRule, forgetSavedNamingRule, loadSavedNamingRules, NamingRuleError, saveNamingRule, type NamingRuleProblem } from "@/lib/audio/bulk-upload/naming-rule-client"

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
              accept="audio/*,.wav,.mp3,.m4a,.ogg,.oga,.opus,.flac,.aac,.webm"
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
  /** AQU-2302: a project lead may ask the assistant to work out the naming;
   *  everyone else who uploads gets the team's saved namings only. */
  canAskAssistant?: boolean
  onStarted: () => void
  onCancel: () => void
}

type Phase =
  | { kind: "reading" }
  | { kind: "loading"; name: string }
  | { kind: "lengths"; count: number }
  | { kind: "failed"; name: string }
  | { kind: "ready"; read: ReadRecording[]; targets: Map<string, TargetFile>; lengths: ReadonlyMap<number, number> }

const LOAD_CONCURRENCY = 3

/** "Genesis 1:3", or "Welcome letter · 12" for a document's line. */
function lineLabel(file: TargetFile, line: TargetLine, position: number): string {
  const m = line.ref ? /^([1-3]?[A-Z]{2,3})\s+(\d+:\S+)$/.exec(line.ref) : null
  if (m) return `${file.bookCode ? englishBookName(file.bookCode) : file.name} ${m[2]}`
  return `${file.name} · ${position + 1}`
}

/** "3.1 minutes", "12 seconds": how long a recording runs, in the reader's language. */
function lengthText(ms: number, locale: string): string {
  return ms >= 60_000
    ? new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long", maximumFractionDigits: 1 }).format(Math.round(ms / 6_000) / 10)
    : new Intl.NumberFormat(locale, { style: "unit", unit: "second", unitDisplay: "long", maximumFractionDigits: 0 }).format(Math.round(ms / 1000))
}

function reasonText(t: ReturnType<typeof useT>, reason: UnmatchedReason, fmt: (n: number) => string, len: (ms: number) => string): string {
  switch (reason.code) {
    case "notAudio": return t("recordingsUpload.reason.notAudio")
    case "unplayableFormat": return t("recordingsUpload.reason.unplayableFormat", { ext: reason.ext })
    case "systemFile": return t("recordingsUpload.reason.systemFile")
    case "empty": return t("recordingsUpload.reason.empty")
    case "tooLarge": return t("recordingsUpload.reason.tooLarge", { mb: reason.mb, limit: reason.limitMb })
    case "noBook": return t("recordingsUpload.reason.noBook")
    case "bookNotInProject": return t("recordingsUpload.reason.bookNotInProject", { book: reason.book })
    case "bookNumberUnclear": return t("recordingsUpload.reason.bookNumberUnclear", { first: reason.first, second: reason.second })
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
    case "rangeBackwards": return t("recordingsUpload.reason.rangeBackwards", { from: reason.from, to: reason.to })
    case "chapterOrVerse":
      return reason.lengthMs != null
        ? t("recordingsUpload.reason.chapterOrVerseLength", { count: fmt(reason.count), book: reason.book, chapters: fmt(reason.chapters), verses: fmt(reason.verses), length: len(reason.lengthMs) })
        : t("recordingsUpload.reason.chapterOrVerse", { count: fmt(reason.count), book: reason.book, chapters: fmt(reason.chapters), verses: fmt(reason.verses) })
    case "bookVerseDisagree": return t("recordingsUpload.reason.bookVerseDisagree", { verse: reason.verse, count: fmt(reason.count), ref: reason.ref })
    case "noSuchBookVerse": return t("recordingsUpload.reason.noSuchBookVerse", { book: reason.book, verses: fmt(reason.verses), count: fmt(reason.count) })
    case "skipped": return t("recordingsUpload.reason.skipped")
  }
}

const METHOD_KEY = {
  name: "recordingsUpload.preview.byName",
  number: "recordingsUpload.preview.byNumber",
  order: "recordingsUpload.preview.byOrder",
} as const satisfies Record<string, MessageKey>

export function RecordingsReview({
  projectId, file, projectFiles, getToken, lane, languageLabel, username, chosen, canAskAssistant = false, onStarted, onCancel,
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
  // AQU-2302: a naming rule — the assistant's, or one the team saved — gives
  // the names none of the app's own readings placed a name the matcher reads.
  // Everything after that is the ordinary matching below.
  const [rule, setRule] = useState<AppliedRule | null>(null)
  const [assistant, setAssistant] = useState<AssistantState>({ kind: "idle" })
  // The team's saved namings are looked up once per preview. A ref, not state:
  // setting state here would re-run the effect below and cancel the very
  // request it just made. The offer waits for the answer (`lookupDone`), and
  // only the newest lookup's answer is ever used.
  const savedChecked = useRef(false)
  const lookupId = useRef(0)
  const [lookupDone, setLookupDone] = useState(false)
  // Whether the server lets this person keep and forget the team's namings: a
  // project lead who is also in the project's organization (Sam, Oct 30).
  // Null until the saved namings answer, or when they don't.
  const [teamCanKeep, setTeamCanKeep] = useState<boolean | null>(null)
  // "Forget this naming for the team": in flight, and whether the last try
  // failed. On a refusal or a network failure the naming stays as it was.
  const [forgetting, setForgetting] = useState(false)
  const [forgetFailed, setForgetFailed] = useState(false)
  // Calls for this folder: one ask and one retry at most (review, Oct 30: a
  // failed retry once asked 37 times in 1.5 s, every call billed). Counted in
  // a ref that no failure or re-render resets; the preview is remounted for
  // each folder (Back goes to the picker), so this is per folder per dialog.
  const callCount = useRef(0)
  const [callsMade, setCallsMade] = useState(0)
  // Every request in flight, so Cancel, Back and closing stop them.
  const inFlight = useRef(new Set<AbortController>())
  // Each project file's lines, read once per dialog: applying a rule reads the
  // names again, never the lines (review, Oct 30).
  const targetCache = useRef(new Map<string, TargetFile>())
  useEffect(() => {
    const live = inFlight.current
    return () => {
      for (const controller of live) controller.abort()
      live.clear()
    }
  }, [])
  // Keyed on the names the rule made, not on the rule itself: settling which
  // of two answers is used reads nothing again when it keeps the one just read.
  const made = rule?.made
  const effectiveInputs = useMemo(() => {
    if (!made) return inputs
    return inputs.map((f, i) => {
      const name = made.get(i)
      return name ? { ...f, name, path: name } : f
    })
  }, [inputs, made])

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
      let read = readRecordings(effectiveInputs, opts)
      try {
        const scoped = file ? infos.filter((f) => f.fileId === file.id) : infos.filter((f) => f.bookCode)
        const wantsNames = file != null || read.some((r) => r.reading.unknownBookWord || r.targetReason?.code === "noBook")
        if (wantsNames && scoped.some((f) => f.bookCode)) {
          await mapWithConcurrency(scoped, LOAD_CONCURRENCY, async (f) => {
            const jwt = await getToken(f.fileId)
            if (jwt) await learnHeaderNames(projectId, f, jwt, lane, index).catch(() => {})
          })
          read = readRecordings(effectiveInputs, opts)
        }
        const files = chosen.map((c) => c.file)
        const targets = new Map<string, TargetFile>()
        const wanted = targetsWanted(read).map((id) => infos.find((f) => f.fileId === id)!).filter(Boolean)
        for (const f of wanted) {
          if (!live) return
          const key = `${lane}\u0000${f.fileId}`
          const cached = targetCache.current.get(key)
          if (cached) {
            targets.set(f.fileId, cached)
            continue
          }
          setPhase({ kind: "loading", name: f.name })
          const jwt = await getToken(f.fileId)
          if (!jwt) throw Object.assign(new Error("no token"), { fileName: f.name })
          try {
            const loaded = await loadTargetFile(projectId, f, jwt, lane)
            targetCache.current.set(key, loaded)
            targets.set(f.fileId, loaded)
          } catch (e) {
            throw Object.assign(e instanceof Error ? e : new Error(String(e)), { fileName: f.name })
          }
        }
        // Sam, Oct 29: numbers alone that the count can't place go by the
        // recordings' length, read from each file's header or metadata.
        const want = needsLength(matchRecordings(read, targets))
        let lengths: ReadonlyMap<number, number> = new Map()
        if (want.length > 0) {
          if (!live) return
          setPhase({ kind: "lengths", count: want.length })
          lengths = await readLengths(files, want)
        }
        if (live) setPhase({ kind: "ready", read, targets, lengths })
      } catch (e) {
        if (live) setPhase({ kind: "failed", name: (e as { fileName?: string }).fileName ?? file?.name ?? "" })
      }
    })()
    return () => { live = false }
  }, [effectiveInputs, chosen, file, projectFiles, projectId, getToken, lane, attempt])

  const ready = phase.kind === "ready" ? phase : null
  const assignments = useMemo(
    () => (ready ? matchRecordings(ready.read, ready.targets, { overrides, orderShift, orderStart, lengths: ready.lengths }) : []),
    [ready, overrides, orderShift, orderStart],
  )
  const jobs = useMemo(() => (ready ? planJobs(assignments, ready.read) : []), [ready, assignments])

  // The names a rule may rewrite: the ones 981 couldn't read. What it refused
  // on purpose (a verse the book lacks, another book), what the person skipped
  // and what isn't a recording never go to the assistant (`ruleEligible`).
  const unplaced = useMemo(
    () => (ready && !rule ? assignments.filter(ruleEligible).map((a) => a.index) : []),
    [ready, rule, assignments],
  )
  // The project's Bible files, which a rule's book words are read with, as
  // the server reads them when it keeps the rule.
  const projectBooks = useMemo(() => projectBooksOf(projectFiles), [projectFiles])
  // Where the files sit and where each line is: whether a rule's placements
  // look like a reading of the names (`judgeRule`).
  const context = useMemo<RuleContext | null>(() => {
    if (!ready) return null
    const at = new Map<string, number>()
    for (const target of ready.targets.values()) target.lines.forEach((line, i) => at.set(`${target.fileId}\u0000${line.cellId}`, i))
    return { pathOf: (i) => inputs[i]?.path ?? "", lineIndex: (fileId, cellId) => at.get(`${fileId}\u0000${cellId}`), projectBooks }
  }, [ready, inputs, projectBooks])
  // Judged only once the lines were read with the rule's names: the render
  // between setting a rule and that read still holds the old reading.
  const ruleRead = Boolean(ready && rule && [...rule.made].every(([i, name]) => ready.read[i]?.file.name === name))
  const judgement = useMemo(
    () => (ready && rule && ruleRead && context ? judgeRule(rule.rule, rule.eligible, rule.made, assignments, (i) => inputs[i].name, context) : null),
    [ready, rule, ruleRead, assignments, inputs, context],
  )

  const identityToken = session?.jwt
  const ask = useCallback(async (eligible: readonly number[], retryOf?: { first: AppliedRule; placed: number; failures: readonly RuleFailure[] }) => {
    if (!identityToken || !canAskAssistant || callCount.current >= MAX_ASSISTANT_CALLS) return
    callCount.current += 1
    setCallsMade(callCount.current)
    const controller = new AbortController()
    inFlight.current.add(controller)
    setAssistant({ kind: "asking" })
    try {
      const next = await askForNamingRule({
        projectId,
        identityToken,
        // The retry sends only the names the first rule failed on.
        names: sampleNames(retryOf ? retryOf.failures.map((f) => f.name) : eligible.map((i) => inputs[i].name)),
        outline: projectOutline(projectFileInfos(projectFiles, new BookNameIndex())),
        ...(retryOf ? { previous: retryOf.first.rule, failures: retryOf.failures } : {}),
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setAssistant({ kind: "idle" })
      setRule(appliedRule(next, "assistant", eligible, inputs, retryOf
        ? { retried: true, firstAnswer: { applied: retryOf.first, placed: retryOf.placed } }
        : {}))
    } catch (e) {
      if (controller.signal.aborted) return
      setAssistant({ kind: "problem", problem: e instanceof NamingRuleError ? e.problem : "failed" })
    } finally {
      inFlight.current.delete(controller)
    }
  }, [identityToken, canAskAssistant, projectId, inputs, projectFiles])

  // A team's saved rule for these names' shape is used with no call at all,
  // for anyone who may upload. A lookup answering late never replaces a rule
  // already in use, and never one from a newer lookup. One that hasn't
  // answered in SAVED_LOOKUP_MS is given up, and the offer is enabled
  // (review, Oct 30).
  useEffect(() => {
    if (!ready || rule || savedChecked.current || unplaced.length === 0 || !session?.jwt) return
    savedChecked.current = true
    const id = ++lookupId.current
    const controller = new AbortController()
    inFlight.current.add(controller)
    const eligible = [...unplaced]
    const shape = shapesOf(eligible.map((i) => inputs[i].name))[0]
    const giveUp = setTimeout(() => {
      controller.abort()
      inFlight.current.delete(controller)
      if (id === lookupId.current) setLookupDone(true)
    }, SAVED_LOOKUP_MS)
    void loadSavedNamingRules({ projectId, identityToken: session.jwt, projectBooks, signal: controller.signal }).then((saved) => {
      clearTimeout(giveUp)
      inFlight.current.delete(controller)
      if (controller.signal.aborted || id !== lookupId.current) return
      setLookupDone(true)
      setTeamCanKeep(saved.canKeep)
      const hit = shape ? saved.rules.get(shape) : undefined
      if (hit) setRule((current) => current ?? appliedRule(hit, "saved", eligible, inputs, { savedShape: shape }))
    })
  }, [ready, rule, unplaced, session?.jwt, projectId, inputs, projectBooks])

  // The one retry: only the names the first answer failed on go back, and
  // only while a call is left. The retry's rule is used only when it places
  // more of the folder's names than the first answer's did, counted as
  // `judgeRule` counts them; on fewer, or on a tie, the first answer's rule
  // stays in use (Sam, Oct 30). Either way no call follows. A rule that still
  // places nothing is set aside, and the files are chosen by hand. A lead's
  // ask about the names a team's saved rule left is weighed the same way
  // against the saved rule (review, Oct 30).
  useEffect(() => {
    if (!judgement || !rule || rule.from !== "assistant" || assistant.kind === "asking") return
    const first = rule.firstAnswer
    if (first) {
      if (judgement.placed.size > first.placed) {
        const { firstAnswer: _weighed, ...retry } = rule
        setRule(retry)
      } else if (first.placed > 0) {
        setRule({ ...first.applied, retried: true })
      } else {
        setRule(null)
        setAssistant({ kind: "problem", problem: "noFit" })
      }
      return
    }
    if (judgement.failures.length === 0) return
    if (!rule.retried && callCount.current < MAX_ASSISTANT_CALLS) {
      void ask([...rule.eligible], { first: rule, placed: judgement.placed.size, failures: judgement.failures })
    } else if (judgement.placed.size === 0) {
      setRule(null)
      setAssistant({ kind: "problem", problem: "noFit" })
    }
  }, [judgement, rule, assistant.kind, ask])

  const stopAsking = () => {
    for (const controller of inFlight.current) controller.abort()
    inFlight.current.clear()
  }

  // Until the lines are read with the rule in use, and while a retry's answer
  // is weighed against the first, the preview waits: the other rule's rows,
  // note and keep never stand in for the one in use.
  const settling = Boolean(rule && (rule.firstAnswer || !ruleRead))
  if (phase.kind !== "ready" || settling) {
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
            {phase.kind === "loading"
              ? t("recordingsUpload.loading.lines", { name: phase.name })
              : phase.kind === "lengths"
                ? t("recordingsUpload.loading.lengths", { count: formatNumber(phase.count, locale) })
                : t("recordingsUpload.loading.reading", { count: formatNumber(chosen.length, locale) })}
          </p>
        )}
      </div>
    )
  }

  // What a lead may still ask about: every name the app couldn't read, or,
  // with a team's saved rule in use, the names it left (review, Oct 30). That
  // ask is weighed against the saved rule like a retry, and is its last call.
  const askAbout = !rule ? unplaced.length : rule.from === "saved" && !rule.retried && judgement ? judgement.failures.length : 0
  // Offered only to someone the server will let forget it (Sam, Oct 30).
  const forgetSaved = rule?.from === "saved" && rule.savedShape && canAskAssistant && teamCanKeep === true && session?.jwt
    ? { shape: rule.savedShape, identityToken: session.jwt }
    : null
  // Whether the assistant's rule in use will be kept for the team, and why
  // not: the rule's own reasons, then a lead the server won't let keep it.
  const keepReasons: KeepReason[] | null = rule?.from === "assistant" && judgement
    ? [...judgement.notKept, ...(teamCanKeep === false ? ["notInOrg" as const] : [])]
    : null

  return (
    <ReviewBody
      ready={ready!}
      ruleSource={rule && judgement ? new Map([...judgement.placed].map((i) => [i, rule.from])) : NO_RULE}
      assistant={{
        offer: session?.jwt ? askAbout : 0,
        canAsk: canAskAssistant,
        exhausted: callsMade >= MAX_ASSISTANT_CALLS,
        waiting: !lookupDone,
        state: assistant,
        note: rule && assistant.kind !== "asking"
          ? {
              from: rule.from,
              explanation: rule.rule.explanation ?? rule.rule.templates.map((t) => t.pattern).join(" · "),
              placed: judgement?.placed.size ?? 0,
              keep: keepReasons,
              forgetFailed,
            }
          : null,
        forgetting,
        onAsk: () => {
          if (rule && judgement) void ask([...rule.eligible], { first: rule, placed: judgement.placed.size, failures: judgement.failures })
          else void ask(unplaced)
        },
        // "Don't use this naming" sets the rule aside for this upload only,
        // a team's saved rule too (review, Oct 30).
        onUndo: () => {
          setRule(null)
          setAssistant({ kind: "idle" })
          setForgetFailed(false)
        },
        // A lead may forget the team's saved rule, on its own plainly
        // labelled button: the server forgets it under every shape it is
        // kept under.
        // On a refusal or a network failure the naming stays in use, and the
        // note says plainly that it wasn't forgotten (Sam, Oct 30).
        onForget: forgetSaved
          ? () => {
              setForgetting(true)
              setForgetFailed(false)
              void forgetSavedNamingRule({ projectId, identityToken: forgetSaved.identityToken, shapes: [forgetSaved.shape] }).then((forgotten) => {
                setForgetting(false)
                if (!forgotten) {
                  setForgetFailed(true)
                  return
                }
                // Only the saved naming it was asked about; never a rule the
                // lead has asked for meanwhile.
                setRule((current) => (current?.from === "saved" && current.savedShape === forgetSaved.shape ? null : current))
                setAssistant({ kind: "idle" })
              })
            }
          : undefined,
      }}
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
      onCancel={() => {
        stopAsking()
        onCancel()
      }}
      onConfirm={async () => {
        if (!session?.jwt || jobs.length === 0 || isBulkUploadRunning()) return
        setStarting(true)
        setError(null)
        const labelOf = new Map(assignments.map((a) => [a.index, a.read ?? ""]))
        // The assistant's rule in use is kept for the team once a person
        // uploads with it, and only when `judgeRule` says so: every name it
        // was asked about placed by reading it, no constant book, chapter or
        // file and no book word that names no book, the files in order on
        // lines close together, and no two files on one line unless they are
        // its pieces ("v04a" and "v04b"; verses 4 and 5 on a joined line).
        // Two files on the same spot with no part between them are takes of
        // one another, and stop the keep.
        if (rule?.from === "assistant" && judgement?.keep && teamCanKeep !== false) {
          void saveNamingRule({ projectId, identityToken: session.jwt, shapes: rule.shapes, rule: rule.rule })
        }
        try {
          // Not awaited: the engine runs on after the dialog closes, and its
          // banner reports the result. It finishes its run whatever happens,
          // so nothing is left for a rejection to tell anyone.
          startBulkUpload({
            projectId,
            session,
            username,
            ...(lane ? { targetLang: lane } : {}),
            jobs,
            files: chosen.map((c) => c.file),
            targetLabel: (job: UploadJob) => labelOf.get(job.files[0]) ?? "",
          }).catch(() => {})
          onStarted()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
          setStarting(false)
        }
      }}
    />
  )
}

/** One ask and one retry per folder, at most. */
const MAX_ASSISTANT_CALLS = 2
/** How long the team's saved namings may take to answer before the offer is
 *  enabled without them (review, Oct 30). */
const SAVED_LOOKUP_MS = 8_000

/** A naming rule in use, and which names it rewrote. */
interface AppliedRule {
  rule: NamingRule
  from: "assistant" | "saved"
  /** The names it was asked to read: those nothing else placed. */
  eligible: ReadonlySet<number>
  /** The name it made of each one it fitted, by input index. */
  made: ReadonlyMap<number, string>
  /** The names' shapes the team keeps it under. */
  shapes: string[]
  /** The answer to the one retry, or the first answer kept over it: no
   *  further call follows it. */
  retried: boolean
  /** On the retry's answer until it is weighed: the first answer's rule and
   *  how many names it placed. The retry's rule is used only when it places
   *  more (Sam, Oct 30). */
  firstAnswer?: { applied: AppliedRule; placed: number }
  /** For a saved rule, the shape it was found under (what "Don't use this
   *  naming" forgets). */
  savedShape?: string
}

function appliedRule(
  next: NamingRule,
  from: AppliedRule["from"],
  eligible: readonly number[],
  inputs: readonly { name: string; path: string }[],
  extra: { retried?: boolean; savedShape?: string; firstAnswer?: AppliedRule["firstAnswer"] } = {},
): AppliedRule {
  const made = new Map<number, string>()
  for (const i of eligible) {
    const name = applyNamingRule(next, inputs[i].name)
    if (name) made.set(i, name)
  }
  return {
    rule: next,
    from,
    eligible: new Set(eligible),
    made,
    shapes: shapesOf(eligible.map((i) => inputs[i].name)).slice(0, 5),
    retried: extra.retried ?? false,
    ...(extra.savedShape ? { savedShape: extra.savedShape } : {}),
    ...(extra.firstAnswer ? { firstAnswer: extra.firstAnswer } : {}),
  }
}

type AssistantState =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "problem"; problem: NamingRuleProblem | "noFit" }

interface AssistantProps {
  /** How many recordings it could help with; 0 hides the offer. */
  offer: number
  /** A project lead, who may ask; anyone else sees one plain line instead. */
  canAsk: boolean
  /** Both calls for this folder are made: the offer doesn't come back. */
  exhausted: boolean
  /** The team's saved namings haven't answered yet: no asking until they do. */
  waiting: boolean
  state: AssistantState
  note: {
    from: AppliedRule["from"]
    explanation: string
    placed: number
    /** The assistant's rule: why it won't be kept for the team, empty when it
     *  will. Null for a team's saved rule, which is kept already. */
    keep: KeepReason[] | null
    /** "Forget this naming for the team" didn't go through. */
    forgetFailed: boolean
  } | null
  /** "Forget this naming for the team" is in flight. */
  forgetting: boolean
  onAsk: () => void
  onUndo: () => void
  /** A lead, on a team's saved rule: forget it for the team. */
  onForget?: () => void
}

/** Why the assistant's rule won't be kept: the rule's own reasons, and a lead
 *  who isn't in the project's organization (Sam, Oct 30). */
type KeepReason = NotKeptReason | "notInOrg"

const KEEP_REASON_KEYS = {
  fixed: "recordingsUpload.assistant.notKept.fixed",
  bookWord: "recordingsUpload.assistant.notKept.bookWord",
  notAllPlaced: "recordingsUpload.assistant.notKept.notAllPlaced",
  sharedLine: "recordingsUpload.assistant.notKept.sharedLine",
  scattered: "recordingsUpload.assistant.notKept.scattered",
  notInOrg: "recordingsUpload.assistant.notKept.notInOrg",
} as const satisfies Record<KeepReason, string>

const NO_RULE: ReadonlyMap<number, AppliedRule["from"]> = new Map()

interface ReviewBodyProps {
  ready: Extract<Phase, { kind: "ready" }>
  ruleSource: ReadonlyMap<number, AppliedRule["from"]>
  assistant: AssistantProps
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
  ready, ruleSource, assistant, fileOrder, assignments, jobs, chosen, file, languageLabel, editing, setEditing, starting, error, onOverride, onShift, onStartAt, onCancel, onConfirm,
}: ReviewBodyProps) {
  const t = useT()
  const { locale } = useI18n()
  const fmt = (n: number) => formatNumber(n, locale)
  const len = (ms: number) => lengthText(ms, locale)
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

  // Numbers alone placed by the recordings' length (Sam, Oct 29), per folder.
  const byLength = useMemo(() => {
    const m = new Map<string, { as: "chapter" | "verse"; count: number; ms: number; folder: string }>()
    for (const a of assignments) {
      if (!a.byLength) continue
      const folder = chosen[a.index]?.path.split("/").slice(0, -1).join("/") ?? ""
      const key = `${folder}\u0000${a.byLength.as}`
      const entry = m.get(key) ?? { as: a.byLength.as, count: 0, ms: a.byLength.ms, folder }
      entry.count++
      m.set(key, entry)
    }
    return [...m.values()]
  }, [assignments, chosen])

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
        {byLength.map((note) => (
          <p key={`${note.folder}-${note.as}`} className="text-xs text-muted-foreground" data-testid="recordings-length-note">
            {t(note.as === "chapter" ? "recordingsUpload.preview.lengthChapters" : "recordingsUpload.preview.lengthVerses", {
              count: fmt(note.count),
              folder: note.folder ? `“${note.folder}”` : t("recordingsUpload.preview.topFolder"),
              length: len(note.ms),
            })}
          </p>
        ))}
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
        <AssistantBox {...assistant} canChoose={pickerLines.length > 0} />
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
                    <span className="block text-muted-foreground" data-testid="recordings-reason">{a.reason ? reasonText(t, a.reason, fmt, len) : ""}</span>
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
                  const byRule = a.chosen ? undefined : ruleSource.get(a.index)
                  const notes: string[] = [
                    a.chosen
                      ? t("recordingsUpload.preview.chosen")
                      : byRule
                        ? t(byRule === "saved" ? "recordingsUpload.assistant.bySavedRule" : "recordingsUpload.assistant.byRule")
                        : t(METHOD_KEY[a.method ?? "name"]),
                  ]
                  if (a.fromFolder) notes.push(t("recordingsUpload.preview.fromFolder", { folder: a.fromFolder }))
                  if (a.byLength) notes.push(t(a.byLength.as === "chapter" ? "recordingsUpload.preview.chapterByLength" : "recordingsUpload.preview.verseByLength"))
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

/**
 * AQU-2302: the offer to let the assistant work out the naming, never taken on
 * its own (Sam, Oct 29: as little AI use as possible), and what it found.
 */
function AssistantBox({ offer, canAsk, exhausted, waiting, state, note, forgetting, onAsk, onUndo, onForget, canChoose }: AssistantProps & { canChoose: boolean }) {
  const t = useT()
  const { locale } = useI18n()
  const [infoOpen, toggleInfo] = useInfoOpen()
  const [whyOpen, toggleWhy] = useInfoOpen()
  if (state.kind === "asking") {
    return <p className="border-b bg-muted/40 p-3 text-xs font-medium" role="status" data-testid="recordings-assistant-asking">{t("recordingsUpload.assistant.asking")}</p>
  }
  const noteBox = note && (
    <div className="flex items-start gap-2 border-b bg-muted/40 p-3 text-xs" data-testid="recordings-assistant-note">
      <span className="min-w-0 flex-1 space-y-0.5">
        <span className="block text-foreground/90">
          {t(note.from === "saved" ? "recordingsUpload.assistant.readSaved" : "recordingsUpload.assistant.read", { explanation: note.explanation })}
        </span>
        <span className="block text-muted-foreground">{t("recordingsUpload.assistant.placed", { count: formatNumber(note.placed, locale) })}</span>
        {note.keep && (note.keep.length === 0 ? (
          <span className="block text-muted-foreground" data-testid="recordings-assistant-keep" data-keep="true">{t("recordingsUpload.assistant.keeps")}</span>
        ) : (
          <span className="block text-muted-foreground" data-testid="recordings-assistant-keep" data-keep="false">
            <span className="flex items-center gap-1">
              {t("recordingsUpload.assistant.thisUploadOnly")}
              <InfoToggle open={whyOpen} onToggle={toggleWhy} label={t("recordingsUpload.assistant.whyNotKeptLabel")} controls="recordings-assistant-why" testId="recordings-assistant-why-toggle" />
            </span>
            <InfoReveal open={whyOpen} id="recordings-assistant-why" testId="recordings-assistant-why">
              {note.keep.map((reason) => t(KEEP_REASON_KEYS[reason])).join(" ")}
            </InfoReveal>
          </span>
        ))}
        {note.forgetFailed && (
          <span className="block text-amber-700 dark:text-amber-400" role="alert" data-testid="recordings-assistant-forget-failed">{t("recordingsUpload.assistant.forgetFailed")}</span>
        )}
      </span>
      <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
        {onForget && (
          <Button type="button" size="xs" variant="ghost" onClick={onForget} disabled={forgetting} data-testid="recordings-assistant-forget">
            {t("recordingsUpload.assistant.forget")}
          </Button>
        )}
        <Button type="button" size="xs" variant="outline" onClick={onUndo} data-testid="recordings-assistant-undo">
          {t("recordingsUpload.assistant.undo")}
        </Button>
      </span>
    </div>
  )
  const offerBox = offerFor({ offer, canAsk, exhausted, waiting, state, onAsk, canChoose, infoOpen, toggleInfo, t, locale })
  if (!noteBox) return offerBox
  return <>{noteBox}{offerBox}</>
}

/** The offer, or what became of it: under a team's saved rule, for the names
 *  it left (review, Oct 30). */
function offerFor({ offer, canAsk, exhausted, waiting, state, onAsk, canChoose, infoOpen, toggleInfo, t, locale }: Pick<AssistantProps, "offer" | "canAsk" | "exhausted" | "waiting" | "state" | "onAsk"> & {
  canChoose: boolean
  infoOpen: boolean
  toggleInfo: () => void
  t: ReturnType<typeof useT>
  locale: Parameters<typeof formatNumber>[1]
}) {
  if (offer === 0) return null
  if (!canAsk) {
    if (waiting) return null
    return <p className="border-b bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="recordings-assistant-lead-only">{t("recordingsUpload.assistant.leadOnly")}</p>
  }
  const failedKey = exhausted
    ? (canChoose ? "recordingsUpload.assistant.failedFinalChoose" : "recordingsUpload.assistant.failedFinal")
    : "recordingsUpload.assistant.failed"
  const problemKey = state.kind === "problem"
    ? ({ noFit: canChoose ? "recordingsUpload.assistant.noFitChoose" : "recordingsUpload.assistant.noFit", limit: "recordingsUpload.assistant.limit", unavailable: failedKey, unusable: failedKey, failed: failedKey } as const)[state.problem]
    : null
  const problem = problemKey && <p className="text-amber-700 dark:text-amber-400" role="alert" data-testid="recordings-assistant-problem">{t(problemKey)}</p>
  // After both calls the offer doesn't come back for this folder: only what
  // happened is said.
  if (exhausted) {
    return problem ? <div className="border-b bg-muted/40 p-3 text-xs" data-testid="recordings-assistant">{problem}</div> : null
  }
  return (
    <div className="space-y-1.5 border-b bg-muted/40 p-3 text-xs" data-testid="recordings-assistant">
      <p className="flex items-center gap-1 text-foreground/90">
        {t("recordingsUpload.assistant.offer", { count: formatNumber(offer, locale) })}
        <InfoToggle open={infoOpen} onToggle={toggleInfo} label={t("recordingsUpload.assistant.infoLabel")} controls="recordings-assistant-info" />
      </p>
      <InfoReveal open={infoOpen} id="recordings-assistant-info" className="text-muted-foreground">{t("recordingsUpload.assistant.info")}</InfoReveal>
      {problem}
      <Button type="button" size="xs" variant="outline" onClick={onAsk} disabled={waiting} data-testid="recordings-assistant-ask">
        {t("recordingsUpload.assistant.ask")}
      </Button>
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
