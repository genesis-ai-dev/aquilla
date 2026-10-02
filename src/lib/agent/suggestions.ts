/**
 * suggestions.ts — parse the agent's trailing "NEXT:" lines into tappable
 * next-step suggestions.
 *
 * The server prompt (auth-worker schema-card "Suggested next steps") asks the
 * model to end its final reply with one or two closing lines of the exact form
 * `NEXT: <short imperative action>`. The client strips those lines from the
 * displayed prose and renders them as buttons that send the text back as the
 * next user message. Parsing is display-side only — the wire keeps the raw
 * text, so stored sessions and follow-up context are unaffected.
 */

export interface ParsedSuggestions {
  /** The prose with trailing NEXT lines (and any partial marker) removed. */
  body: string
  /** Suggestion texts in reading order. */
  suggestions: string[]
}

const NEXT_LINE = /^NEXT:\s*(.*)$/
/** A streaming tail that is a prefix of "NEXT:" — stripped, never shown. */
const PARTIAL_MARKER = /^N(E(X(T:?)?)?)?$/

export function splitNextSteps(text: string): ParsedSuggestions {
  const lines = text.split("\n")
  const suggestions: string[] = []
  let end = lines.length
  let sawContent = false
  while (end > 0) {
    const line = lines[end - 1].trim()
    if (line === "") {
      end--
      continue
    }
    const match = NEXT_LINE.exec(line)
    if (match) {
      // An empty capture is a marker still streaming — strip, don't suggest.
      if (match[1].trim()) suggestions.unshift(match[1].trim())
      end--
      sawContent = true
      continue
    }
    if (PARTIAL_MARKER.test(line) && !sawContent) {
      end--
      continue
    }
    break
  }
  if (end === lines.length) return { body: text, suggestions }
  return { body: lines.slice(0, end).join("\n").trimEnd(), suggestions }
}
