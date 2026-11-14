// AQU-2204 (Sam, Oct 26): how long a line with NO TIMES lasts on the timeline.
//
// A verse in a book with no source audio and no recording yet has no time of
// its own — but a file that follows its recordings lays its lines back to back,
// and a verse that took no room would make the timeline lie about where the
// next one starts once it IS recorded. So it gets a STAND-IN length, worked out
// from its own words at the language's reading pace, and is drawn dashed with
// no time on it. Recording the verse replaces the stand-in with the take.
//
// The pace (Sam accepted the canvas's recommendation, board 23):
//   - learned from the file's own recorded lines once 3 or more are recorded:
//     their characters per second, so the stand-ins match how this team reads;
//   - before that, a default by script: alphabetic ≈ 14 characters a second,
//     Chinese and Japanese ≈ 5, everything else ≈ 12;
//   - every stand-in kept between 1.5 and 12 seconds.
//
// Pure, and nothing here is stored: the stand-in is re-derived on every layout,
// exactly like the rest of the programme.

import { resolveTargetPieces, sourceClipAudioForCell } from "@/lib/audio/track-audio"
import { hasTiming } from "./derive"
import { effectiveAttachmentDurationMs } from "./lane-timing"
import type { CellData } from "@/hooks/useCells"

export const STAND_IN_MIN_SEC = 1.5
export const STAND_IN_MAX_SEC = 12
/** How many recorded lines it takes before the file's own pace is trusted. */
export const PACE_MIN_RECORDED_LINES = 3

export const PACE_ALPHABETIC_CPS = 14
export const PACE_CJK_CPS = 5
export const PACE_OTHER_CPS = 12

/** Han, kana, and the CJK punctuation/symbol blocks. */
const CJK = /[\u3000-\u303F\u3040-\u30FF\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/u
/** Scripts written letter by letter: Latin, Greek, Cyrillic, Armenian, Georgian. */
const ALPHABETIC = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF\u0370-\u03FF\u0400-\u04FF\u0500-\u052F\u0530-\u058F\u10A0-\u10FF]/u

/**
 * AQU-2204 (board 24): a file has NOTHING TO FOLLOW when none of its lines has
 * times of its own and none has a source recording — a Bible book with no
 * reading. Following the source would leave every line in the Untimed strip,
 * so such a file can only follow its recordings.
 */
export function hasNothingToFollow(cells: readonly CellData[]): boolean {
  if (cells.length === 0) return false
  return cells.every((c) => !hasTiming(c) && sourceClipAudioForCell(c) == null)
}

/** The words a line is read from: its translation, else its source. */
export function standInText(cell: Pick<CellData, "translated" | "original" | "transcription">): string {
  const raw = cell.translated?.trim() || cell.original?.trim() || cell.transcription?.trim() || ""
  // A book lays out every line on open. Most lines are already single-spaced,
  // and rebuilding each one with a regex is a visible stall.
  let pendingSpace = false
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ws = code <= 32 || code === 0x00A0 || code === 0x3000
    if (ws && (pendingSpace || code !== 32)) return raw.replace(/\s+/g, " ")
    pendingSpace = ws
  }
  return raw
}

/** Characters as a reader voices them: code points, spaces between words included. */
function charCount(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDBFF) i++
    n++
  }
  return n
}

/** ASCII and the Latin/Greek/Cyrillic blocks, without a regex per character.
 *  A book is tens of thousands of lines; testing every letter with a unicode
 *  pattern is what stalls the first timeline layout. */
function isAlphabeticCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5A)
    || (code >= 0x61 && code <= 0x7A)
    || (code >= 0xC0 && code <= 0x24F)
    || (code >= 0x1E00 && code <= 0x1EFF)
    || (code >= 0x370 && code <= 0x3FF)
    || (code >= 0x400 && code <= 0x52F)
    || (code >= 0x530 && code <= 0x58F)
    || (code >= 0x10A0 && code <= 0x10FF)
}

function isCjkCode(code: number): boolean {
  return (code >= 0x3000 && code <= 0x303F)
    || (code >= 0x3040 && code <= 0x30FF)
    || (code >= 0x31F0 && code <= 0x31FF)
    || (code >= 0x3400 && code <= 0x4DBF)
    || (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0xF900 && code <= 0xFAFF)
    || (code >= 0xFF00 && code <= 0xFFEF)
}

/** The default reading pace for a text, by the script most of it is written in. */
export function defaultPaceCps(text: string): number {
  let cjk = 0
  let alpha = 0
  let other = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code <= 32 || code === 0x00A0) continue
    if (code >= 0xD800 && code <= 0xDBFF) {
      const ch = text[i] + (text[i + 1] ?? "")
      i++
      if (CJK.test(ch)) cjk++
      else if (ALPHABETIC.test(ch)) alpha++
      else if (/\p{L}/u.test(ch)) other++
      continue
    }
    if (code < 0x80) {
      if ((code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)) alpha++
      continue
    }
    if (isCjkCode(code)) cjk++
    else if (isAlphabeticCode(code)) alpha++
    else if (/\p{L}/u.test(text[i])) other++
  }
  if (cjk === 0 && alpha === 0 && other === 0) return PACE_ALPHABETIC_CPS
  if (cjk >= alpha && cjk >= other) return PACE_CJK_CPS
  if (alpha >= other) return PACE_ALPHABETIC_CPS
  return PACE_OTHER_CPS
}

/** A recorded line's playable length in seconds, or null when it has none. */
function recordedLenSec(cell: CellData): number | null {
  const pieces = resolveTargetPieces(cell)
  if (pieces.length === 0) return null
  let totalMs = 0
  for (const p of pieces) {
    const ms = effectiveAttachmentDurationMs(cell.attachments?.[p.audioId])
    if (ms == null) return null
    totalMs += ms
  }
  return totalMs > 0 ? totalMs / 1000 : null
}

/**
 * The file's own reading pace, in characters per second, from its recorded
 * lines — or null until at least `PACE_MIN_RECORDED_LINES` have a recording
 * of known length and words to measure it against.
 */
export function learnedPaceCps(cells: readonly CellData[]): number | null {
  let chars = 0
  let sec = 0
  let lines = 0
  for (const cell of cells) {
    const len = recordedLenSec(cell)
    if (len == null) continue
    const n = charCount(standInText(cell))
    if (n === 0) continue
    chars += n
    sec += len
    lines++
  }
  if (lines < PACE_MIN_RECORDED_LINES || sec <= 0) return null
  return chars / sec
}

/** A stand-in length for `text` at `paceCps`, kept between 1.5 and 12 s. */
export function standInLenSec(text: string, paceCps: number): number {
  const pace = Number.isFinite(paceCps) && paceCps > 0 ? paceCps : PACE_ALPHABETIC_CPS
  const raw = charCount(text) / pace
  return Math.min(STAND_IN_MAX_SEC, Math.max(STAND_IN_MIN_SEC, raw))
}

/**
 * One estimator for a file: the learned pace when there is one, else each
 * line's script default. What `buildProgramme` calls for a line with no times.
 */
export function standInEstimator(cells: readonly CellData[]): (cell: CellData) => number {
  const learned = learnedPaceCps(cells)
  return (cell) => {
    const text = standInText(cell)
    return standInLenSec(text, learned ?? defaultPaceCps(text))
  }
}
