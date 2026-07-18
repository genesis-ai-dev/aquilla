import type { InfractionSpan } from "@/lib/parsers/types"

export const MESSAGE = "Terminal punctuation differs from source"

// Strip trailing whitespace and bidi/format marks before classifying.
const TRAILING_NOISE_RE = /[\s‎‏‪-‮⁦-⁩]+$/

type EndClass = "question" | "exclamation" | "statement" | "none"

const QUESTION_CHARS = new Set(["?", "？", "؟"])
const EXCLAMATION_CHARS = new Set(["!", "！", "¡"])
const STATEMENT_CHARS = new Set([".", "。", "…", "．"])

function classify(text: string): EndClass {
  const trimmed = text.replace(TRAILING_NOISE_RE, "")
  if (trimmed.length === 0) return "none"
  const last = trimmed[trimmed.length - 1]
  if (QUESTION_CHARS.has(last)) return "question"
  if (EXCLAMATION_CHARS.has(last)) return "exclamation"
  if (STATEMENT_CHARS.has(last)) return "statement"
  return "none"
}

export function runCheck(source: string, target: string): InfractionSpan[] | null {
  const sc = classify(source)
  const tc = classify(target)
  if (sc === tc) return null
  if (sc === "none") return null
  const trimmed = target.replace(TRAILING_NOISE_RE, "")
  const end = trimmed.length
  if (tc === "none") {
    return [{
      side: "target",
      start: end,
      end,
      matchedText: "",
    }]
  }
  const start = Math.max(0, end - 1)
  return [{
    side: "target",
    start,
    end,
    matchedText: trimmed.slice(start, end),
  }]
}
