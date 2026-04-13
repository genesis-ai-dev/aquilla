import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./types"

const TIMESTAMP_VTT = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/
const TIMESTAMP_SRT = /^\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/

export function extractVttStrings(content: string): TranslatableString[] {
  const lines = content.split("\n")
  const results: TranslatableString[] = []
  let currentTimestamp = ""
  let currentText: string[] = []

  function flush() {
    if (currentTimestamp && currentText.length > 0) {
      const text = currentText.join("\n")
      results.push({
        id: uuid(),
        original: text,
        translated: text,
        context: currentTimestamp,
        group: uuid(),
        type: "cue",
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
      results.push({
        id: uuid(),
        original: text,
        translated: text,
        context: currentTimestamp,
        group: uuid(),
        type: "cue",
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
