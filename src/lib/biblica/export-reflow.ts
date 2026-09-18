/**
 * Export-time repairs for Biblica study-note slots.
 *
 * IDML gives every character style its own Content slot, so a translator (or
 * an AI draft) who renders a phrase in fewer runs than the English leaves
 * English sitting in the slots they skipped — apostrophe tails, key-term
 * middles, leftover "." on a bold name, the first word of a note body packed
 * into the passage-reference run. Codex applied these in
 * `applySegmentTranslationToParagraphBlock`; Aquilla's engine writes whatever
 * is in the target slots, so the same repairs run here before those slots
 * reach the package.
 */

import type { IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { isBiblicaBookVolumeCell } from "./apostrophe-glue"
import { isStructuralApostropheContent, isStructuralApostropheSegment } from "./note-rules"

/** Trailing clause marks that leaked onto a key-term / bold run: "Davi.", "Jeoacaz,". */
const BOLD_THEN_PUNCT = /^(.*\p{L}\p{M}*)(\s*[.,;:!?…]+)\s*$/u
const ENDS_WITH_CLAUSE_PUNCT = /[.,;:!?…]\s*$/u

/** A run of digits and punctuation, then the first word: "4:1 – 5:32 A ". */
const REFERENCE_THEN_WORDS = /^([^\p{L}]*\p{Nd}[^\p{L}]*)(\p{L}[\s\S]*)$/u
const digitsOf = (value: string): string => value.replace(/[^\p{Nd}]/gu, "")

/**
 * Key-term and other emphasised character styles whose leftover punctuation
 * should sit in the following plain run, not in the bold itself.
 */
function isEmphasizedCharacterStyle(style: string | undefined): boolean {
  if (!style) return false
  const normalized = style.replace(/%3a/gi, ":").toLowerCase()
  return (
    /(?:^|[/:])(?:k_)?xt(?:$|[/:_])/i.test(normalized)
    || normalized.includes("bold")
    || /(?:^|[/:])bd(?:$|[/:_])/i.test(normalized)
  )
}

function destinationAlreadyHasPunct(destination: string, punct: string): boolean {
  const marks = punct.replace(/\s+/gu, "")
  const leading = /^\s*([.,;:!?…]+)/u.exec(destination)?.[1] ?? ""
  return leading.length > 0 && marks.length > 0 && leading[0] === marks[0]
}

/**
 * Leftover "." / "," (and the rest of the clause marks) that slid onto a
 * bold or key-term run.
 *
 * IDML keeps "David" in a `k_xt` run and the following "." or "," in the
 * plain run after it. When the translation needs fewer runs, the mark is
 * packed onto the name — InDesign then prints **Davi.** / **Jeoacaz,**. The
 * name itself is still in place (the original run has letters and no
 * trailing mark), so the extra punctuation is handed to the next run.
 *
 * Headings that are two bold slots on purpose (`1:1–31` / `Isaiah`) are
 * left alone: the destination is emphasised as well, so there is no plain
 * run to receive the mark.
 */
export function moveBoldPunctuationSpilloverToBody(
  translatedSegments: readonly string[],
  originalSegments: readonly string[],
  blockedIndexes?: ReadonlySet<number>,
  segmentStyles?: readonly string[],
): string[] {
  const result = [...translatedSegments]

  for (let index = 0; index < result.length; index++) {
    const destination = index + 1
    if (blockedIndexes?.has(index) || blockedIndexes?.has(destination)) continue

    const original = originalSegments[index] ?? ""
    if (!original.trim() || !/\p{L}/u.test(original) || ENDS_WITH_CLAUSE_PUNCT.test(original)) {
      continue
    }

    const hasStyles = (segmentStyles?.length ?? 0) > 0
    if (hasStyles && !isEmphasizedCharacterStyle(segmentStyles?.[index])) continue
    if (hasStyles && isEmphasizedCharacterStyle(segmentStyles?.[destination])) continue

    const spillover = BOLD_THEN_PUNCT.exec(result[index] ?? "")
    if (!spillover) continue

    const body = result[destination]
    if (!body?.trim()) continue

    const word = spillover[1]
    const punct = spillover[2].replace(/\s+$/u, "")
    result[index] = word
    if (!destinationAlreadyHasPunct(body, punct)) {
      result[destination] = `${punct.replace(/^\s+/u, "")}${body}`
    }
  }

  return result
}

/**
 * Note body text that slid forward into the passage reference styling it.
 *
 * A note opens with its reference in a bold run of its own ("4:1 – 5:32") and
 * the body starts in the next run. Where the translation needs fewer runs than
 * the English — Portuguese opening "A linhagem" against an English "The" that
 * sits in its own run before the key term — the reflow packs the body's first
 * word into the reference run, and export prints it bold: "4:1 – 5:32 A".
 */
export function moveReferenceRunSpilloverToBody(
  translatedSegments: readonly string[],
  originalSegments: readonly string[],
  blockedIndexes?: ReadonlySet<number>,
): string[] {
  const result = [...translatedSegments]

  for (let index = 0; index < result.length; index++) {
    const destination = index + 1
    if (blockedIndexes?.has(index) || blockedIndexes?.has(destination)) continue

    const original = originalSegments[index] ?? ""
    if (!original.trim() || /\p{L}/u.test(original) || !/\p{Nd}/u.test(original)) continue

    const spillover = REFERENCE_THEN_WORDS.exec(result[index] ?? "")
    if (!spillover || digitsOf(spillover[1]) !== digitsOf(original)) continue

    const body = result[destination]
    if (!body?.trim()) continue

    const reference = spillover[1].replace(/\s+$/u, "")
    result[index] = reference
    result[destination] = `${spillover[1].slice(reference.length)}${spillover[2]}${body}`
  }

  return result
}

/**
 * Apostrophes are their own Content slot, so "Aaron's walking stick" is
 * three slots: "Aaron" / "'" / "s walking stick". Translators replace the
 * headword with the full target phrase and the English tail is left unmatched.
 * Clear that untranslated follower with the apostrophe so export does not emit
 * "O cajado de Arão:s walking stick".
 */
export function expandForceClearWithUntranslatedFollowers(
  forceClearIndexes: readonly number[] | undefined,
  originalSegments: readonly string[],
  translatedSegments: readonly string[],
): number[] {
  const expanded = [...(forceClearIndexes ?? [])]
  const seen = new Set(expanded)

  for (const index of forceClearIndexes ?? []) {
    const follower = index + 1
    if (follower >= originalSegments.length || seen.has(follower)) continue

    const original = originalSegments[follower] ?? ""
    if (original.trim() === "") continue

    const translated = translatedSegments[follower] ?? ""
    const independentlyTranslated =
      translated.trim() !== "" && translated !== original
    if (independentlyTranslated) continue

    expanded.push(follower)
    seen.add(follower)
  }

  return expanded
}

/**
 * Slots the translator emptied by folding their text into a neighbouring run.
 *
 * IDML gives every character style its own Content slot, so "Ahijah the
 * prophet" arrives as three slots (key term / plain / key term). A translator
 * who renders the whole phrase in the first slot leaves the other two empty,
 * and falling back to the source text there prints the English straight back
 * into the translated note.
 *
 * `parsedSegments` ends at the last slot the cell actually rendered a span
 * for, which separates the two cases: an empty entry within that range was
 * emitted as empty on purpose, while anything past it is simply unknown and
 * keeps its source text. Slots before the first translated run keep it too —
 * nothing has been written yet for them to have been folded into.
 *
 * Aquilla's engine writes empty slots as empty rather than falling back to
 * source, so clearing here is what stops an AI draft that copied English into
 * those middle slots from shipping it.
 */
export function findAbandonedSegmentIndexes(
  originalSegments: readonly string[],
  parsedSegments: readonly string[],
  preserveSegmentIndexes?: readonly number[],
): number[] {
  const preserve = new Set(preserveSegmentIndexes ?? [])
  const isFilled = (index: number): boolean =>
    (parsedSegments[index] ?? "").trim().length > 0

  const abandoned: number[] = []
  let filledBefore = false
  for (let index = 0; index < originalSegments.length; index++) {
    if (isFilled(index)) {
      filledBefore = true
      continue
    }
    if (!filledBefore || index >= parsedSegments.length || preserve.has(index)) {
      continue
    }
    if ((originalSegments[index] ?? "").trim().length > 0) {
      abandoned.push(index)
    }
  }

  return abandoned
}

/**
 * English that an AI draft copied into interior slots after the translator
 * (or the same draft) had already moved on to a later run.
 *
 * Aquilla's protected HTML always carries a span per slot, so a copied
 * " the " / "prophet" is not empty and `findAbandonedSegmentIndexes` would
 * leave it. Codex never saw this: omitted spans parsed as empty. Requiring a
 * later independently-translated slot keeps a mapping failure (only the first
 * run translated) from silently dropping the rest of the note.
 */
export function findUntranslatedInteriorIndexes(
  originalSegments: readonly string[],
  translatedSegments: readonly string[],
  preserveSegmentIndexes?: readonly number[],
): number[] {
  const preserve = new Set(preserveSegmentIndexes ?? [])
  const independentlyTranslated = (index: number): boolean => {
    const translated = translatedSegments[index] ?? ""
    return translated.trim() !== "" && translated !== (originalSegments[index] ?? "")
  }
  const laterTranslated = (from: number): boolean => {
    for (let index = from + 1; index < originalSegments.length; index++) {
      if (independentlyTranslated(index)) return true
    }
    return false
  }

  const interior: number[] = []
  let filledBefore = false
  for (let index = 0; index < originalSegments.length; index++) {
    if (independentlyTranslated(index)) {
      filledBefore = true
      continue
    }
    if (!filledBefore || preserve.has(index) || !laterTranslated(index)) continue
    const translated = translatedSegments[index] ?? ""
    const original = originalSegments[index] ?? ""
    if (original.trim().length === 0) continue
    if (translated.trim() === "" || translated === original) interior.push(index)
  }
  return interior
}

function mergeIndexLists(...lists: number[][]): number[] {
  return [...new Set(lists.flat())].sort((a, b) => a - b)
}

export interface BiblicaSlotReflowInput {
  readonly originalSlots: readonly string[]
  readonly translatedSlots: readonly string[]
  readonly characterStyles: readonly string[]
  /** Apostrophe-glue slots that must be emptied, matching Codex forceClear. */
  readonly apostropheIndexes: readonly number[]
  /** Slots that must keep their source value, e.g. verse delimiters. */
  readonly preserveIndexes?: readonly number[]
}

/**
 * Run the Codex export repairs against one cell's slot texts.
 * Returns the input unchanged when nothing needs moving or clearing.
 */
export function reflowBiblicaTargetSlots(input: BiblicaSlotReflowInput): string[] {
  const originals = [...input.originalSlots]
  const translated = [...input.translatedSlots]
  while (translated.length < originals.length) translated.push("")

  const forceClearIndexes = mergeIndexLists(
    expandForceClearWithUntranslatedFollowers(
      [...input.apostropheIndexes],
      originals,
      translated,
    ),
    findAbandonedSegmentIndexes(originals, translated, input.preserveIndexes),
    findUntranslatedInteriorIndexes(originals, translated, input.preserveIndexes),
  )
  const blocked = new Set([...forceClearIndexes, ...(input.preserveIndexes ?? [])])
  const reflowed = moveBoldPunctuationSpilloverToBody(
    moveReferenceRunSpilloverToBody(translated, originals, blocked),
    originals,
    blocked,
    input.characterStyles,
  )
  return reflowed.map((text, index) => (forceClearIndexes.includes(index) ? "" : text))
}

function replaceSlotContent(slot: HTMLElement, text: string): void {
  const parts = text.split("\n")
  slot.replaceChildren()
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) slot.append(document.createElement("br"))
    slot.append(document.createTextNode(parts[index] ?? ""))
  }
}

/**
 * Apply Codex's export repairs to a Biblica book-volume cell's protected HTML.
 * Returns the input unchanged for front/back matter, generic IDML, or when
 * nothing needs moving.
 */
export function applyBiblicaProtectedHtmlReflow(
  cellMetadata: Record<string, unknown> | null | undefined,
  sourceHtml: string,
  targetHtml: string,
  metadata: IdmlFormatMetadataV2,
): string {
  if (!isBiblicaBookVolumeCell(cellMetadata) || typeof document === "undefined") {
    return targetHtml
  }

  const sourceRoot = document.createElement("div")
  sourceRoot.innerHTML = sourceHtml
  const targetRoot = document.createElement("div")
  targetRoot.innerHTML = targetHtml
  const sourceParagraph = sourceRoot.firstElementChild
  const targetParagraph = targetRoot.firstElementChild
  if (
    !(sourceParagraph instanceof HTMLParagraphElement)
    || !(targetParagraph instanceof HTMLParagraphElement)
  ) {
    return targetHtml
  }

  const originalSlots: string[] = []
  const translatedSlots: string[] = []
  const characterStyles: string[] = []
  const apostropheIndexes: number[] = []
  const preserveIndexes: number[] = []
  const editable = new Set(metadata.editableSlotIndexes)

  for (let index = 0; index < metadata.slotCount; index++) {
    const sourceSlot = sourceParagraph.querySelector<HTMLElement>(
      `span[data-idml-slot="${index}"]`,
    )
    const targetSlot = targetParagraph.querySelector<HTMLElement>(
      `span[data-idml-slot="${index}"]`,
    )
    const original = sourceSlot?.textContent ?? ""
    const translated = targetSlot?.textContent ?? ""
    const style = sourceSlot?.getAttribute("data-idml-character-style") ?? ""
    originalSlots.push(original)
    translatedSlots.push(translated)
    characterStyles.push(style)
    if (!editable.has(index)) preserveIndexes.push(index)
    else if (isStructuralApostropheSegment(original, style)) {
      // A glue slot the draft filled with real words is translation, not
      // typesetting — AQU-1174 keeps those. Only empty / still-apostrophe /
      // still-English glue is cleared, along with an untranslated follower.
      if (
        translated.trim() === ""
        || translated === original
        || isStructuralApostropheContent(translated)
      ) {
        apostropheIndexes.push(index)
      }
    }
  }

  const reflowed = reflowBiblicaTargetSlots({
    originalSlots,
    translatedSlots,
    characterStyles,
    apostropheIndexes,
    preserveIndexes,
  })
  if (reflowed.every((text, index) => text === translatedSlots[index])) return targetHtml

  for (const index of editable) {
    const slot = targetParagraph.querySelector<HTMLElement>(`span[data-idml-slot="${index}"]`)
    if (!slot) continue
    replaceSlotContent(slot, reflowed[index] ?? "")
  }
  return targetParagraph.outerHTML
}
