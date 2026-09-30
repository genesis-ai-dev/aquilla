import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./core-types"
// Relative on purpose: this module is part of the worker-safe parse core,
// which the sync-worker imports directly — the `@/` alias only exists in the
// SPA's tsconfig/vite config.
import { extractVoiceLabel } from "../export/vtt-voice"

const TIMESTAMP_VTT = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/
const TIMESTAMP_SRT = /^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/

const CUE_RANGE_RE =
  /(\d{2}):(\d{2}):(\d{2})[.,](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/

/** Parse a `HH:MM:SS.mmm --> HH:MM:SS.mmm` cue range (VTT `.` or SRT `,`
 *  fractions) into seconds. Exported so the file-scoped target import can
 *  recover a cue's timings from its timecode label — see
 *  `matchTargetRowsByOverlap` in `lib/import-file-target.ts` (AQU-1143). */
export function parseCueRange(ts: string): { start: number; end: number } | null {
  const m = ts.match(CUE_RANGE_RE)
  if (!m) return null
  const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
  const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000
  return { start, end }
}

/** Anything shaped like a cue's timestamp line, however malformed — the
 *  denominator for a caller's "how many cues did the parser refuse" report.
 *  Deliberately looser than `TIMESTAMP_VTT`: its whole job is to notice the
 *  lines that matcher turns away. */
const LOOSE_CUE_LINE = /^[\d:.,]+\s*-->\s*[\d:.,]+/

/** A single VTT timestamp, with the hours field optional and either field
 *  allowed to be a single digit (`1:03.209`, `01:03.209`, `0:01:03.209`). */
const SHORT_FORM_TIMESTAMP = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\.(\d{3})$/

/** Pad one timestamp to the strict `HH:MM:SS.mmm` the parser demands. Returns
 *  the token untouched when it is already strict or isn't a timestamp at all
 *  (cue settings like `align:start` ride along on the same line). */
function padTimestamp(token: string): string {
  const m = token.match(SHORT_FORM_TIMESTAMP)
  if (!m) return token
  const [, hours, minutes, seconds, millis] = m
  return `${(hours ?? "00").padStart(2, "0")}:${minutes.padStart(2, "0")}:${seconds}.${millis}`
}

/** Rewrite a cue's timestamp line. `repaired` reports whether a TIMESTAMP
 *  actually changed — not whether the line's text did, so re-spacing an
 *  already-strict line is never miscounted as a rescue. */
function repairTimestampLine(line: string): { text: string; repaired: boolean } {
  const arrow = line.indexOf("-->")
  if (arrow < 0) return { text: line, repaired: false }
  const start = line.slice(0, arrow).trim()
  const tail = line.slice(arrow + 3).trim()
  // The end timestamp is the first token after the arrow; anything after it is
  // cue settings (`align:start position:10%`), which must survive verbatim.
  const [end = "", ...settings] = tail.split(/\s+/)
  const paddedStart = padTimestamp(start)
  const paddedEnd = padTimestamp(end)
  return {
    text: [`${paddedStart} --> ${paddedEnd}`, ...settings].join(" "),
    repaired: paddedStart !== start || paddedEnd !== end,
  }
}

export interface RepairedCueTimestamps {
  /** The content with every short-form cue timestamp padded. */
  text: string
  /** Lines that look like a cue timestamp line, however malformed — the
   *  denominator a caller compares its cue count against. */
  cueLines: number
  /** How many of those had a timestamp actually rewritten. */
  repaired: number
}

/**
 * Pad every short-form cue timestamp (`01:03.209 --> 01:03.667`, which WebVTT
 * permits) to the strict `HH:MM:SS.mmm` `extractVttStrings` demands.
 *
 * That strictness is load-bearing for real subtitle imports, so a caller that
 * must tolerate short-form repairs the TEXT on the way in rather than
 * loosening the matcher. Skipping this is silent loss, not an untimed row: an
 * unmatched timestamp line never opens a cue, so the payload lines after it
 * are swallowed as junk and the cue disappears WITH ITS WORDS. Every consumer
 * that aligns cues positionally then shifts each later cue onto the wrong
 * partner, which no count downstream can detect.
 */
export function repairShortFormCueTimestamps(content: string): RepairedCueTimestamps {
  let cueLines = 0
  let repaired = 0
  const text = content
    .split("\n")
    .map((line) => {
      const trimmed = line.trim()
      if (!LOOSE_CUE_LINE.test(trimmed)) return line
      cueLines++
      const result = repairTimestampLine(trimmed)
      if (result.repaired) repaired++
      return result.text
    })
    .join("\n")
  return { text, cueLines, repaired }
}

export function extractVttStrings(content: string): TranslatableString[] {
  const lines = content.split("\n")
  const results: TranslatableString[] = []
  let currentTimestamp = ""
  let currentText: string[] = []

  function flush() {
    if (currentTimestamp && currentText.length > 0) {
      const joined = currentText.join("\n")
      const { speaker, text } = extractVoiceLabel(joined)
      const range = parseCueRange(currentTimestamp)
      results.push({
        id: uuid(),
        original: text,
        translated: "",
        context: currentTimestamp,
        group: uuid(),
        type: "cue",
        ...(range ? { start: range.start, end: range.end } : {}),
        ...(speaker ? { speaker } : {}),
      })
    }
    currentTimestamp = ""
    currentText = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (TIMESTAMP_VTT.test(trimmed)) {
      flush()
      currentTimestamp = trimmed
      continue
    }

    if (trimmed === "" || trimmed === "WEBVTT" || trimmed.startsWith("NOTE")) {
      if (currentTimestamp) flush()
      continue
    }

    if (currentTimestamp) {
      currentText.push(trimmed)
    }
  }

  flush()
  return results
}

export function extractSrtStrings(content: string): TranslatableString[] {
  const lines = content.split("\n")
  const results: TranslatableString[] = []
  let currentTimestamp = ""
  let currentText: string[] = []

  function flush() {
    if (currentTimestamp && currentText.length > 0) {
      const text = currentText.join("\n")
      const range = parseCueRange(currentTimestamp)
      results.push({
        id: uuid(),
        original: text,
        translated: "",
        context: currentTimestamp,
        group: uuid(),
        type: "cue",
        ...(range ? { start: range.start, end: range.end } : {}),
      })
    }
    currentTimestamp = ""
    currentText = []
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (TIMESTAMP_SRT.test(trimmed)) {
      flush()
      currentTimestamp = trimmed
      continue
    }

    if (trimmed === "" && currentTimestamp) {
      flush()
      continue
    }

    if (/^\d+$/.test(trimmed) && !currentTimestamp) {
      continue
    }

    if (currentTimestamp) {
      currentText.push(trimmed)
    }
  }

  flush()
  return results
}
