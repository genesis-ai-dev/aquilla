// Software-string placeholder protection (AQU-2386).
//
// Software-string imports (JSON i18n resources, gettext PO, Java .properties)
// carry placeholders the runtime substitutes at display time. A placeholder is
// not prose: translating `{count}`, re-casing `%S`, or dropping `%s` breaks the
// string at runtime, and the damage is invisible in the editor.
//
// This module is the one place that says what a placeholder IS, so the import
// parsers, QA and the drafting prompt all agree. Classification follows the
// localization convention recorded in `db/shared/inline-tags.ts` (AQU-2385,
// from patois-labs/localization-os decision 0068):
//
//   - NAMED placeholders carry their own identity (`{name}`, `{{count}}`,
//     `{0}`, `%1$s`, `%(name)s`, `${name}`, `:name`), so a translator — human
//     or model — MAY move them to wherever the target grammar needs them.
//   - ORDERED placeholders are positional (`%s`, `%d`, `%@`, `{}`): their
//     relative order IS which argument they stand for, so a reorder swaps
//     values and is a defect.
//
// The grammar here deliberately covers placeholders ONLY. XML-ish inline tags
// (`<b>`, `<x id="1"/>`) are markup, not placeholders: they belong to the
// inline-tag ladder in `db/shared/inline-tags.ts`, which masks them around the
// model call. `classifyInlineTag` is reused for every shape both modules know,
// so named-vs-ordered can never drift between them.
//
// Pure and dependency-light, like the rest of the parse core: no DOM, no `@/`
// aliases, so the import parse Web Worker and the sync-worker's Agent API
// parse route can import it.

import { classifyInlineTag } from "../../../db/shared/inline-tags"

/** Whether a placeholder may move in the target. */
export type PlaceholderKind = "named" | "ordered"

/** One placeholder occurrence in a string. */
export interface PlaceholderToken {
  /** The placeholder exactly as it appears in the text. */
  raw: string
  kind: PlaceholderKind
  /** Argument name or index; `""` for an unnamed, positional placeholder. */
  name: string
  /** Offset of `raw` in the text it was extracted from. */
  index: number
}

// Alternation order matters: the longest form for a given prefix must come
// first, or `${name}` would be read as the `{name}` inside it.
const PLACEHOLDER_SOURCE = [
  "\\$\\{[^{}\\s]*\\}", // ${name}     shell / JS template literal
  "\\{\\{[^{}\\s]*\\}\\}", // {{count}}   i18next / mustache
  "\\{[^{}\\s]*\\}", // {name}, {0} and the empty {}
  "%\\([A-Za-z_]\\w*\\)[a-zA-Z@]", // %(name)s    python named
  "%\\d+\\$[a-zA-Z@]", // %1$s, %1$@  printf / Apple positional index
  "%[sdifuxoeg@]", // %s %d %@    printf / Apple unnamed
  // :name (Laravel). A word character or a second colon before it means this
  // is prose, a time or a URL scheme ("ratio a:b", "10:30", "https://…"),
  // not a placeholder.
  "(?<![\\w:]):[A-Za-z_]\\w*",
].join("|")

/** Build a fresh matcher — a shared `g`-flagged regex would carry lastIndex. */
const placeholderMatcher = (): RegExp => new RegExp(PLACEHOLDER_SOURCE, "g")

/** Classify one already-matched placeholder. */
export function classifyPlaceholder(raw: string): { kind: PlaceholderKind; name: string } {
  if (raw.startsWith("${")) {
    const inner = raw.slice(2, -1)
    return inner === "" ? { kind: "ordered", name: "" } : { kind: "named", name: inner }
  }
  if (raw.startsWith(":")) return { kind: "named", name: raw.slice(1) }
  // Every remaining shape is one the inline-tag ladder already classifies;
  // reuse it so the two modules cannot disagree about what may move.
  const { kind, name } = classifyInlineTag(raw)
  return { kind: kind === "named-placeholder" ? "named" : "ordered", name }
}

/** Every placeholder in `text`, in document order. */
export function detectPlaceholders(text: string): PlaceholderToken[] {
  const re = placeholderMatcher()
  const out: PlaceholderToken[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push({ raw: m[0], index: m.index, ...classifyPlaceholder(m[0]) })
  }
  return out
}

/**
 * What an imported cell records under `metadata.placeholders`: the protected
 * tokens of its source string, without offsets (a translation moves them, so
 * an offset would be stale the moment anyone types).
 */
export interface PlaceholderRecord {
  raw: string
  kind: PlaceholderKind
  name: string
}

/**
 * The `metadata.placeholders` value for a source string, or `undefined` when
 * it carries none — so a prose cell gains no metadata at all.
 */
export function placeholderMetadata(text: string): PlaceholderRecord[] | undefined {
  const tokens = detectPlaceholders(text)
  if (tokens.length === 0) return undefined
  return tokens.map(({ raw, kind, name }) => ({ raw, kind, name }))
}

/** How a target's placeholders differ from its source's. */
export interface PlaceholderDiff {
  /** Source placeholders the target does not carry often enough. */
  dropped: string[]
  /** Placeholders the target invented — absent from the source entirely. */
  added: string[]
  /** Source placeholders the target repeats more often than the source does. */
  duplicated: string[]
  /** Both carry the same ordered placeholders, but not in the same sequence. */
  reordered: boolean
}

const countByRaw = (tokens: readonly PlaceholderToken[]): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const t of tokens) counts.set(t.raw, (counts.get(t.raw) ?? 0) + 1)
  return counts
}

const orderedSequence = (tokens: readonly PlaceholderToken[]): string =>
  tokens.filter((t) => t.kind === "ordered").map((t) => t.raw).join(" ")

/**
 * Compare a target's placeholders against its source's.
 *
 * A reorder is reported ONLY for `ordered` placeholders, and only when both
 * sides carry the same ones: moving `{name}` or `%1$s` is legitimate target
 * grammar, while moving `%s` past `%d` silently swaps two arguments.
 */
export function comparePlaceholders(source: string, target: string): PlaceholderDiff {
  const src = detectPlaceholders(source)
  const tgt = detectPlaceholders(target)
  const srcCounts = countByRaw(src)
  const tgtCounts = countByRaw(tgt)

  const dropped: string[] = []
  const added: string[] = []
  const duplicated: string[] = []

  for (const [raw, n] of srcCounts) {
    if ((tgtCounts.get(raw) ?? 0) < n) dropped.push(raw)
  }
  for (const [raw, n] of tgtCounts) {
    const inSource = srcCounts.get(raw) ?? 0
    if (inSource === 0) added.push(raw)
    else if (n > inSource) duplicated.push(raw)
  }

  const srcOrdered = orderedSequence(src)
  const tgtOrdered = orderedSequence(tgt)
  const sameOrderedSet =
    srcOrdered.split(" ").filter(Boolean).sort().join(" ") ===
    tgtOrdered.split(" ").filter(Boolean).sort().join(" ")

  return {
    dropped,
    added,
    duplicated,
    reordered: sameOrderedSet && srcOrdered !== tgtOrdered,
  }
}

/** True when nothing about the target's placeholders differs from the source. */
export const placeholdersIntact = (diff: PlaceholderDiff): boolean =>
  diff.dropped.length === 0 && diff.added.length === 0 && diff.duplicated.length === 0 && !diff.reordered

/** Distinct placeholders of a source string, in first-appearance order. */
const distinctRaws = (text: string): string[] => [...new Set(detectPlaceholders(text).map((t) => t.raw))]

/** How many placeholders the prompt names before it stops listing them. */
const PROMPT_PLACEHOLDER_LIMIT = 12

/**
 * The drafting prompt's placeholder rule, or `""` when the source carries no
 * placeholders (a prose project pays nothing for this). The listed tokens are
 * the ones the model must hand back untouched; the rule also states which of
 * them it may move, so a legitimate reorder is not suppressed.
 */
export function placeholderPromptInstruction(sourceText: string): string {
  const raws = distinctRaws(sourceText)
  if (raws.length === 0) return ""
  const listed = raws.slice(0, PROMPT_PLACEHOLDER_LIMIT).join("  ")
  return (
    "Placeholders (strictly enforced): the source contains placeholder tokens the application " +
    `substitutes at runtime: ${listed}\n` +
    "- Reproduce every one of them exactly as written. Never translate, rename, re-case, split, add or drop one.\n" +
    "- A placeholder that names its argument ({name}, {{count}}, {0}, %1$s, %(name)s, ${name}, :name) may move " +
    "to wherever the target grammar needs it.\n" +
    "- An unnamed placeholder (%s, %d, %@, {}) must stay in the same order relative to the other unnamed " +
    "placeholders: their order is which value they stand for."
  )
}
