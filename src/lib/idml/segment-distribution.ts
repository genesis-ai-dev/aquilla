/**
 * Place one existing translation into the source's style runs.
 *
 * A repair that drops the whole note into the first run paints every word
 * with that run's style — a bold headword then bolds the body. Runs are
 * recovered from anchors the translation still shares with the source
 * (a "Name:" label, a verse span, parentheses, a scripture reference).
 * Text that has no such anchor stays in the plain body, so it is not given
 * the headword's style. Apostrophe glue and the English tail after it stay
 * empty: that split is typesetting, not a second sentence.
 */

export interface SourceDistributionSlot {
  readonly index: number
  readonly style: string
  readonly text: string
}

interface DistributionRun {
  readonly home: number
  readonly style: string
  sourceText: string
}

const APOSTROPHE_ONLY = /^['\u2018\u2019\u201B\u02BC\u2032\u00B4]+$/
const LABEL = /^[\p{L}\p{M}'’ʼ.-]+:$/u
const LABEL_PREFIX = /^[\p{L}\p{M}'’ʼ.-]+:/u
const VERSE_SPAN = /^\d[\d\s.:–—-]*\d$/u
const LEADING_VERSE = /^\d+(?:[.:]\d+)?(?:\s*[–—-]\s*\d+(?:[.:]\d+)?)*/u

export function readSourceDistributionSlots(
  sourceHtml: string,
  editableSlotIndexes: readonly number[],
): SourceDistributionSlot[] {
  if (typeof document === "undefined") return []
  const root = document.createElement("div")
  root.innerHTML = sourceHtml
  const slots: SourceDistributionSlot[] = []
  for (const index of editableSlotIndexes) {
    const span = root.querySelector(`span[data-idml-slot="${index}"]`)
    if (!span) return []
    slots.push({
      index,
      style: span.getAttribute("data-idml-character-style") ?? "",
      text: span.textContent ?? "",
    })
  }
  return slots
}

/**
 * True when every translated word sits in one run while the source still
 * has another run, in a different character style, that carries words or a
 * reference. Same-style apostrophe tails do not count.
 */
export function targetDistributionCollapsesSource(
  slots: readonly SourceDistributionSlot[],
  placed: ReadonlyMap<number, string>,
): boolean {
  const runs = buildRuns(slots)
  const meaningful = runs.filter((run) => hasWordsOrReference(run.sourceText))
  const styles = new Set(meaningful.map((run) => styleKey(run.style)))
  if (styles.size < 2) return false
  const filled = meaningful.filter((run) => (placed.get(run.home) ?? "").length > 0)
  if (filled.length !== 1) return false
  const only = filled[0]!
  return meaningful.some((run) => styleKey(run.style) !== styleKey(only.style))
}

/**
 * Split `translation` across the source runs. The pieces join back to the
 * translation exactly. Returns nothing when the slots cannot be read.
 */
export function distributeTranslationLikeSource(
  slots: readonly SourceDistributionSlot[],
  translation: string,
): Map<number, string> | undefined {
  if (slots.length === 0 || !translation) return undefined
  const runs = buildRuns(slots)
  if (runs.length === 0) return undefined
  const parts = splitRuns(runs, translation)
  if (!parts || parts.join("") !== translation) return undefined
  const texts = new Map<number, string>()
  for (const slot of slots) texts.set(slot.index, "")
  runs.forEach((run, index) => {
    texts.set(run.home, parts[index] ?? "")
  })
  return texts
}

function buildRuns(slots: readonly SourceDistributionSlot[]): DistributionRun[] {
  const runs: DistributionRun[] = []
  let open: DistributionRun | undefined
  let afterGlue = false
  for (const slot of slots) {
    if (isGlueSlot(slot.style, slot.text)) {
      afterGlue = true
      continue
    }
    if (afterGlue && open && isPlainStyle(slot.style) && isPlainStyle(open.style)) {
      open.sourceText += slot.text
      afterGlue = false
      continue
    }
    afterGlue = false
    if (open && styleKey(open.style) === styleKey(slot.style)) {
      open.sourceText += slot.text
      continue
    }
    open = { home: slot.index, style: slot.style, sourceText: slot.text }
    runs.push(open)
  }
  return runs
}

function splitRuns(runs: readonly DistributionRun[], translation: string): string[] | undefined {
  const parts = runs.map(() => "")
  let rest = translation
  let start = 0
  let end = runs.length

  while (start < end) {
    const taken = takeLeftAnchor(runs[start]!.sourceText, rest)
    if (taken === undefined) break
    parts[start] = taken
    rest = rest.slice(taken.length)
    start += 1
  }
  while (end > start) {
    const taken = takeRightAnchor(runs[end - 1]!.sourceText, rest)
    if (taken === undefined) break
    parts[end - 1] = taken
    rest = rest.slice(0, rest.length - taken.length)
    end -= 1
  }

  const middle = runs.slice(start, end)
  if (middle.length === 0) return rest.length === 0 ? parts : undefined
  if (middle.length === 1) {
    parts[start] = rest
    return parts
  }

  const paren = splitParenthetical(middle, rest)
  if (paren) {
    paren.forEach((part, index) => {
      parts[start + index] = part
    })
    return parts
  }

  const plainIndex = middle.findIndex((run) =>
    isPlainStyle(run.style) && hasWordsOrReference(run.sourceText),
  )
  parts[start + (plainIndex >= 0 ? plainIndex : 0)] = rest
  return parts
}

function splitParenthetical(
  runs: readonly DistributionRun[],
  text: string,
): string[] | undefined {
  if (!runs[0]?.sourceText.trimEnd().endsWith("(")) return undefined
  const paren = text.lastIndexOf("(")
  if (paren < 0) return undefined
  const inner = splitRuns(runs.slice(1), text.slice(paren + 1))
  if (!inner) return undefined
  return [text.slice(0, paren + 1), ...inner]
}

function takeLeftAnchor(source: string, rest: string): string | undefined {
  return takeWhitespace("left", source, rest)
    ?? takePunctuation("left", source, rest)
    ?? takeLabel(source, rest)
    ?? takeLeadingVerse(source, rest)
}

function takeRightAnchor(source: string, rest: string): string | undefined {
  return takePunctuation("right", source, rest)
    ?? takeWhitespace("right", source, rest)
    ?? takeTrailingReference(source, rest)
}

function takeLabel(source: string, rest: string): string | undefined {
  if (!LABEL.test(source.trim())) return undefined
  return LABEL_PREFIX.exec(rest)?.[0]
}

function takeLeadingVerse(source: string, rest: string): string | undefined {
  if (!VERSE_SPAN.test(source.trim()) || /\p{L}/u.test(source)) return undefined
  return LEADING_VERSE.exec(rest)?.[0]
}

function takeTrailingReference(source: string, rest: string): string | undefined {
  const trimmed = source.trim()
  if (!isShortReference(trimmed)) return undefined
  const words = trimmed.split(/\s+/).filter((word) => /\p{L}/u.test(word) && !/\d/.test(word))
  if (words.length === 0) {
    return /(\d[\d\s.:–—-]*\d)$/u.exec(rest)?.[1]
  }
  const pattern = new RegExp(
    `((?:[\\p{L}\\p{M}.]+\\s+){${words.length}}\\d[\\d\\s.:–—-]*)$`,
    "u",
  )
  const match = pattern.exec(rest)?.[1]
  return match && rest.endsWith(match) ? match : undefined
}

function takeWhitespace(
  side: "left" | "right",
  source: string,
  rest: string,
): string | undefined {
  if (source.length === 0 || source.trim().length > 0) return undefined
  if (side === "left" && rest.startsWith(source)) return source
  if (side === "right" && rest.endsWith(source)) return source
  return undefined
}

function takePunctuation(
  side: "left" | "right",
  source: string,
  rest: string,
): string | undefined {
  const trimmed = source.trim()
  if (!trimmed || !/^[\s().:;,\-–—!?]+$/u.test(trimmed)) return undefined
  const token = rest.startsWith(source) || rest.endsWith(source) ? source : trimmed
  if (side === "left" && rest.startsWith(token)) return token
  if (side === "right" && rest.endsWith(token)) return token
  return undefined
}

function isShortReference(source: string): boolean {
  return source.length > 0 && source.length <= 40 && /\d/.test(source) && !/[.!?]/u.test(source)
}

function hasWordsOrReference(source: string): boolean {
  return /[\p{L}\p{N}]/u.test(source)
}

function isGlueSlot(style: string, text: string): boolean {
  return /source serif/i.test(style) || APOSTROPHE_ONLY.test(text.trim())
}

function isPlainStyle(style: string): boolean {
  const key = styleKey(style)
  return key.length === 0
    || key === "$id/[no character style]"
    || key === "[no character style]"
    || key === "plain"
}

function styleKey(style: string): string {
  const decoded = style.includes("%") ? safeDecode(style) : style
  return decoded.replace(/^CharacterStyle\//i, "").replace(/\s+/g, " ").trim().toLowerCase()
}

function safeDecode(style: string): string {
  try {
    return decodeURIComponent(style)
  } catch {
    return style
  }
}
