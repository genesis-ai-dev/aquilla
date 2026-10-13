import type { InfractionSpan } from "@/lib/parsers/types"
import type { BuiltinCheckRunContext } from "../builtin-run-context"
import {
  UNIVERSAL_PUNCTUATION,
  type PunctuationConventions,
} from "../../../../db/shared/punctuation-conventions"

export const MESSAGE = "Terminal punctuation differs from source"

// Strip trailing whitespace and bidi/format marks before classifying.
const TRAILING_NOISE_RE = /[\s‎‏‪-‮⁦-⁩]+$/

type EndClass = "question" | "exclamation" | "statement" | "none"

function classify(text: string, marks: PunctuationConventions): EndClass {
  const trimmed = text.replace(TRAILING_NOISE_RE, "")
  if (trimmed.length === 0) return "none"
  const last = trimmed[trimmed.length - 1]
  // Order matters: a mark listed under two classes resolves to the first. The
  // conventions table never lists one twice (punctuation-conventions.ts).
  if (marks.question.includes(last)) return "question"
  if (marks.exclamation.includes(last)) return "exclamation"
  if (marks.statement.includes(last)) return "statement"
  return "none"
}

/**
 * AQU-1906: the SOURCE is classified by the universal marks (its own language
 * is not recorded per cell), the TARGET by the lane's conventions when the
 * caller resolved any. Without conventions both sides use the universal set,
 * which is exactly the behaviour this check had before AQU-1906.
 */
export function runCheck(
  source: string,
  target: string,
  context?: BuiltinCheckRunContext,
): InfractionSpan[] | null {
  const conventions = context?.punctuation ?? null
  const sc = classify(source, UNIVERSAL_PUNCTUATION)
  const tc = classify(target, conventions ?? UNIVERSAL_PUNCTUATION)
  if (sc === tc) return null
  if (sc === "none") return null
  // A language that ends a sentence with no mark (Thai, Lao, Khmer, or a
  // Language profile that says so) answers any source class with nothing.
  if (tc === "none" && conventions?.noTerminalMark) return null
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
