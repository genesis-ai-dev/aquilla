import {
  validateIdmlTranslation,
  type IdmlDiagnostic,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import { clearBiblicaApostropheGlue } from "@/lib/biblica/apostrophe-glue"
import { applyBiblicaProtectedHtmlReflow } from "@/lib/biblica/export-reflow"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"
import { plainTextFromProtectedHtml } from "./protected-html"

export interface IdmlCompletionCell {
  readonly id: string
  readonly originalHtml?: string
  readonly translatedHtml?: string
  readonly metadata?: Record<string, unknown> | null
}

export interface NormalizedCompletion {
  readonly value: string
  readonly valueHtml?: string
}

export interface IdmlRepairMessage {
  readonly role: "system" | "user" | "assistant"
  readonly content: string
}

/** Second-pass LLM call used only after an IDML draft fails anchor validation. */
export type IdmlStructureRepairFn = (
  messages: readonly IdmlRepairMessage[],
) => Promise<string>

export const IDML_COMPLETION_INSTRUCTION = [
  "IDML protected-anchor output contract:",
  "A Source value beginning with <p data-idml-version=\"2\"> is canonical protected HTML.",
  "Return that complete <p> element as the translation.",
  "Translate only text inside editable <span data-idml-slot> elements.",
  "Copy every tag and every data-idml-*, contenteditable, and character-style attribute exactly.",
  "Do not delete, duplicate, renumber, reorder, or rename slot or token elements.",
  "Do not add formatting, wrapper tags, comments, Markdown fences, or explanatory text.",
  "Bare <br> elements are allowed only inside an editable slot when the translation needs a line break.",
  "The application will reject the entire draft if the protected anchor sequence is not exact.",
].join("\n")

/** Repair asks for slot text only — the app stitches it into the source shell. */
export const IDML_STRUCTURE_REPAIR_INSTRUCTION = [
  "IDML slot-repair contract:",
  "You receive SOURCE protected HTML, the editable slots with their source text, and a BROKEN translation draft.",
  "Return STRICT JSON only, no prose, no Markdown fences:",
  '{"slots":[{"i":0,"t":"translated text for slot 0"},{"i":1,"t":"…"}]}',
  "Include every editable slot index listed below, even if a slot stays empty.",
  "Put the translated wording from the broken draft into the matching slots.",
  "Do not return HTML tags. Newlines inside a slot are allowed as \\n in the JSON string.",
].join("\n")

export function idmlCompletionPromptSource(
  cell: IdmlCompletionCell,
  fallbackSource: string,
): string {
  return idmlMetadata(cell)?.version === 2 && cell.originalHtml
    ? cell.originalHtml
    : fallbackSource
}

export function idmlCompletionSystemAddendum(
  cells: readonly IdmlCompletionCell[],
): string | undefined {
  return cells.some((cell) => idmlMetadata(cell)?.version === 2)
    ? IDML_COMPLETION_INSTRUCTION
    : undefined
}

/**
 * Strip common model wrappers (Markdown fences) so validation sees the HTML.
 */
export function unwrapIdmlCompletionOutput(raw: string): string {
  const trimmed = raw.trim()
  const fenced = /^```(?:html|xml|json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}

export function buildIdmlStructureRepairMessages(
  sourceHtml: string,
  brokenDraft: string,
  diagnostics: readonly IdmlDiagnostic[],
  editableSlots: ReadonlyMap<number, string>,
): IdmlRepairMessage[] {
  const errors = diagnostics.length > 0
    ? diagnostics.map((entry) => `- ${entry.code}: ${entry.message}`).join("\n")
    : "- ANCHOR_INVALID: the draft did not match the source protected HTML."
  const slotLines = [...editableSlots.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, text]) => `${index}: ${JSON.stringify(text)}`)
    .join("\n")
  return [
    { role: "system", content: IDML_STRUCTURE_REPAIR_INSTRUCTION },
    {
      role: "user",
      content: [
        "SOURCE (canonical protected HTML — for reference only; do not return HTML):",
        sourceHtml,
        "",
        "EDITABLE SLOTS (translate each; return every index):",
        slotLines || "(none)",
        "",
        "BROKEN DRAFT (recover its translated wording into the slots):",
        brokenDraft,
        "",
        "VALIDATION ERRORS:",
        errors,
        "",
        'Return JSON only: {"slots":[{"i":<index>,"t":"<text>"},…]}',
      ].join("\n"),
    },
  ]
}

/**
 * Convert model output into a persistence snapshot. Plain formats pass
 * through. IDML v2 accepts only canonical protected HTML whose exact anchor
 * identity/order validates against the source contract.
 */
export function normalizeProtectedCompletion(
  cell: IdmlCompletionCell,
  generated: string,
): NormalizedCompletion {
  const metadata = idmlMetadata(cell)
  if (!metadata) return { value: generated }
  if (!cell.originalHtml) {
    throw new IdmlCompletionError(
      `Cell ${cell.id} is missing protected source HTML. Re-import the original IDML before using AI drafting.`,
    )
  }

  let normalizedHtml = unwrapIdmlCompletionOutput(generated)
  let validation = validateIdmlTranslation(
    cell.originalHtml,
    normalizedHtml,
    metadata,
  )
  // Models sometimes preserve every editable slot identity and its translated
  // prose while changing a protected attribute (for example
  // adding contenteditable="false" to an editable slot) or dropping a
  // structural-only token.
  // Rebuild those responses from a known-good template, copying only the text
  // from each expected editable slot. If an expected multi-slot identity is
  // missing or duplicated, the mapping is ambiguous and still fails closed.
  if (!validation.valid) {
    normalizedHtml = repairEditableSlotCompletion(
      cell,
      normalizedHtml,
      metadata,
    )
    validation = validateIdmlTranslation(
      cell.originalHtml,
      normalizedHtml,
      metadata,
    )
  }
  if (!validation.valid) {
    throw new IdmlCompletionError(
      `The AI draft changed a protected IDML anchor in cell ${cell.id}; nothing was saved.`,
      validation.diagnostics,
    )
  }
  // AQU-1174: a model asked to translate a slot holding only the publisher's
  // apostrophe glue copies it through, gluing a stray `'` onto translated
  // words. Clearing the slot keeps its span — and so the anchor sequence — but
  // leaves the English typesetting out of the target text.
  const withoutGlue = clearBiblicaApostropheGlue(
    cell.metadata,
    cell.originalHtml,
    normalizedHtml,
    metadata,
  )
  if (withoutGlue !== normalizedHtml) {
    const cleared = validateIdmlTranslation(cell.originalHtml, withoutGlue, metadata)
    if (cleared.valid) {
      normalizedHtml = withoutGlue
      validation = cleared
    }
  }
  const reflowedHtml = applyBiblicaProtectedHtmlReflow(
    cell.metadata,
    cell.originalHtml,
    normalizedHtml,
    metadata,
  )
  if (reflowedHtml !== normalizedHtml) {
    const reflowed = validateIdmlTranslation(cell.originalHtml, reflowedHtml, metadata)
    if (reflowed.valid) {
      normalizedHtml = reflowedHtml
      validation = reflowed
    }
  }
  const hasEditableText = metadata.editableSlotIndexes.some(
    (index) => (validation.slots[index] ?? "").trim().length > 0,
  )
  if (!hasEditableText) {
    throw new IdmlCompletionError(
      `The AI returned no text inside the editable IDML slots for cell ${cell.id}; nothing was saved.`,
    )
  }
  return {
    value: plainTextFromProtectedHtml(normalizedHtml, validation.slots),
    valueHtml: normalizedHtml,
  }
}

/**
 * Stitch translated slot texts into the cell's SOURCE protected HTML shell.
 * The model never rebuilds tags — only the editable text nodes change.
 */
export function stitchIdmlSlotTexts(
  cell: IdmlCompletionCell,
  slotTexts: ReadonlyMap<number, string>,
): NormalizedCompletion {
  const metadata = idmlMetadata(cell)
  if (!metadata || !cell.originalHtml) {
    throw new IdmlCompletionError(
      `Cell ${cell.id} is missing protected source HTML. Re-import the original IDML before using AI drafting.`,
    )
  }
  if (typeof document === "undefined") {
    throw new IdmlCompletionError(
      `Cell ${cell.id} IDML slot stitching requires a browser document.`,
    )
  }

  const container = document.createElement("div")
  // [Pen test] Input validation & injection (2026-09-02): sanitize before
  // parsing — cell.originalHtml is stored source content and is not
  // guaranteed to be the canonical protected shape until after this parse,
  // so an unsanitized assignment here is a DOM XSS sink.
  container.innerHTML = sanitizeIdmlEditorHtml(cell.originalHtml)
  const paragraph = container.firstElementChild
  if (!(paragraph instanceof HTMLParagraphElement) || container.children.length !== 1) {
    throw new IdmlCompletionError(
      `Cell ${cell.id} source is not one canonical IDML paragraph.`,
    )
  }

  for (const index of metadata.editableSlotIndexes) {
    const slot = paragraph.querySelector<HTMLElement>(`span[data-idml-slot="${index}"]`)
    if (!slot) {
      throw new IdmlCompletionError(
        `Cell ${cell.id} is missing protected IDML slot ${index}.`,
      )
    }
    replaceSlotContent(slot, slotTexts.get(index) ?? "")
  }

  return normalizeProtectedCompletion(cell, paragraph.outerHTML)
}

export function parseIdmlSlotRepairReply(
  raw: string,
  editableIndexes: readonly number[],
): Map<number, string> {
  const text = unwrapIdmlCompletionOutput(raw)
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new IdmlCompletionError(
      "The AI structure repair did not return JSON slot text.",
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    throw new IdmlCompletionError(
      "The AI structure repair returned invalid JSON.",
    )
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new IdmlCompletionError(
      "The AI structure repair returned a JSON value that is not an object.",
    )
  }

  const map = new Map<number, string>()
  const slotsValue = (parsed as { slots?: unknown }).slots ?? parsed
  if (Array.isArray(slotsValue)) {
    for (const entry of slotsValue) {
      if (typeof entry !== "object" || entry === null) continue
      const record = entry as Record<string, unknown>
      const index = Number(record.i ?? record.index ?? record.slot)
      const value = record.t ?? record.text ?? record.value
      if (Number.isInteger(index) && typeof value === "string") {
        map.set(index, value)
      }
    }
  } else if (typeof slotsValue === "object" && slotsValue !== null) {
    for (const [key, value] of Object.entries(slotsValue)) {
      const index = Number(key)
      if (Number.isInteger(index) && typeof value === "string") {
        map.set(index, value)
      }
    }
  }

  for (const index of editableIndexes) {
    if (!map.has(index)) map.set(index, "")
  }
  if (![...map.values()].some((value) => value.trim().length > 0)) {
    throw new IdmlCompletionError(
      "The AI structure repair returned empty text for every editable slot.",
    )
  }
  return map
}

function isRepairableIdmlFailure(
  cell: IdmlCompletionCell,
  error: unknown,
): error is IdmlCompletionError {
  if (!(error instanceof IdmlCompletionError)) return false
  if (!cell.originalHtml) return false
  // Structural failures only — missing source HTML / unsupported metadata are
  // not something a second model call can invent.
  if (/unsupported IDML metadata|missing protected source HTML/i.test(error.message)) {
    return false
  }
  return (
    error.diagnostics.length > 0
    || /protected IDML anchor|malformed|no text inside the editable/i.test(error.message)
  )
}

function editableSourceSlots(
  cell: IdmlCompletionCell,
  metadata: IdmlFormatMetadataV2,
): Map<number, string> {
  const sourceHtml = cell.originalHtml!
  const validation = validateIdmlTranslation(sourceHtml, sourceHtml, metadata)
  const map = new Map<number, string>()
  for (const index of metadata.editableSlotIndexes) {
    map.set(index, validation.valid ? (validation.slots[index] ?? "") : "")
  }
  return map
}

/** Plain wording recovered from a broken draft (HTML or free text). */
export function draftPlainTextFromBrokenIdml(brokenDraft: string): string {
  const unwrapped = unwrapIdmlCompletionOutput(brokenDraft)
  if (!unwrapped.includes("<") || typeof document === "undefined") {
    return unwrapped.trim()
  }
  const container = document.createElement("div")
  // [Pen test] Input validation & injection (2026-09-02): brokenDraft is raw
  // model output by definition (this function only runs on drafts that
  // already failed anchor validation) — sanitize before parsing.
  container.innerHTML = sanitizeIdmlEditorHtml(unwrapped)
  for (const lineBreak of container.querySelectorAll("br")) {
    lineBreak.replaceWith(document.createTextNode("\n"))
  }
  return (container.textContent ?? unwrapped).trim()
}

/**
 * When there is exactly one editable slot, drop the broken markup and put the
 * draft's plain text into that slot of the SOURCE shell — no second model call.
 */
export function tryDeterministicIdmlSlotStitch(
  cell: IdmlCompletionCell,
  brokenDraft: string,
): NormalizedCompletion | undefined {
  const metadata = idmlMetadata(cell)
  if (!metadata || !cell.originalHtml || metadata.editableSlotIndexes.length !== 1) {
    return undefined
  }
  const plain = draftPlainTextFromBrokenIdml(brokenDraft)
  if (!plain) return undefined
  const index = metadata.editableSlotIndexes[0]
  try {
    return stitchIdmlSlotTexts(cell, new Map([[index, plain]]))
  } catch {
    return undefined
  }
}

/**
 * Validate an IDML AI draft; if anchors are broken, recover by stitching text
 * into the SOURCE shell (deterministic for single-slot cells, otherwise one
 * slot-JSON LLM repair). Non-IDML cells behave like `normalizeProtectedCompletion`.
 */
export async function normalizeProtectedCompletionWithRepair(
  cell: IdmlCompletionCell,
  generated: string,
  repair: IdmlStructureRepairFn,
): Promise<NormalizedCompletion> {
  try {
    return normalizeProtectedCompletion(cell, generated)
  } catch (error) {
    if (!isRepairableIdmlFailure(cell, error)) throw error
    const metadata = idmlMetadata(cell)
    if (!metadata || !cell.originalHtml) throw error

    const brokenDraft = unwrapIdmlCompletionOutput(generated)
    const deterministic = tryDeterministicIdmlSlotStitch(cell, brokenDraft)
    if (deterministic) return deterministic

    const editableSlots = editableSourceSlots(cell, metadata)
    const repaired = await repair(
      buildIdmlStructureRepairMessages(
        cell.originalHtml,
        brokenDraft,
        error.diagnostics,
        editableSlots,
      ),
    )
    if (!repaired.trim()) {
      throw new IdmlCompletionError(
        `The AI structure repair returned an empty draft for cell ${cell.id}; nothing was saved.`,
        error.diagnostics,
      )
    }
    try {
      const slotTexts = parseIdmlSlotRepairReply(
        repaired,
        metadata.editableSlotIndexes,
      )
      return stitchIdmlSlotTexts(cell, slotTexts)
    } catch (repairError) {
      if (repairError instanceof IdmlCompletionError) {
        throw new IdmlCompletionError(
          `The AI draft changed a protected IDML anchor in cell ${cell.id}; a repair pass also failed. Nothing was saved.`,
          repairError.diagnostics.length > 0 ? repairError.diagnostics : error.diagnostics,
        )
      }
      throw repairError
    }
  }
}

export class IdmlCompletionError extends Error {
  readonly diagnostics: readonly IdmlDiagnostic[]

  constructor(message: string, diagnostics: readonly IdmlDiagnostic[] = []) {
    super(diagnostics[0]?.message ? `${message} ${diagnostics[0].message}` : message)
    this.name = "IdmlCompletionError"
    this.diagnostics = diagnostics
  }
}

function idmlMetadata(cell: IdmlCompletionCell): IdmlFormatMetadataV2 | undefined {
  if (
    !cell.metadata
    || !Object.prototype.hasOwnProperty.call(cell.metadata, "idml")
  ) {
    return undefined
  }
  const candidate = cell.metadata?.idml
  if (
    typeof candidate !== "object"
    || candidate === null
    || Array.isArray(candidate)
    || (candidate as { version?: unknown }).version !== 2
  ) {
    const version = typeof candidate === "object" && candidate !== null
      ? (candidate as { version?: unknown }).version
      : undefined
    throw new IdmlCompletionError(
      `Cell ${cell.id} uses unsupported IDML metadata version ${String(version ?? "unknown")}. Upgrade or re-import it before AI drafting.`,
    )
  }
  return candidate as IdmlFormatMetadataV2
}

function repairEditableSlotCompletion(
  cell: IdmlCompletionCell,
  generated: string,
  metadata: IdmlFormatMetadataV2,
): string {
  if (typeof document === "undefined") {
    throw new IdmlCompletionError(
      `Cell ${cell.id} requires protected IDML reconstruction in a browser.`,
    )
  }
  if (metadata.editableSlotIndexes.length === 0) {
    throw new IdmlCompletionError(
      `Cell ${cell.id} has no editable IDML slot for the AI draft.`,
    )
  }

  const generatedContainer = document.createElement("div")
  // [Pen test] Input validation & injection (2026-09-02): `generated` is raw
  // model output — sanitize before parsing, same as the other IDML sinks.
  generatedContainer.innerHTML = sanitizeIdmlEditorHtml(unwrapIdmlCompletionOutput(generated))
  const translatedSlots = new Map<number, string>()
  for (const editableIndex of metadata.editableSlotIndexes) {
    const matches = generatedContainer.querySelectorAll<HTMLElement>(
      `span[data-idml-slot="${editableIndex}"]`,
    )
    if (matches.length === 1) {
      translatedSlots.set(editableIndex, textWithLineBreaks(matches[0]))
    }
  }

  // Plain output has no slot identity. It is safe only when exactly one slot
  // can receive it; a multi-slot paragraph cannot be repartitioned reliably.
  if (
    translatedSlots.size === 0
    && metadata.editableSlotIndexes.length === 1
    && !generatedContainer.querySelector("[data-idml-version], [data-idml-slot], [data-idml-token]")
  ) {
    translatedSlots.set(
      metadata.editableSlotIndexes[0],
      textWithLineBreaks(generatedContainer),
    )
  }
  if (translatedSlots.size !== metadata.editableSlotIndexes.length) {
    throw new IdmlCompletionError(
      `The AI draft changed a protected IDML anchor in cell ${cell.id}; nothing was saved.`,
    )
  }

  const templateHtml = validTemplateHtml(cell, metadata)
  const templateContainer = document.createElement("div")
  // [Pen test] Input validation & injection (2026-09-02): validTemplateHtml
  // falls back to cell.originalHtml, which is not schema-validated — sanitize
  // before parsing, defense-in-depth alongside the other IDML sinks.
  templateContainer.innerHTML = sanitizeIdmlEditorHtml(templateHtml)
  const paragraph = templateContainer.firstElementChild
  if (!(paragraph instanceof HTMLParagraphElement) || templateContainer.children.length !== 1) {
    throw new IdmlCompletionError(
      `Cell ${cell.id} does not contain one canonical IDML paragraph.`,
    )
  }
  for (const editableIndex of metadata.editableSlotIndexes) {
    const slot = paragraph.querySelector<HTMLElement>(
      `span[data-idml-slot="${editableIndex}"]`,
    )
    if (!slot) {
      throw new IdmlCompletionError(
        `Cell ${cell.id} is missing protected IDML slot ${editableIndex}.`,
      )
    }
    replaceSlotContent(slot, translatedSlots.get(editableIndex) ?? "")
  }
  return paragraph.outerHTML
}

function validTemplateHtml(
  cell: IdmlCompletionCell,
  metadata: IdmlFormatMetadataV2,
): string {
  if (
    cell.translatedHtml
    && validateIdmlTranslation(cell.originalHtml!, cell.translatedHtml, metadata).valid
  ) {
    return cell.translatedHtml
  }
  return cell.originalHtml!
}

function textWithLineBreaks(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement
  for (const unsafe of clone.querySelectorAll("script, style")) unsafe.remove()
  for (const lineBreak of clone.querySelectorAll("br")) {
    lineBreak.replaceWith(document.createTextNode("\n"))
  }
  return clone.textContent ?? ""
}

function replaceSlotContent(slot: HTMLElement, text: string): void {
  const parts = text.split("\n")
  slot.replaceChildren()
  for (let index = 0; index < parts.length; index += 1) {
    if (index > 0) slot.append(document.createElement("br"))
    slot.append(document.createTextNode(parts[index] ?? ""))
  }
}
