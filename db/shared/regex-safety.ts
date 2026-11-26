/**
 * Catastrophic-backtracking (ReDoS) screen for user-authored regular
 * expressions, shared by the browser and the workers.
 *
 * JavaScript's regex engine backtracks, and a Worker has no way to interrupt a
 * running `RegExp#exec`: one pattern such as `(?:a|a)+$` or `((a+))+$` against
 * a 30-character cell burns tens of seconds of CPU. Patterns reach `new RegExp`
 * from the search dock's regexp mode (sync-worker pattern scan over up to 80k
 * rows) and from project / org lint rules (auth-worker agent staging, and every
 * collaborator's editor).
 *
 * This is a linear-time structural check, not a proof. It rejects the shapes
 * that go exponential:
 *
 *   - a group that itself repeats something, repeated again without a small
 *     bound: `(a+)+`, `((a+))*`, `(a{1,})+`, `(.*a){2,}`, `(x+){50}`;
 *   - a repeated group whose alternatives can start on the same character:
 *     `(a|a)+`, `(a|ab)*`, `(\w|\s)+`.
 *
 * A repeat bounded by {@link MAX_SAFE_GROUP_REPEAT} or fewer is allowed — the
 * terminology matcher's affix groups (`(?:…|…){0,4}`) are exactly that shape
 * and stay polynomial with a tiny exponent. `(foo|bar)+`, `\w+\s+\w+` and other
 * everyday find patterns pass.
 */

/** A group repeated at most this many times is not treated as catastrophic. */
export const MAX_SAFE_GROUP_REPEAT = 10

interface Quantifier {
  /** Characters the quantifier occupies, including a trailing lazy `?`. */
  length: number
  /** Upper bound; Infinity for `*`, `+`, `{n,}`. */
  max: number
}

interface Frame {
  /** Something inside this group repeats (more than once). */
  repeats: boolean
  /** Finished alternatives; null marks one that is not a plain literal. */
  alts: Array<string | null>
  /** The alternative being read; null once it stops being a plain literal. */
  current: string | null
}

const CLASS_ESCAPES = new Set(["d", "D", "w", "W", "s", "S", "b", "B", "p", "P", "k"])

function readQuantifier(pattern: string, i: number): Quantifier | null {
  const ch = pattern[i]
  let q: Quantifier | null = null
  if (ch === "*") q = { length: 1, max: Infinity }
  else if (ch === "+") q = { length: 1, max: Infinity }
  else if (ch === "?") q = { length: 1, max: 1 }
  else if (ch === "{") {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i, i + 24))
    if (!m) return null
    const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3])
    q = { length: m[0].length, max }
  }
  if (q && pattern[i + q.length] === "?") q.length += 1
  return q
}

function altsOverlap(alts: Array<string | null>): boolean {
  if (alts.length < 2) return false
  const firsts = new Set<string>()
  for (const alt of alts) {
    // A non-literal or empty alternative could match what a sibling matches.
    if (alt === null || alt === "") return true
    const first = alt[0].toLowerCase()
    if (firsts.has(first)) return true
    firsts.add(first)
  }
  return false
}

/**
 * Why `pattern` is likely to backtrack catastrophically, or null when it passes
 * the screen. Call it before compiling a pattern a user (or an agent) wrote.
 */
export function catastrophicPatternReason(pattern: string): string | null {
  const stack: Frame[] = [{ repeats: false, alts: [], current: "" }]
  const top = () => stack[stack.length - 1]
  const breakLiteral = () => {
    top().current = null
  }
  const addLiteral = (ch: string) => {
    const f = top()
    if (f.current !== null) f.current += ch
  }
  /** Apply the quantifier at `i` (if any) to the atom just read; returns chars consumed. */
  const quantify = (i: number): number => {
    const q = readQuantifier(pattern, i)
    if (!q) return 0
    if (q.max > 1) top().repeats = true
    breakLiteral()
    return q.length
  }

  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === "\\") {
      const next = pattern[i + 1] ?? ""
      let len = 2
      if ((next === "p" || next === "P" || next === "k") && pattern[i + 2] === "{") {
        const close = pattern.indexOf("}", i + 3)
        len = close < 0 ? pattern.length - i : close - i + 1
      } else if (next === "k" && pattern[i + 2] === "<") {
        const close = pattern.indexOf(">", i + 3)
        len = close < 0 ? pattern.length - i : close - i + 1
      }
      if (CLASS_ESCAPES.has(next) || /[0-9]/.test(next)) breakLiteral()
      else addLiteral(next)
      i += len
      i += quantify(i)
      continue
    }
    if (ch === "[") {
      let j = i + 1
      if (pattern[j] === "^") j++
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1
      breakLiteral()
      i = j + 1
      i += quantify(i)
      continue
    }
    if (ch === "(") {
      stack.push({ repeats: false, alts: [], current: "" })
      i += 1
      if (pattern[i] === "?") {
        // (?:  (?=  (?!  (?<=  (?<!  (?<name>
        if (pattern[i + 1] === "<" && pattern[i + 2] !== "=" && pattern[i + 2] !== "!") {
          const close = pattern.indexOf(">", i)
          i = close < 0 ? pattern.length : close + 1
        } else {
          i += pattern[i + 1] === "<" ? 3 : 2
        }
      }
      continue
    }
    if (ch === ")") {
      if (stack.length === 1) {
        i += 1 // unbalanced; RegExp itself will reject it
        continue
      }
      const group = stack.pop() as Frame
      group.alts.push(group.current)
      const q = readQuantifier(pattern, i + 1)
      if (q && q.max > MAX_SAFE_GROUP_REPEAT) {
        if (group.repeats) return "nested repetition, e.g. (a+)+, can take too long to run"
        if (altsOverlap(group.alts)) {
          return "a repeated group whose alternatives can match the same text, e.g. (a|ab)+, can take too long to run"
        }
      }
      const parent = top()
      if (group.repeats || (q && q.max > 1)) parent.repeats = true
      parent.current = null
      i += 1 + (q?.length ?? 0)
      continue
    }
    if (ch === "|") {
      const f = top()
      f.alts.push(f.current)
      f.current = ""
      i += 1
      continue
    }
    if (ch === "." || ch === "^" || ch === "$") {
      breakLiteral()
      i += 1
      i += quantify(i)
      continue
    }
    addLiteral(ch)
    i += 1
    i += quantify(i)
  }
  return null
}
