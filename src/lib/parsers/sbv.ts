import { v4 as uuid } from "uuid"
import type { TranslatableString } from "./core-types"

/** YouTube SBV subtitle importer.
 *
 * Format: cue blocks separated by blank lines. The first line of a block is a
 * timecode `H:MM:SS.mmm,H:MM:SS.mmm` (hours may be one or more digits, unlike
 * VTT/SRT); the remaining lines are the cue text. Malformed blocks (no valid
 * timecode, or no text) are skipped silently.
 *
 * start/end are emitted in fractional seconds (e.g. `1:02:03.450` → 3723.45),
 * the same convention as `extractVttStrings` in subtitle.ts.
 */

const SBV_TIMECODE_RE = /^(\d+):(\d{2}):(\d{2})\.(\d{3}),(\d+):(\d{2}):(\d{2})\.(\d{3})$/

function parseSbvTimecode(line: string): { start: number; end: number } | null {
  const m = line.match(SBV_TIMECODE_RE)
  if (!m) return null
  const start = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
  const end = Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000
  return { start, end }
}

export function extractSbvStrings(content: string): TranslatableString[] {
  const lines = content.split(/\r\n|\r|\n/)
  const results: TranslatableString[] = []
  let i = 0
  while (i < lines.length) {
    // Skip blank separator lines between blocks.
    while (i < lines.length && lines[i].trim() === "") i++
    // Collect one contiguous block.
    const block: string[] = []
    while (i < lines.length && lines[i].trim() !== "") {
      block.push(lines[i].trim())
      i++
    }
    if (block.length === 0) continue
    const range = parseSbvTimecode(block[0])
    const text = block.slice(1).join("\n")
    if (!range || text === "") continue // malformed block — skip silently
    results.push({
      id: uuid(),
      original: text,
      translated: "",
      context: block[0],
      group: uuid(),
      type: "cue",
      start: range.start,
      end: range.end,
    })
  }
  return results
}
