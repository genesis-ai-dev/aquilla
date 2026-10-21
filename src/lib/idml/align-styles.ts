import {
  validateIdmlTranslation,
  type IdmlFormatMetadataV2,
  type IdmlStyleCatalog,
} from "@aquilla/idml-roundtrip"
import { t } from "@/lib/i18n/standalone"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"
import { idmlCharacterStyleEmphasis } from "@/lib/richtext/idml-style-display"
import {
  idmlParagraphStyleFromMetadata,
  idmlStyleCatalogFromMetadata,
} from "@/lib/idml/style-catalog"
import {
  draftPlainTextFromBrokenIdml,
  parseIdmlSlotRepairReply,
  stitchIdmlSlotTexts,
  type IdmlCompletionCell,
  type IdmlRepairMessage,
  type NormalizedCompletion,
} from "./completion"
import { idmlPlainMatchesTranslation } from "./protected-html"
import {
  distributeTranslationLikeSource,
  targetDistributionCollapsesSource,
} from "./segment-distribution"

export interface AlignStylesCell extends IdmlCompletionCell {
  readonly translated?: string
}

export interface AlignedIdmlStyles {
  readonly completion: NormalizedCompletion
  /** False when the model left every run's text where it already was. */
  readonly changed: boolean
}

/**
 * IDML v2 cells whose source is split across more than one editable style run.
 * One run has nowhere to move text. Other formats are unchanged.
 */
export function cellCanAlignStyles(cell: AlignStylesCell): boolean {
  const metadata = readIdmlMetadata(cell)
  return Boolean(metadata && metadata.editableSlotIndexes.length >= 2 && cell.originalHtml)
}

/** Collapse spaces so a space that moved from the end of one run to the start of the next still matches. */
export function idmlWordingKey(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim()
}

/**
 * A study-note paragraph past this length does not fit an Align styles call.
 * The slot JSON for every run overruns the completion budget, and the failed
 * call was saving an empty target over the translation that was already there.
 */
export const ALIGN_STYLES_MANUAL_WORDING_LIMIT = 1000

export function alignStylesWordingTooLong(text: string): boolean {
  return idmlWordingKey(text).length > ALIGN_STYLES_MANUAL_WORDING_LIMIT
}

export const IDML_ALIGN_STYLES_INSTRUCTION = [
  "You place an existing translation into the source document's style runs.",
  "Do not translate, paraphrase, add, delete, or reorder words.",
  "Each run is one character style. Put the target words that translate a bold source phrase into the bold run, and do the same for italic and plain.",
  "Read the editable runs in index order as one sentence. Joining them and collapsing whitespace must reproduce the current translation exactly.",
  "You may move a space from the end of one run to the start of the next so the sentence still reads correctly.",
  "Locked runs are fixed. Do not return text for them.",
  "Return STRICT JSON only, no prose, no Markdown fences:",
  '{"slots":[{"i":0,"t":"text for editable run 0"},{"i":1,"t":"…"}]}',
  "Include every editable run index, even when a run stays empty.",
  "Do not return HTML tags. A line break inside a run is \\n in the JSON string.",
  "",
  "Example:",
  "SOURCE RUNS",
  '0 | editable | plain | CharacterStyle/Plain | "the "',
  '1 | editable | bold | CharacterStyle/Bold | "LORD"',
  '2 | editable | plain | CharacterStyle/Plain | " said"',
  'CURRENT TRANSLATION, joined: "сказал Господь"',
  "Answer:",
  '{"slots":[{"i":0,"t":"сказал "},{"i":1,"t":"Господь"},{"i":2,"t":""}]}',
  'Joined "сказал Господь" matches. The word that translates LORD is in the bold run.',
].join("\n")

export function buildIdmlAlignStylesMessages(cell: AlignStylesCell): IdmlRepairMessage[] {
  const prepared = prepareAlignStyles(cell)
  const sourceLines = prepared.runs
    .map((run) =>
      `${run.index} | ${run.editable ? "editable" : "locked"} | ${run.emphasis} | ${run.styleId} | ${JSON.stringify(run.text)}`,
    )
    .join("\n")
  const editableIndexes = prepared.metadata.editableSlotIndexes
  const currentLines = describeCurrentTranslation(prepared)

  return [
    { role: "system", content: IDML_ALIGN_STYLES_INSTRUCTION },
    {
      role: "user",
      content: [
        "SOURCE RUNS (in reading order):",
        sourceLines,
        "",
        currentLines,
        "",
        "Joined wording that must be preserved:",
        JSON.stringify(prepared.wording),
        "",
        `Return JSON for every editable index: ${editableIndexes.join(", ")}.`,
      ].join("\n"),
    },
  ]
}

export async function alignIdmlStyles(
  cell: AlignStylesCell,
  ask: (messages: readonly IdmlRepairMessage[]) => Promise<string>,
): Promise<AlignedIdmlStyles> {
  const prepared = prepareAlignStyles(cell)
  const messages = buildIdmlAlignStylesMessages(cell)
  let outcome = await placementFromReply(prepared, cell, await ask(messages))
  const stillEmpty = styledRunsLeftEmpty(prepared.runs, outcome.slotTexts)
  // A copied split that still leaves "Moses" / "River Nile" empty is not a
  // finished placement. Ask once more, naming the runs that still need words.
  if (!outcome.changed && stillEmpty.length > 0) {
    outcome = await placementFromReply(prepared, cell, await ask([
      ...messages,
      {
        role: "user",
        content: [
          "That placement left styled runs empty. Move the words that translate each phrase into that run. Do not leave these runs empty:",
          ...stillEmpty.map((run) => `${run.index} | ${run.emphasis} | ${JSON.stringify(run.text)}`),
          "Joined wording that must be preserved:",
          JSON.stringify(prepared.wording),
        ].join("\n"),
      },
    ]))
  }
  return { completion: outcome.completion, changed: outcome.changed }
}

async function placementFromReply(
  prepared: PreparedAlignStyles,
  cell: AlignStylesCell,
  reply: string,
): Promise<AlignedIdmlStyles & { slotTexts: Map<number, string> }> {
  if (!reply.trim()) {
    throw new Error(t("editor.idml.alignStylesEmpty"))
  }

  let slotTexts: Map<number, string>
  try {
    slotTexts = parseIdmlSlotRepairReply(reply, prepared.metadata.editableSlotIndexes)
  } catch (error) {
    console.warn("[align-styles] unusable placement", error)
    throw new Error(t("editor.idml.alignStylesEmpty"))
  }

  let placed = joined(prepared.metadata.editableSlotIndexes, slotTexts)
  if (idmlWordingKey(placed) !== prepared.wording) {
    // The model often copies the source's colon or hyphen into a verse
    // reference that the translation writes with a period and an en dash.
    // Keep the translation's own characters and use only the split.
    const snapped = snapPlacementToWording(
      prepared.metadata.editableSlotIndexes,
      slotTexts,
      prepared.exact,
    )
    const snappedJoin = snapped ? joined(prepared.metadata.editableSlotIndexes, snapped) : ""
    if (!snapped || idmlWordingKey(snappedJoin) !== prepared.wording) {
      throw new Error(t("editor.idml.alignStylesChangedWording"))
    }
    slotTexts = snapped
    placed = snappedJoin
  }

  const sourceSlots = prepared.runs
    .filter((run) => run.editable)
    .map((run) => ({ index: run.index, style: run.styleId, text: run.text }))
  if (targetDistributionCollapsesSource(sourceSlots, slotTexts)) {
    const expected = (cell.translated ?? "").length > 0 ? cell.translated! : placed
    const fixed = distributeTranslationLikeSource(sourceSlots, expected)
    const fixedJoin = fixed ? joined(prepared.metadata.editableSlotIndexes, fixed) : ""
    if (fixed && idmlPlainMatchesTranslation(fixedJoin, expected)) {
      slotTexts = fixed
      placed = fixedJoin
    }
  }

  let completion: NormalizedCompletion
  try {
    const original = cell.translated ?? ""
    completion = stitchIdmlSlotTexts(cell, slotTexts, {
      preserveWording: original.length > 0 && idmlPlainMatchesTranslation(placed, original)
        ? original
        : placed,
    })
  } catch (error) {
    console.warn("[align-styles] stitch failed", error)
    throw new Error(t("editor.idml.alignStylesFailed"))
  }

  const changed = prepared.current.kind === "plain"
    || prepared.metadata.editableSlotIndexes.some((index) =>
      (prepared.current.kind === "slots" ? prepared.current.texts.get(index) ?? "" : "")
      !== (slotTexts.get(index) ?? ""),
    )
  return { completion, changed, slotTexts }
}

function describeCurrentTranslation(prepared: PreparedAlignStyles): string {
  const empty = prepared.current.kind === "slots"
    ? styledRunsLeftEmpty(prepared.runs, prepared.current.texts)
    : []
  if (prepared.current.kind === "plain" || empty.length > 0) {
    const lines = [
      empty.length > 0
        ? "CURRENT TRANSLATION (one sentence). The saved split left styled runs empty. Do not repeat that split:"
        : "CURRENT TRANSLATION (not split across runs yet):",
      JSON.stringify(prepared.exact),
    ]
    if (empty.length > 0) {
      lines.push(
        "",
        "These styled source runs still have words, and the saved translation left them empty. Put the words that translate each phrase into that run:",
        ...empty.map((run) => `${run.index} | ${run.emphasis} | ${JSON.stringify(run.text)}`),
      )
    }
    return lines.join("\n")
  }
  return [
    "CURRENT TRANSLATION (runs may hold the wrong words; this wording is already final):",
    ...prepared.metadata.editableSlotIndexes.map((index) =>
      `${index} | ${JSON.stringify(prepared.current.kind === "slots" ? prepared.current.texts.get(index) ?? "" : "")}`,
    ),
  ].join("\n")
}

/** Bold or italic source runs that still have words, with no translation in them. */
function styledRunsLeftEmpty(
  runs: readonly StyleRunDescription[],
  texts: ReadonlyMap<number, string>,
): StyleRunDescription[] {
  return runs.filter((run) =>
    run.editable
    && run.emphasis !== "plain"
    && /[\p{L}\p{N}]/u.test(run.text)
    && !(texts.get(run.index) ?? "").trim()
  )
}

interface StyleRunDescription {
  readonly index: number
  readonly editable: boolean
  readonly styleId: string
  readonly emphasis: "plain" | "bold" | "italic" | "bold italic"
  readonly text: string
}

interface PreparedAlignStyles {
  readonly metadata: IdmlFormatMetadataV2
  readonly runs: readonly StyleRunDescription[]
  readonly wording: string
  /** The translation before whitespace is collapsed, so a recovered split can keep its spaces. */
  readonly exact: string
  readonly current:
    | { readonly kind: "slots"; readonly texts: ReadonlyMap<number, string> }
    | { readonly kind: "plain"; readonly text: string }
}

function prepareAlignStyles(cell: AlignStylesCell): PreparedAlignStyles {
  const metadata = readIdmlMetadata(cell)
  if (!metadata || !cell.originalHtml || metadata.editableSlotIndexes.length < 2) {
    throw new Error(t("editor.idml.alignStylesUnavailable"))
  }
  const sourceProof = validateIdmlTranslation(cell.originalHtml, cell.originalHtml, metadata)
  if (!sourceProof.valid) {
    throw new Error(t("editor.idml.alignStylesFailed"))
  }

  const catalog = idmlStyleCatalogFromMetadata(cell.metadata)
  const paragraphStyleId = idmlParagraphStyleFromMetadata(cell.metadata)
  const styleBySlot = characterStylesBySlot(cell.originalHtml)
  const editable = new Set(metadata.editableSlotIndexes)
  const runs: StyleRunDescription[] = []
  for (let index = 0; index < metadata.slotCount; index += 1) {
    const styleId = styleBySlot.get(index) ?? ""
    runs.push({
      index,
      editable: editable.has(index),
      styleId,
      emphasis: emphasisLabel(styleId, catalog, paragraphStyleId),
      text: sourceProof.slots[index] ?? "",
    })
  }

  const current = currentTarget(cell, metadata)
  const exact = current.kind === "plain"
    ? current.text
    : joined(metadata.editableSlotIndexes, current.texts)
  const wording = idmlWordingKey(exact)
  if (!wording) {
    throw new Error(t("editor.ai.alignStylesNeedsText"))
  }
  return { metadata, runs, wording, exact, current }
}

const PLACEMENT_APOSTROPHE = new Set(["'", "\u2018", "\u2019", "\u201B", "\u02BC", "\u2032", "\u00B4"])
const PLACEMENT_DASH = new Set(["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212"])

/**
 * Map a model's run split onto the translation when the only changes are
 * characters that do not alter the words: a soft hyphen, an apostrophe
 * lookalike, a dash lookalike, or a colon standing in for a period between
 * digits (`1:1` for `1.1`). A changed or missing word returns nothing.
 */
export function snapPlacementToWording(
  indexes: readonly number[],
  slotTexts: ReadonlyMap<number, string>,
  original: string,
): Map<number, string> | undefined {
  const parts = indexes.map((index) => slotTexts.get(index) ?? "")
  const model = parts.join("")
  const bounds: number[] = []
  let cursor = 0
  for (const part of parts) {
    cursor += part.length
    bounds.push(cursor)
  }
  const originAt = new Array<number>(model.length + 1)
  let originalIndex = 0
  let modelIndex = 0
  while (originalIndex < original.length || modelIndex < model.length) {
    if (originalIndex < original.length && original[originalIndex] === "\u00AD") {
      originalIndex += 1
      continue
    }
    if (modelIndex < model.length && model[modelIndex] === "\u00AD") {
      originAt[modelIndex] = originalIndex
      modelIndex += 1
      continue
    }
    if (
      originalIndex < original.length
      && modelIndex < model.length
      && isPlacementSpace(original[originalIndex]!)
      && isPlacementSpace(model[modelIndex]!)
    ) {
      const spaceAt = originalIndex
      while (originalIndex < original.length && isPlacementSpace(original[originalIndex]!)) originalIndex += 1
      while (modelIndex < model.length && isPlacementSpace(model[modelIndex]!)) {
        originAt[modelIndex] = spaceAt
        modelIndex += 1
      }
      continue
    }
    if (
      originalIndex < original.length
      && modelIndex < model.length
      && equivalentPlacementChar(original, model, originalIndex, modelIndex)
    ) {
      originAt[modelIndex] = originalIndex
      originalIndex += 1
      modelIndex += 1
      continue
    }
    if (modelIndex < model.length && PLACEMENT_APOSTROPHE.has(model[modelIndex]!)) {
      originAt[modelIndex] = originalIndex
      modelIndex += 1
      continue
    }
    if (originalIndex < original.length && PLACEMENT_APOSTROPHE.has(original[originalIndex]!)) {
      originalIndex += 1
      continue
    }
    return undefined
  }
  originAt[model.length] = original.length

  const snapped = new Map<number, string>()
  let start = 0
  for (let position = 0; position < indexes.length; position += 1) {
    const end = bounds[position]!
    const from = originAt[start]
    const to = originAt[end]
    if (from === undefined || to === undefined || to < from) return undefined
    snapped.set(indexes[position]!, original.slice(from, to))
    start = end
  }
  return snapped
}

/** First place `needle` occurs in `haystack` at or after `from`, using the same character equivalences as a style placement. */
export function findEquivalentSlice(
  haystack: string,
  needle: string,
  from = 0,
): { start: number; end: number } | undefined {
  if (!needle) return undefined
  for (let start = Math.max(0, from); start < haystack.length; start += 1) {
    const end = equivalentSpanEnd(haystack, needle, start)
    if (end !== undefined) return { start, end }
  }
  return undefined
}

function equivalentSpanEnd(haystack: string, needle: string, start: number): number | undefined {
  let haystackIndex = start
  let needleIndex = 0
  while (needleIndex < needle.length) {
    if (haystackIndex < haystack.length && haystack[haystackIndex] === "\u00AD") {
      haystackIndex += 1
      continue
    }
    if (needle[needleIndex] === "\u00AD") {
      needleIndex += 1
      continue
    }
    if (haystackIndex >= haystack.length) return undefined
    if (isPlacementSpace(haystack[haystackIndex]!) && isPlacementSpace(needle[needleIndex]!)) {
      while (haystackIndex < haystack.length && isPlacementSpace(haystack[haystackIndex]!)) haystackIndex += 1
      while (needleIndex < needle.length && isPlacementSpace(needle[needleIndex]!)) needleIndex += 1
      continue
    }
    if (!equivalentPlacementChar(haystack, needle, haystackIndex, needleIndex)) return undefined
    haystackIndex += 1
    needleIndex += 1
  }
  return haystackIndex
}

function equivalentPlacementChar(
  original: string,
  model: string,
  originalIndex: number,
  modelIndex: number,
): boolean {
  const left = original[originalIndex]!
  const right = model[modelIndex]!
  if (left === right) return true
  if (PLACEMENT_APOSTROPHE.has(left) && PLACEMENT_APOSTROPHE.has(right)) return true
  if (PLACEMENT_DASH.has(left) && PLACEMENT_DASH.has(right)) return true
  if ((left === "." && right === ":") || (left === ":" && right === ".")) {
    return isPlacementDigit(original[originalIndex - 1])
      && isPlacementDigit(original[originalIndex + 1])
      && isPlacementDigit(model[modelIndex - 1])
      && isPlacementDigit(model[modelIndex + 1])
  }
  return false
}

function isPlacementSpace(char: string): boolean {
  return char === " " || char === "\u00a0" || char === "\n" || char === "\t"
}

function isPlacementDigit(char: string | undefined): boolean {
  return char !== undefined && char >= "0" && char <= "9"
}

function currentTarget(
  cell: AlignStylesCell,
  metadata: IdmlFormatMetadataV2,
): PreparedAlignStyles["current"] {
  if (cell.originalHtml && cell.translatedHtml) {
    const validation = validateIdmlTranslation(cell.originalHtml, cell.translatedHtml, metadata)
    if (validation.valid) {
      // An unstyled preview keeps the sentence in `translated` and leaves every
      // editable run empty. Place that sentence; don't treat the empty runs as
      // the translation.
      const plain = cell.translated ?? ""
      if (editableSlotsAreEmpty(metadata, validation.slots) && plain.replace(/\u00a0/g, " ").trim()) {
        return { kind: "plain", text: plain }
      }
      const texts = new Map<number, string>()
      for (const index of metadata.editableSlotIndexes) {
        texts.set(index, validation.slots[index] ?? "")
      }
      return { kind: "slots", texts }
    }
  }
  const plain = (cell.translated ?? "").trim()
    || (cell.translatedHtml ? draftPlainTextFromBrokenIdml(cell.translatedHtml) : "")
  return { kind: "plain", text: plain }
}

function characterStylesBySlot(html: string): Map<number, string> {
  const styles = new Map<number, string>()
  if (typeof document === "undefined") return styles
  const container = document.createElement("div")
  container.innerHTML = sanitizeIdmlEditorHtml(html)
  for (const slot of container.querySelectorAll<HTMLElement>("span[data-idml-slot]")) {
    const index = Number(slot.getAttribute("data-idml-slot"))
    if (!Number.isInteger(index)) continue
    styles.set(index, slot.getAttribute("data-idml-character-style") ?? "")
  }
  return styles
}

function emphasisLabel(
  styleId: string,
  catalog: IdmlStyleCatalog | undefined,
  paragraphStyleId: string | undefined,
): StyleRunDescription["emphasis"] {
  const inheritParagraph = Boolean(paragraphStyleId) && isDefaultCharacterStyle(styleId)
  const { bold, italic } = idmlCharacterStyleEmphasis(
    inheritParagraph ? paragraphStyleId! : styleId,
    catalog,
  )
  if (bold && italic) return "bold italic"
  if (bold) return "bold"
  if (italic) return "italic"
  return "plain"
}

function isDefaultCharacterStyle(styleId: string): boolean {
  if (!styleId) return true
  return styleId.includes("[No character style]")
}

function editableSlotsAreEmpty(
  metadata: IdmlFormatMetadataV2,
  slots: readonly string[],
): boolean {
  return metadata.editableSlotIndexes.every((index) => {
    const text = slots[index] ?? ""
    return !text.includes("\n") && text.replace(/\u200b/g, "").replace(/\u00a0/g, " ").trim().length === 0
  })
}

function joined(indexes: readonly number[], texts: ReadonlyMap<number, string>): string {
  return indexes.map((index) => texts.get(index) ?? "").join("")
}

function readIdmlMetadata(cell: AlignStylesCell): IdmlFormatMetadataV2 | undefined {
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
  if (!Array.isArray(indexes) || !indexes.every((index) => Number.isInteger(index))) {
    return undefined
  }
  return candidate as IdmlFormatMetadataV2
}
