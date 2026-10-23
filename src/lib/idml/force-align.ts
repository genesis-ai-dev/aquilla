import { validateIdmlTranslation, type IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { idmlCharacterStyleEmphasis } from "@/lib/richtext/idml-style-display"
import { idmlWordingKey, type AlignStylesCell } from "./align-styles"
import { stitchIdmlSlotTexts, type NormalizedCompletion } from "./completion"
import { readSourceDistributionSlots } from "./segment-distribution"

const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "by", "for", "from", "in", "of", "on", "or", "the", "to", "with",
  "o", "os", "as", "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "um", "uma",
  "e", "que", "por", "para", "com", "se", "ao", "à", "aos", "às",
])

interface AlignSlot {
  readonly index: number
  readonly style: string
  readonly text: string
  readonly bold: boolean
  readonly glue: boolean
  readonly reference: boolean
}

interface OffsetAnchor {
  readonly source: number
  readonly target: number
}

/**
 * Place a translation into the source style runs without calling a model.
 * References are pinned by their numbers, sentences between those references
 * stay in order, and the saved characters are the translation that was
 * already there. A rate limit cannot block this.
 */
export function forceAlignIdmlStyles(cell: AlignStylesCell): NormalizedCompletion | undefined {
  const prepared = prepare(cell)
  if (!prepared) return undefined
  const { slots, translation } = prepared
  const texts = distributeByShape(slots, translation)
  if (!texts) return undefined
  if (idmlWordingKey(slots.map((slot) => texts.get(slot.index) ?? "").join("")) !== idmlWordingKey(translation)) {
    return undefined
  }
  try {
    return stitchIdmlSlotTexts(
      { id: cell.id, originalHtml: cell.originalHtml, metadata: cell.metadata ?? null },
      texts,
      { preserveWording: translation },
    )
  } catch {
    return undefined
  }
}

/** True when a bold or italic run that contains a word was left empty. */
export function idmlPlacementOmitsStyledRuns(cell: AlignStylesCell, html: string | undefined): boolean {
  const prepared = prepare(cell)
  if (!prepared || !html) return prepared ? prepared.slots.some(isRequiredStyledRun) : false
  let validation: { valid: boolean; slots: readonly string[] }
  try {
    validation = validateIdmlTranslation(cell.originalHtml!, html, prepared.metadata)
  } catch {
    return true
  }
  if (!validation.valid) return true
  return prepared.slots.some((slot) =>
    isRequiredStyledRun(slot) && !(validation.slots[slot.index] ?? "").trim()
  )
}

export function requiredStyledRunCount(cell: AlignStylesCell): number {
  return prepare(cell)?.slots.filter(isRequiredStyledRun).length ?? 0
}

function isRequiredStyledRun(slot: AlignSlot): boolean {
  return slot.bold && !slot.reference && letterCount(slot.text) >= 2
}

function distributeByShape(
  slots: readonly AlignSlot[],
  translation: string,
): Map<number, string> | undefined {
  const ranges: { slot: AlignSlot; start: number; end: number; text: string }[] = []
  let cursor = 0
  for (const slot of slots) {
    const text = slot.text.replace(/\u00AD/g, "")
    ranges.push({ slot, start: cursor, end: cursor + text.length, text })
    cursor += text.length
  }
  const source = ranges.map((range) => range.text).join("")
  const anchors: OffsetAnchor[] = [
    { source: 0, target: 0 },
    { source: source.length, target: translation.length },
  ]
  let search = 0
  for (const range of ranges) {
    if (!range.slot.reference) continue
    const span = locateReference(translation, range.text, search)
    if (!span) continue
    anchors.push({ source: range.start, target: span.start }, { source: range.end, target: span.end })
    search = span.end
  }
  const walls = monotonicAnchors(anchors)
  for (let wall = 0; wall < walls.length - 1; wall += 1) {
    const left = walls[wall]!
    const right = walls[wall + 1]!
    const pairs = alignSentenceGroups(
      sentenceSpans(source.slice(left.source, right.source)),
      sentenceSpans(translation.slice(left.target, right.target)),
    )
    for (const pair of pairs) {
      const sourceAt = left.source + pair.source
      const targetAt = left.target + pair.target
      if (sourceAt > left.source && sourceAt < right.source && targetAt > left.target && targetAt < right.target) {
        anchors.push({ source: sourceAt, target: targetAt })
      }
    }
  }
  const ordered = monotonicAnchors(anchors)
  const boundaries = [...ranges.map((range) => range.start), source.length]
  const mapped = snapBoundaries(
    boundaries.map((offset) => mapOffset(offset, ordered)),
    translation,
    new Set(ordered.flatMap((anchor) => {
      const index = boundaries.indexOf(anchor.source)
      return index >= 0 ? [index] : []
    })),
  )
  const texts = new Map<number, string>()
  let carry = ""
  for (let index = 0; index < ranges.length; index += 1) {
    const piece = carry + translation.slice(mapped[index] ?? 0, mapped[index + 1] ?? translation.length)
    carry = ""
    const slot = ranges[index]!.slot
    if (slot.glue) {
      carry = piece
      texts.set(slot.index, "")
    } else {
      texts.set(slot.index, piece)
    }
  }
  if (carry) {
    const last = [...ranges].reverse().find((range) => !range.slot.glue)
    if (last) texts.set(last.slot.index, (texts.get(last.slot.index) ?? "") + carry)
  }
  shiftSpaceSlots(ranges.map((range) => range.slot), texts)
  claimBoldWords(ranges.map((range) => range.slot), texts)
  return texts
}

function shiftSpaceSlots(slots: readonly AlignSlot[], texts: Map<number, string>): void {
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!
    if (slot.glue || slot.text.replace(/\u00AD/g, "").trim()) continue
    const piece = texts.get(slot.index) ?? ""
    if (!letterCount(piece)) continue
    const next = slots.slice(index + 1).find((candidate) => !candidate.glue && candidate.text.replace(/\u00AD/g, "").trim())
    if (!next) continue
    texts.set(next.index, piece + (texts.get(next.index) ?? ""))
    texts.set(slot.index, "")
  }
}

function claimBoldWords(slots: readonly AlignSlot[], texts: Map<number, string>): void {
  slots.forEach((slot, index) => {
    if (!slot.bold || slot.reference || slot.glue) return
    const need = contentWords(slot.text).length
    for (let guard = 0; guard < 8 && contentWords(texts.get(slot.index) ?? "").length < need; guard += 1) {
      if (!takeContentWord(slots, texts, index, "next") && !takeContentWord(slots, texts, index, "previous")) break
    }
    moveLeadingFunctionWords(slots, texts, index)
  })
}

function takeContentWord(
  slots: readonly AlignSlot[],
  texts: Map<number, string>,
  index: number,
  side: "next" | "previous",
): boolean {
  const step = side === "next" ? 1 : -1
  let neighbor = index + step
  while (slots[neighbor]?.glue) neighbor += step
  const slot = slots[neighbor]
  if (!slot || slot.reference) return false
  if (slot.bold && contentWords(texts.get(slot.index) ?? "").length <= contentWords(slot.text).length) return false
  const tokens = texts.get(slot.index)?.match(/\s+|[^\s]+/g) ?? []
  const contentAt = side === "next"
    ? tokens.findIndex((token) => isContentWord(token))
    : tokens.findLastIndex((token) => isContentWord(token))
  if (contentAt < 0) return false
  const taken = side === "next" ? tokens.slice(0, contentAt + 1) : tokens.slice(contentAt)
  const left = side === "next" ? tokens.slice(contentAt + 1) : tokens.slice(0, contentAt)
  texts.set(slot.index, left.join(""))
  const current = slots[index]!
  const piece = taken.join("")
  texts.set(current.index, side === "next" ? (texts.get(current.index) ?? "") + piece : piece + (texts.get(current.index) ?? ""))
  return true
}

function moveLeadingFunctionWords(slots: readonly AlignSlot[], texts: Map<number, string>, index: number): void {
  const slot = slots[index]!
  const tokens = (texts.get(slot.index) ?? "").match(/\s+|[^\s]+/g) ?? []
  const contentAt = tokens.findIndex((token) => isContentWord(token))
  if (contentAt <= 0) return
  let previous = index - 1
  while (slots[previous]?.glue) previous -= 1
  const prior = slots[previous]
  if (!prior || prior.bold || prior.reference) return
  texts.set(prior.index, (texts.get(prior.index) ?? "") + tokens.slice(0, contentAt).join(""))
  texts.set(slot.index, tokens.slice(contentAt).join(""))
}

function contentWords(text: string): string[] {
  return (text.replace(/\u00AD/g, "").match(/[^\s]+/g) ?? []).filter(isContentWord)
}

function isContentWord(token: string): boolean {
  const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase()
  return core.length > 0 && /\p{L}/u.test(core) && !STOP_WORDS.has(core)
}

function mapOffset(offset: number, anchors: readonly OffsetAnchor[]): number {
  let previous = anchors[0]!
  for (const anchor of anchors) {
    if (anchor.source < offset) {
      previous = anchor
      continue
    }
    if (anchor.source === previous.source) return previous.target
    const ratio = (offset - previous.source) / (anchor.source - previous.source)
    return Math.round(previous.target + ratio * (anchor.target - previous.target))
  }
  return anchors[anchors.length - 1]!.target
}

function snapBoundaries(mapped: number[], text: string, locked: ReadonlySet<number>): number[] {
  const edges = [0, text.length]
  for (let index = 1; index < text.length; index += 1) {
    if (/\s/u.test(text[index - 1]!) !== /\s/u.test(text[index]!)) edges.push(index)
  }
  const result = mapped.slice()
  for (let index = 1; index < result.length - 1; index += 1) {
    if (locked.has(index)) continue
    const previous = result[index - 1] ?? 0
    let limit = text.length
    for (let next = index + 1; next < result.length; next += 1) {
      if (locked.has(next)) {
        limit = result[next] ?? text.length
        break
      }
    }
    let best = previous
    let bestDistance = Number.POSITIVE_INFINITY
    for (const edge of edges) {
      if (edge < previous || edge > limit) continue
      const distance = Math.abs(edge - (mapped[index] ?? edge))
      if (distance < bestDistance) {
        best = edge
        bestDistance = distance
      }
    }
    result[index] = best
  }
  return result
}

function monotonicAnchors(anchors: readonly OffsetAnchor[]): OffsetAnchor[] {
  const ordered = [...anchors].sort((left, right) => left.source - right.source || left.target - right.target)
  const kept: OffsetAnchor[] = []
  for (const anchor of ordered) {
    const previous = kept[kept.length - 1]
    if (previous && (anchor.source <= previous.source || anchor.target < previous.target)) continue
    kept.push(anchor)
  }
  return kept
}

function sentenceSpans(text: string): { start: number; end: number }[] {
  const ends = [0, ...sentenceEnds(text), text.length]
  const spans: { start: number; end: number }[] = []
  for (let index = 0; index < ends.length - 1; index += 1) {
    if (ends[index + 1]! > ends[index]!) spans.push({ start: ends[index]!, end: ends[index + 1]! })
  }
  return spans
}

function sentenceEnds(text: string): number[] {
  const ends: number[] = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char !== "." && char !== "?" && char !== "!") continue
    if (isDigit(text[index - 1]) && isDigit(text[index + 1])) continue
    if (text[index + 1] === "." || text[index - 1] === ".") continue
    const after = text.slice(index + 1)
    if (after.length === 0 || /^\s+\p{L}/u.test(after)) ends.push(index + 1)
  }
  return ends.filter((end) => end < text.length)
}

function alignSentenceGroups(
  sourceSpans: readonly { start: number; end: number }[],
  targetSpans: readonly { start: number; end: number }[],
): { source: number; target: number }[] {
  const sourceCount = sourceSpans.length
  const targetCount = targetSpans.length
  const infinite = Number.POSITIVE_INFINITY
  const cost = Array.from({ length: sourceCount + 1 }, () => Array<number>(targetCount + 1).fill(infinite))
  const step = Array.from({ length: sourceCount + 1 }, () => Array<string>(targetCount + 1).fill(""))
  cost[0]![0] = 0
  const lengthOf = (span: { start: number; end: number }) => span.end - span.start
  const consider = (sourceIndex: number, targetIndex: number, kind: string, sourceLength: number, targetLength: number) => {
    const previousSource = sourceIndex - (kind === "21" ? 2 : 1)
    const previousTarget = targetIndex - (kind === "12" ? 2 : 1)
    const next = (cost[previousSource]?.[previousTarget] ?? infinite) + Math.abs(sourceLength - targetLength)
    if (next < (cost[sourceIndex]?.[targetIndex] ?? infinite)) {
      cost[sourceIndex]![targetIndex] = next
      step[sourceIndex]![targetIndex] = kind
    }
  }
  for (let sourceIndex = 0; sourceIndex <= sourceCount; sourceIndex += 1) {
    for (let targetIndex = 0; targetIndex <= targetCount; targetIndex += 1) {
      if (cost[sourceIndex]![targetIndex] === infinite) continue
      const sourceSpan = sourceSpans[sourceIndex]
      const targetSpan = targetSpans[targetIndex]
      if (sourceSpan && targetSpan) consider(sourceIndex + 1, targetIndex + 1, "11", lengthOf(sourceSpan), lengthOf(targetSpan))
      const secondTarget = targetSpans[targetIndex + 1]
      if (sourceSpan && targetSpan && secondTarget) {
        consider(sourceIndex + 1, targetIndex + 2, "12", lengthOf(sourceSpan), lengthOf(targetSpan) + lengthOf(secondTarget))
      }
      const secondSource = sourceSpans[sourceIndex + 1]
      if (sourceSpan && secondSource && targetSpan) {
        consider(sourceIndex + 2, targetIndex + 1, "21", lengthOf(sourceSpan) + lengthOf(secondSource), lengthOf(targetSpan))
      }
    }
  }
  if (cost[sourceCount]![targetCount] === infinite) return []
  const groups: { source: number; target: number }[] = []
  let sourceIndex = sourceCount
  let targetIndex = targetCount
  while (sourceIndex > 0 && targetIndex > 0) {
    const kind = step[sourceIndex]![targetIndex]
    if (!kind) break
    groups.push({
      source: sourceSpans[sourceIndex - 1]!.end,
      target: targetSpans[targetIndex - 1]!.end,
    })
    if (kind === "12") {
      sourceIndex -= 1
      targetIndex -= 2
    } else if (kind === "21") {
      sourceIndex -= 2
      targetIndex -= 1
    } else {
      sourceIndex -= 1
      targetIndex -= 1
    }
  }
  return groups
}

function prepare(cell: AlignStylesCell): {
  slots: AlignSlot[]
  translation: string
  metadata: IdmlFormatMetadataV2
} | undefined {
  const metadata = readMetadata(cell)
  const translation = (cell.translated ?? "").trim() ? cell.translated ?? "" : ""
  if (!metadata || !cell.originalHtml || !translation || typeof document === "undefined") return undefined
  const source = readSourceDistributionSlots(cell.originalHtml, metadata.editableSlotIndexes)
  if (source.length !== metadata.editableSlotIndexes.length) return undefined
  const slots = source.map((slot) => {
    const { bold, italic } = idmlCharacterStyleEmphasis(slot.style)
    const glue = /source serif/i.test(slot.style) || /^['\u2018\u2019\u201B\u02BC\u2032\u00B4]+$/.test(slot.text.trim())
    return {
      index: slot.index,
      style: slot.style,
      text: slot.text,
      bold: bold || italic,
      glue,
      reference: !glue && isReferenceSource(slot.text),
    }
  })
  return { slots, translation, metadata }
}

function isReferenceSource(text: string): boolean {
  const trimmed = text.replace(/\u00AD/g, "").trim()
  if (!trimmed || trimmed.length > 48) return false
  const numbers = trimmed.match(/\d+/g)
  if (!numbers || numbers.length < 2) return false
  return /\d\s*[:.\-–—]\s*\d/.test(trimmed)
}

function locateReference(
  translation: string,
  source: string,
  from: number,
): { start: number; end: number } | undefined {
  const numbers = source.replace(/\u00AD/g, "").match(/\d+/g)
  if (!numbers) return undefined
  const budget = source.replace(/\u00AD/g, "").trim().length + 20
  let search = Math.max(0, from)
  while (search < translation.length) {
    const start = translation.indexOf(numbers[0]!, search)
    if (start < 0) return undefined
    let cursor = start + numbers[0]!.length
    let fits = true
    for (const number of numbers.slice(1)) {
      const next = translation.indexOf(number, cursor)
      if (next < 0 || next - cursor > 24) {
        fits = false
        break
      }
      cursor = next + number.length
    }
    if (fits && cursor - start <= budget) return { start, end: cursor }
    search = start + 1
  }
  return undefined
}

function letterCount(text: string): number {
  return text.replace(/\u00AD/g, "").replace(/[^\p{L}]/gu, "").length
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9"
}

function readMetadata(cell: AlignStylesCell): IdmlFormatMetadataV2 | undefined {
  const candidate = cell.metadata?.idml
  if (
    typeof candidate !== "object"
    || candidate === null
    || Array.isArray(candidate)
    || (candidate as { version?: unknown }).version !== 2
  ) {
    return undefined
  }
  const indexes = (candidate as { editableSlotIndexes?: unknown }).editableSlotIndexes
  if (!Array.isArray(indexes) || !indexes.every((index) => Number.isInteger(index))) return undefined
  return candidate as IdmlFormatMetadataV2
}
