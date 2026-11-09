// AQU-2426 × AQU-2375: one line's words, as a run that outlives the page.
//
// Import and transcribe… and Split into lines… › At sentences, with words both
// transcribe one recording line's whole stretch, then cut it at sentence ends
// and real pauses. On a 52-minute recording that is about 52 hosted requests
// over several minutes, so it follows AQU-2375's rules for any transcription
// run (transcribe-runs.ts):
//
//   • The stretch is cut into windows of at most a minute — one hosted request
//     each, cut at the quietest moment near the minute so no word is split —
//     and each window's words are kept as they land. A reload or a failed
//     window never costs the words already paid for.
//   • A reload part-way: the workspace that opens the line's file next carries
//     the run on by itself (useCarryOnTranscribeRuns), from the windows still
//     to do.
//   • Some windows failed: the line is NOT split. It stays whole, keeps the
//     words it has, and the run is parked; Retry (or the next words run on the
//     same stretch) sends only the windows still without words.

import type { FrontierSession } from "@/lib/frontier/types"
import { windowStarts } from "./asr-windows"
import { joinWords, type TimedWord } from "./lines-from-words"
import { loadLinePcm, PCM_RATE, transcribeLineWords, type LineAudio } from "./recording-split"
import {
  claimStoredTranscribeRun,
  findLineWordsRun,
  lineWindowKey,
  startStoredTranscribeRun,
  type StoredLineWords,
  type StoredTranscribeRun,
  type TranscribeRunHandle,
  pageIsLeaving,
} from "./transcribe-runs"

/** The most audio one window carries: one hosted request (Whisper, Qwen). */
export const LINE_WINDOW_SEC = 60
/** This many windows failing in a row stops the run: the rest would fail the
 *  same way (no credits, the service down), and each one is a request. */
export const STOP_AFTER_FAILURES = 2

/** Which line the run is for, so its words can be kept and found again. */
export interface LineWordsIdentity {
  cellId: string
  audioId: string
  /** Names the run in the toasts: the recording's or the line's name. */
  name: string
}

export interface LineWordsReport {
  /** Windows in all, and how many have words. */
  total: number
  done: number
  /** Windows without words, with why (a window never sent says why not). */
  failed: Array<{ key: string; message: string }>
  /** Every word that landed, seconds from the line's start, in order. */
  words: TimedWord[]
  text: string
  /** The kept run; null when there is nothing to keep it under. */
  runId: string | null
  /** The page went away mid-run (a reload): nothing failed, and the run is
   *  left as it is for the next page to carry on. Callers neither park it
   *  nor say anything. */
  interrupted?: boolean
}

export interface LineWordsRun {
  report: LineWordsReport
  /** The caller ends the run (`end`) once the words are used, or parks it. */
  handle: TranscribeRunHandle | null
}

/** Windows of at most a minute over the stretch, ms on the recording's clock. */
export function planLineWindows(pcm: Float32Array, audio: Pick<LineAudio, "lo" | "hi">): Array<{ lo: number; hi: number }> {
  const starts = windowStarts(pcm, LINE_WINDOW_SEC, true)
  return starts.map((s, i) => ({
    lo: i === 0 ? audio.lo : audio.lo + Math.round((s / PCM_RATE) * 1000),
    hi: i === starts.length - 1 ? audio.hi : audio.lo + Math.round((starts[i + 1]! / PCM_RATE) * 1000),
  }))
}

/** Every kept window's words, in order, as one list and one text. */
export function wordsOf(line: StoredLineWords): { words: TimedWord[]; text: string } {
  const words: TimedWord[] = []
  const texts: string[] = []
  line.windows.forEach((_, i) => {
    const got = line.words[lineWindowKey(i)]
    if (!got) return
    words.push(...got.words)
    if (got.text.trim()) texts.push(got.text.trim())
  })
  return { words, text: texts.length ? joinWords(texts.map((text) => ({ text }))) : "" }
}

export interface RunLineWordsArgs {
  audio: LineAudio
  session: FrontierSession | null
  languageTag?: string
  purpose: StoredLineWords["purpose"]
  /** The line, to keep the run under. Absent: the run is not kept. */
  identity?: LineWordsIdentity
  /** A run a reload stopped, already claimed by this page. */
  carryOn?: { stored: StoredTranscribeRun; handle: TranscribeRunHandle }
  /** Windows with words so far, of how many. Called once before the first
   *  request, then after each window. */
  onProgress?: (done: number, total: number) => void
  /** The hosted limit refused a request: wait this long, then it is sent again. */
  onRateLimited?: (retryAfterSeconds: number) => Promise<void>
  /** @internal test seams. */
  deps?: {
    transcribe?: typeof transcribeLineWords
    loadPcm?: typeof loadLinePcm
    newId?: () => string
  }
}

function newRunId(): string {
  return `words-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
}

/**
 * Transcribe a line's stretch window by window, keeping each window's words.
 * Picks up a kept run on the same stretch (parked, or stopped by a reload) and
 * sends only the windows still without words.
 */
export async function runLineWords(args: RunLineWordsArgs): Promise<LineWordsRun> {
  const transcribe = args.deps?.transcribe ?? transcribeLineWords
  const loadPcm = args.deps?.loadPcm ?? loadLinePcm
  const { audio } = args

  let stored = args.carryOn?.stored ?? null
  let handle = args.carryOn?.handle ?? null
  if (!stored && args.identity) {
    const kept = findLineWordsRun({
      projectId: audio.projectId, fileId: audio.fileId,
      cellId: args.identity.cellId, audioId: args.identity.audioId, lo: audio.lo, hi: audio.hi,
    })
    if (kept) {
      // Another page still running it gets null: this run starts afresh.
      const claimed = await claimStoredTranscribeRun(kept.id)
      if (claimed) {
        stored = kept
        handle = claimed
      }
    }
  }

  let line: StoredLineWords
  if (stored?.line) {
    line = { ...stored.line, words: { ...stored.line.words } }
  } else {
    const pcm = await loadPcm(audio, args.session)
    line = {
      cellId: args.identity?.cellId ?? "",
      audioId: args.identity?.audioId ?? "",
      url: audio.url,
      lo: audio.lo,
      hi: audio.hi,
      windows: planLineWindows(pcm, audio),
      words: {},
      ...(args.languageTag ? { languageTag: args.languageTag } : {}),
      purpose: args.purpose,
    }
    if (args.identity) {
      handle = startStoredTranscribeRun({
        id: args.deps?.newId?.() ?? newRunId(),
        projectId: audio.projectId,
        fileId: audio.fileId,
        fileName: args.identity.name,
        kind: "lineWords",
        cellIds: line.windows.map((_, i) => lineWindowKey(i)),
        force: false,
        line,
      })
    }
  }

  const total = line.windows.length
  const failed: LineWordsReport["failed"] = []
  const doneCount = () => Object.keys(line.words).length
  args.onProgress?.(doneCount(), total)
  const tag = line.languageTag ?? args.languageTag
  let inARow = 0
  let stopReason: string | null = null
  let interrupted = false
  for (let i = 0; i < total; i++) {
    const key = lineWindowKey(i)
    if (line.words[key]) continue
    if (stopReason !== null) {
      failed.push({ key, message: stopReason })
      continue
    }
    const win = line.windows[i]!
    try {
      const got = await transcribe({
        line: { ...audio, lo: win.lo, hi: win.hi },
        session: args.session,
        ...(tag ? { languageTag: tag } : {}),
        ...(args.onRateLimited ? { onRateLimited: args.onRateLimited } : {}),
      })
      // The window's words are from ITS start; the line's are from the line's.
      const shift = (win.lo - audio.lo) / 1000
      const words = got.words.map((w) => ({ text: w.text, start: w.start + shift, end: w.end + shift }))
      line.words[key] = { words, text: got.text }
      handle?.row(key, { kind: "done", lineWords: { words, text: got.text } })
      inARow = 0
    } catch (err) {
      // A request cut off because the page is going: not a failed minute.
      if (pageIsLeaving()) {
        interrupted = true
        break
      }
      const message = err instanceof Error ? err.message : String(err)
      failed.push({ key, message })
      handle?.row(key, { kind: "failed", message })
      if (++inARow >= STOP_AFTER_FAILURES) stopReason = message
    }
    args.onProgress?.(doneCount(), total)
  }

  const all = wordsOf(line)
  return {
    report: {
      total, done: doneCount(), failed, words: all.words, text: all.text, runId: handle?.id ?? null,
      ...(interrupted ? { interrupted: true } : {}),
    },
    handle,
  }
}
