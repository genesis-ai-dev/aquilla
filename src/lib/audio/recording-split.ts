// AQU-2426: where a line of source audio splits (board 58, Split into lines…).
//
//   • At pauses — free, no AI, in the browser: the same speech detection the
//     import has always used (silence-split.ts), on the line's own stretch of
//     the recording. A cut falls where the next stretch of speech starts, so
//     the silence after a line stays with it ("cuts, not deletions").
//   • At sentences, with words — transcribes the line first (one request a
//     minute, hosted or on this device), then cuts at sentence ends and real
//     pauses (lines-from-words.ts) and gives each new line its words.
//
// Both read the line's stretch as 16 kHz mono PCM once: the clip is held for
// a minute after (shared-clip-pcm.ts), so the dialog's preview, the cuts and
// a transcription right after share one decode.

import type { FrontierSession } from "@/lib/frontier/types"
import { detectSpeechSegments } from "@/lib/timeline/silence-split"
import { loadTranscriptCorrections } from "@/lib/store/transcript-corrections-store"
import { decodeSharedClipPcm } from "./shared-clip-decode"
import { sharedClipWindow } from "./shared-clip-pcm"
import { audioBytesToWhisperPcm, readClipBytes, transcribeAudio, type TranscriptionResult } from "./transcribe"
import { applyCorrections } from "./transcript-corrections"
import { linesFromWords, type TimedWord, type WordLine } from "./lines-from-words"
import { parseFrontierAudioUrl } from "./upload"
import { whisperLanguageFromTag } from "./language"

export const PCM_RATE = 16_000

/** A line's stretch of its recording, as the split reads it. */
export interface LineAudio {
  projectId: string
  fileId: string
  /** The recording's frontier-audio:// address. */
  url: string
  /** Its stretch, ms on the recording's clock. */
  lo: number
  hi: number
}

function clipKey(url: string): { key: string; audioId: string; ext: string } | null {
  const parsed = parseFrontierAudioUrl(url)
  return parsed ? { key: `${parsed.audioId}.${parsed.ext}`, ...parsed } : null
}

/** Whether a line's recording can be read to split it (an upload, not a link). */
export function canReadLineAudio(url: string | undefined | null): boolean {
  return Boolean(url && clipKey(url))
}

/** The line's stretch as 16 kHz mono PCM. */
export async function loadLinePcm(line: LineAudio, session: FrontierSession | null): Promise<Float32Array> {
  const clip = clipKey(line.url)
  if (!clip) throw new Error("This recording can't be read here.")
  return sharedClipWindow(
    clip.key,
    { trimStartMs: line.lo, trimEndMs: line.hi },
    () => readClipBytes({ projectId: line.projectId, fileId: line.fileId, audioId: clip.audioId, ext: clip.ext, session }),
    (whole) => decodeSharedClipPcm(whole, (bytes) => audioBytesToWhisperPcm(bytes)),
  )
}

/** Cuts at pauses, ms on the recording's clock (the line starts at `lo`). */
export function pauseCuts(pcm: Float32Array, lo: number): number[] {
  const segments = detectSpeechSegments(pcm, PCM_RATE)
  return segments.slice(1).map((s) => lo + s.startMs)
}

/** Peaks for a waveform preview: `n` columns of the loudest sample, 0..1. */
export function previewPeaks(pcm: Float32Array, n: number): number[] {
  const out = new Array<number>(Math.max(0, n)).fill(0)
  if (pcm.length === 0 || n <= 0) return out
  const per = pcm.length / n
  let max = 0
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * per)
    const b = Math.max(a + 1, Math.floor((i + 1) * per))
    let peak = 0
    for (let j = a; j < b && j < pcm.length; j++) {
      const v = Math.abs(pcm[j])
      if (v > peak) peak = v
    }
    out[i] = peak
    if (peak > max) max = peak
  }
  return max > 0 ? out.map((v) => v / max) : out
}

export interface WordsResult {
  words: TimedWord[]
  text: string
  model?: string
}

/**
 * Transcribe the line's stretch with word times (seconds from the line's
 * start). Learned corrections are replayed as transcription does elsewhere.
 */
export async function transcribeLineWords(args: {
  line: LineAudio
  session: FrontierSession | null
  /** The source language's tag. */
  languageTag?: string
  /** The hosted limit refused a request: wait this long, then it is sent again. */
  onRateLimited?: (retryAfterSeconds: number) => Promise<void>
}): Promise<WordsResult> {
  const clip = clipKey(args.line.url)
  if (!clip) throw new Error("This recording can't be read here.")
  const { line, session } = args
  const raw: TranscriptionResult = await transcribeAudio(new Uint8Array(0), {
    session,
    projectId: line.projectId,
    language: whisperLanguageFromTag(args.languageTag) ?? undefined,
    ...(args.languageTag ? { languageTag: args.languageTag } : {}),
    trim: { trimStartMs: line.lo, trimEndMs: line.hi },
    sharedClipKey: clip.key,
    loadClipBytes: () => readClipBytes({ projectId: line.projectId, fileId: line.fileId, audioId: clip.audioId, ext: clip.ext, session }),
    ...(args.onRateLimited ? { onRateLimited: args.onRateLimited } : {}),
  })
  const learned = loadTranscriptCorrections(line.projectId)
  const fix = (s: string) => (learned.length ? applyCorrections(s, learned) : s)
  return {
    words: raw.chunks.map((c) => ({ text: fix(c.text), start: c.start, end: c.end })),
    text: fix(raw.text),
    ...(raw.model ? { model: raw.model } : {}),
  }
}

/** The lines words make over a line's stretch: cuts on the recording's clock and each line's text. */
export function cutsFromWords(words: readonly TimedWord[], line: Pick<LineAudio, "lo" | "hi">): {
  lines: WordLine[]
  cuts: number[]
  texts: string[]
} {
  const lines = linesFromWords(words, (line.hi - line.lo) / 1000)
  return {
    lines,
    cuts: lines.slice(1).map((l) => Math.round(line.lo + l.startSec * 1000)),
    texts: lines.map((l) => l.text),
  }
}
