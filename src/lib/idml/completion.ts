import {
  validateIdmlTranslation,
  type IdmlDiagnostic,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
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

  let normalizedHtml = generated
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
      generated,
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
  generatedContainer.innerHTML = stripMarkdownFence(generated)
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
      metadata.editableSlotIndexes[0]!,
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
  templateContainer.innerHTML = templateHtml
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
    replaceSlotText(slot, translatedSlots.get(editableIndex) ?? "")
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

function stripMarkdownFence(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^```(?:html)?\s*\n?([\s\S]*?)\n?\s*```$/i)
  return match?.[1]?.trim() ?? trimmed
}

function textWithLineBreaks(element: HTMLElement): string {
  const clone = element.cloneNode(true) as HTMLElement
  for (const unsafe of clone.querySelectorAll("script, style")) unsafe.remove()
  for (const lineBreak of clone.querySelectorAll("br")) {
    lineBreak.replaceWith(document.createTextNode("\n"))
  }
  return clone.textContent ?? ""
}

function replaceSlotText(slot: HTMLElement, text: string): void {
  const lines = text.split("\n")
  slot.replaceChildren()
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0) slot.append(document.createElement("br"))
    slot.append(document.createTextNode(lines[index] ?? ""))
  }
}
