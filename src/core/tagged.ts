/**
 * Inline-tag notation shared by every adapter and translator.
 *
 *   <gN>…</gN>  a formatting run (bold span, link text, InDesign character range…)
 *   <xN/>       a protected inline object (variable, anchored frame, code span…)
 *
 * Everything else is literal text. Translators must return every <xN/> exactly
 * once and only <gN> ids that exist in the source; runs may move, nest, or be
 * dropped. Adapters decide how faithfully a reordered run can be written back.
 */
import type { Diagnostic } from "./types.ts"

export type Piece =
  | { readonly kind: "text"; readonly text: string; readonly runs: readonly number[] }
  | { readonly kind: "open"; readonly id: number }
  | { readonly kind: "close"; readonly id: number }
  | { readonly kind: "token"; readonly id: number }

const TAG = /<(\/?)g(\d+)>|<x(\d+)\/>/g

export const hasTagLikeText = (text: string): boolean => /<\/?g\d+>|<x\d+\/>/.test(text)

/** Tokenize tagged text. Never throws; structural problems are reported by validateTagged. */
export const parseTagged = (s: string): Piece[] => {
  const pieces: Piece[] = []
  const stack: number[] = []
  let last = 0
  const pushText = (text: string): void => {
    if (text.length > 0) pieces.push({ kind: "text", text, runs: [...stack] })
  }
  for (const m of s.matchAll(TAG)) {
    pushText(s.slice(last, m.index))
    last = m.index + m[0].length
    if (m[3] !== undefined) {
      pieces.push({ kind: "token", id: Number(m[3]) })
    } else if (m[1] === "/") {
      const id = Number(m[2])
      pieces.push({ kind: "close", id })
      const at = stack.lastIndexOf(id)
      if (at >= 0) stack.splice(at, 1)
    } else {
      const id = Number(m[2])
      pieces.push({ kind: "open", id })
      stack.push(id)
    }
  }
  pushText(s.slice(last))
  return pieces
}

export const plainOf = (s: string): string =>
  parseTagged(s)
    .map((p) => (p.kind === "text" ? p.text : ""))
    .join("")

export const tokenIds = (s: string): number[] =>
  parseTagged(s).flatMap((p) => (p.kind === "token" ? [p.id] : []))

export const runIds = (s: string): number[] => [
  ...new Set(parseTagged(s).flatMap((p) => (p.kind === "open" ? [p.id] : []))),
]

/** Sequence of tags only, e.g. "g1 /g1 x2". Equal skeletons mean the formatting layout is unchanged. */
export const tagSkeleton = (s: string): string =>
  parseTagged(s)
    .flatMap((p) => (p.kind === "open" ? [`g${p.id}`] : p.kind === "close" ? [`/g${p.id}`] : p.kind === "token" ? [`x${p.id}`] : []))
    .join(" ")

/** Check that `target` is a structurally valid rendering of `source`. */
export const validateTagged = (source: string, target: string, unitId?: string): Diagnostic[] => {
  const out: Diagnostic[] = []
  const add = (code: string, message: string): void => {
    out.push({ code, severity: "error", message, ...(unitId ? { unitId } : {}) })
  }
  const srcTokens = tokenIds(source).sort((a, b) => a - b)
  const tgtTokens = tokenIds(target).sort((a, b) => a - b)
  if (srcTokens.join(",") !== tgtTokens.join(",")) {
    add("TOKEN_MISMATCH", `protected tokens differ: source [${srcTokens.join(",")}] target [${tgtTokens.join(",")}]`)
  }
  const srcRuns = new Set(runIds(source))
  const stack: number[] = []
  for (const p of parseTagged(target)) {
    if (p.kind === "open") {
      if (!srcRuns.has(p.id)) add("UNKNOWN_RUN", `run g${p.id} does not exist in the source`)
      stack.push(p.id)
    } else if (p.kind === "close") {
      if (stack.at(-1) !== p.id) {
        add("UNBALANCED_RUN", `closing </g${p.id}> does not match the open run`)
        return out
      }
      stack.pop()
    }
  }
  if (stack.length > 0) add("UNBALANCED_RUN", `unclosed run(s): ${stack.map((id) => `g${id}`).join(",")}`)
  return out
}

/** Collapse whitespace for similarity/comparison purposes. */
export const normalizeSpace = (s: string): string => s.replace(/\s+/g, " ").trim()

/** True when the unit contains at least one letter in any script (worth translating). */
export const hasTranslatableText = (plain: string): boolean => /\p{L}/u.test(plain)

/** Apply a function to the literal text of a tagged string, leaving tags untouched. */
export const mapText = (s: string, fn: (text: string) => string): string =>
  parseTagged(s)
    .map((p) => (p.kind === "text" ? fn(p.text) : p.kind === "open" ? `<g${p.id}>` : p.kind === "close" ? `</g${p.id}>` : `<x${p.id}/>`))
    .join("")
