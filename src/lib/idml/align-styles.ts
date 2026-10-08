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
  const currentLines = prepared.current.kind === "plain"
    ? [
      "CURRENT TRANSLATION (not split across runs yet):",
      JSON.stringify(prepared.current.text),
    ].join("\n")
    : [
      "CURRENT TRANSLATION (runs may hold the wrong words; this wording is already final):",
      ...editableIndexes.map((index) =>
        `${index} | ${JSON.stringify(prepared.current.kind === "slots" ? prepared.current.texts.get(index) ?? "" : "")}`,
      ),
    ].join("\n")

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
  const reply = await ask(buildIdmlAlignStylesMessages(cell))
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

  const placed = joined(prepared.metadata.editableSlotIndexes, slotTexts)
  if (idmlWordingKey(placed) !== prepared.wording) {
    throw new Error(t("editor.idml.alignStylesChangedWording"))
  }

  let completion: NormalizedCompletion
  try {
    completion = stitchIdmlSlotTexts(cell, slotTexts)
  } catch (error) {
    console.warn("[align-styles] stitch failed", error)
    throw new Error(t("editor.idml.alignStylesFailed"))
  }

  const changed = prepared.current.kind === "plain"
    || prepared.metadata.editableSlotIndexes.some((index) =>
      (prepared.current.kind === "slots" ? prepared.current.texts.get(index) ?? "" : "")
      !== (slotTexts.get(index) ?? ""),
    )
  return { completion, changed }
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
  const wording = current.kind === "plain"
    ? idmlWordingKey(current.text)
    : idmlWordingKey(joined(metadata.editableSlotIndexes, current.texts))
  if (!wording) {
    throw new Error(t("editor.ai.alignStylesNeedsText"))
  }
  return { metadata, runs, wording, current }
}

function currentTarget(
  cell: AlignStylesCell,
  metadata: IdmlFormatMetadataV2,
): PreparedAlignStyles["current"] {
  if (cell.originalHtml && cell.translatedHtml) {
    const validation = validateIdmlTranslation(cell.originalHtml, cell.translatedHtml, metadata)
    if (validation.valid) {
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
