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

function parseCueRange(ts: string): { start: number; end: number } | null {
  const m = ts.match(CUE_RANGE_RE)
  if (!m) return null
  const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
  const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000
  return { start, end }
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
