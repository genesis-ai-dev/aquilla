import { v4 as uuid } from "uuid"

const BREAK_PATTERNS: RegExp[] = [
  /\n\n+/,                  // paragraph
  /\n/,                     // line
  /(?<=[.!?])\s+/,          // sentence
  /(?<=[;:])\s+/,           // clause
  /,\s+/,                   // comma
  /\s*[—–]\s*|\s+-\s+/,    // dash
  /\s+/,                    // word
]

export function splitIntoSegments(
  text: string,
  maxLength = 200
): { text: string; group: string }[] {
  const group = uuid()

  if (text.length <= maxLength) {
    return [{ text, group }]
  }

  return recursiveSplit(text, maxLength, 0).map((t) => ({ text: t, group }))
}

function recursiveSplit(text: string, maxLength: number, level: number): string[] {
  if (text.length <= maxLength || level >= BREAK_PATTERNS.length) {
    return [text]
  }

  const parts = text.split(BREAK_PATTERNS[level]).filter((p) => p.trim().length > 0)

  if (parts.length <= 1) {
    return recursiveSplit(text, maxLength, level + 1)
  }

  const merged: string[] = []
  let current = parts[0]

  for (let i = 1; i < parts.length; i++) {
    const combined = current + " " + parts[i]
    if (combined.length <= maxLength) {
      current = combined
    } else {
      merged.push(current)
      current = parts[i]
    }
  }
  merged.push(current)

  return merged.flatMap((chunk) =>
    chunk.length > maxLength ? recursiveSplit(chunk, maxLength, level + 1) : [chunk]
  )
}

export function mergeSegments(segments: { text: string; group: string }[]): string {
  return segments.map((s) => s.text).join(" ")
}
