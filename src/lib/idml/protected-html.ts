import {
  validateIdmlTranslation,
  type IdmlDiagnostic,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"

export interface ProtectedIdmlCell {
  readonly id: string
  readonly originalHtml?: string
  readonly translatedHtml?: string
  readonly metadata?: Record<string, unknown> | null
}

export interface ProtectedIdmlSnapshot {
  readonly value: string
  readonly valueHtml: string
}

export function hasIdmlMetadata(cell: ProtectedIdmlCell): boolean {
  return Boolean(
    cell.metadata
    && Object.prototype.hasOwnProperty.call(cell.metadata, "idml"),
  )
}

/**
 * Apply a literal find/replace independently inside each editable IDML slot.
 * Cross-slot matches are rejected by the expectedPlain check rather than
 * flattening protected style/token boundaries.
 */
export function replaceProtectedIdmlText(
  cell: ProtectedIdmlCell,
  find: string,
  replacement: string,
  expectedPlain?: string,
): ProtectedIdmlSnapshot {
  const metadata = idmlMetadata(cell)
  if (!metadata || !cell.originalHtml || !cell.translatedHtml) {
    throw new ProtectedIdmlHtmlError(
      `Cell ${cell.id} is missing its IDML v2 source or target contract. Re-import the original IDML before replacing text.`,
    )
  }
  if (!find) {
    throw new ProtectedIdmlHtmlError("IDML find text cannot be empty.")
  }
  if (typeof document === "undefined") {
    throw new ProtectedIdmlHtmlError("Protected IDML replacement requires a browser document.")
  }

  const current = validateIdmlTranslation(
    cell.originalHtml,
    cell.translatedHtml,
    metadata,
  )
  if (!current.valid) {
    throw new ProtectedIdmlHtmlError(
      `Cell ${cell.id} has an invalid protected IDML target; replacement was blocked.`,
      current.diagnostics,
    )
  }

  const container = document.createElement("div")
  container.innerHTML = cell.translatedHtml
  const paragraph = container.firstElementChild
  if (!(paragraph instanceof HTMLParagraphElement) || container.children.length !== 1) {
    throw new ProtectedIdmlHtmlError(`Cell ${cell.id} does not contain one canonical IDML paragraph.`)
  }
  for (const index of metadata.editableSlotIndexes) {
    const slot = paragraph.querySelector<HTMLElement>(`span[data-idml-slot="${index}"]`)
    if (!slot) {
      throw new ProtectedIdmlHtmlError(`Cell ${cell.id} is missing protected IDML slot ${index}.`)
    }
    replaceSlotContent(
      slot,
      (current.slots[index] ?? "").split(find).join(replacement),
    )
  }

  const valueHtml = paragraph.outerHTML
  const updated = validateIdmlTranslation(cell.originalHtml, valueHtml, metadata)
  if (!updated.valid) {
    throw new ProtectedIdmlHtmlError(
      `Cell ${cell.id} replacement changed a protected IDML anchor.`,
      updated.diagnostics,
    )
  }
  const value = plainTextFromProtectedHtml(valueHtml, updated.slots)
  if (expectedPlain !== undefined && value !== expectedPlain) {
    throw new ProtectedIdmlHtmlError(
      `The requested replacement for cell ${cell.id} crosses an IDML style or token boundary and was not applied.`,
    )
  }
  return { value, valueHtml }
}

export function plainTextFromProtectedHtml(
  html: string,
  fallbackSlots: readonly string[],
): string {
  if (typeof document === "undefined") return fallbackSlots.join("")
  const container = document.createElement("div")
  container.innerHTML = html
  for (const lineBreak of container.querySelectorAll("br")) {
    lineBreak.replaceWith(document.createTextNode("\n"))
  }
  return container.textContent ?? fallbackSlots.join("")
}

/** Editable runs in order. Empty glue slots add nothing. */
export function idmlEditableSlotText(
  slots: readonly string[],
  editableSlotIndexes: readonly number[],
): string {
  return editableSlotIndexes.map((index) => slots[index] ?? "").join("")
}

/**
 * A trailing line break from a protected `br` is not a different translation.
 * A missing "." or space is.
 */
export function idmlPlainMatchesTranslation(actual: string, expected: string): boolean {
  return actual.replace(/\n+$/g, "") === expected.replace(/\n+$/g, "")
}

/**
 * Keep a partner reflow when it still spells the stored translation. Moving a
 * period from a bold run into the following plain run does not change the
 * words. Keep the current HTML only when that reflow would drop a character
 * the translation still has.
 */
export function chooseIdmlHtmlMatchingTranslation(
  currentHtml: string,
  reflowedHtml: string,
  currentText: string,
  reflowedText: string,
  translation: string,
): string {
  if (idmlPlainMatchesTranslation(reflowedText, translation)) return reflowedHtml
  if (idmlPlainMatchesTranslation(currentText, translation)) return currentHtml
  return reflowedHtml
}

export class ProtectedIdmlHtmlError extends Error {
  readonly diagnostics: readonly IdmlDiagnostic[]

  constructor(message: string, diagnostics: readonly IdmlDiagnostic[] = []) {
    super(diagnostics[0]?.message ? `${message} ${diagnostics[0].message}` : message)
    this.name = "ProtectedIdmlHtmlError"
    this.diagnostics = diagnostics
  }
}

function idmlMetadata(cell: ProtectedIdmlCell): IdmlFormatMetadataV2 | undefined {
  if (!hasIdmlMetadata(cell)) return undefined
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
    throw new ProtectedIdmlHtmlError(
      `Cell ${cell.id} uses unsupported IDML metadata version ${String(version ?? "unknown")}. Upgrade or re-import it before editing.`,
    )
  }
  return candidate as IdmlFormatMetadataV2
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
 * Whether a target carries translated words at all, read off the HTML's own
 * attributes rather than the cell's metadata.
 *
 * The question comes up when the two disagree: a linked file took its source
 * from an upstream whose IDML changed, or a re-import changed which runs are
 * editable, and the stored target is still the shell of the old source. Such
 * a shell cannot be validated — the slot it marks editable is locked now, or
 * the other way round — but when nothing was ever typed into it there is no
 * translation to carry over, and the paragraph exports as the publisher set it.
 *
 * Text inside a slot the HTML leaves editable is a translation. Locked slots
 * hold the source's own literal text (a verse number, a label) and say nothing.
 * Markup that is not a slot document at all is read as plain text, so a target
 * this function does not understand still blocks the export when it has words.
 */
export function idmlTargetHoldsTranslation(html: string | undefined): boolean {
  if (!html?.trim()) return false
  if (typeof document !== "undefined") {
    const template = document.createElement("template")
    template.innerHTML = html
    const slots = template.content.querySelectorAll<HTMLElement>("span[data-idml-protected=\"slot\"]")
    if (slots.length === 0) return hasVisibleText(template.content.textContent)
    for (const slot of slots) {
      if (slot.getAttribute("contenteditable") === "false") continue
      if (slot.querySelector("br")) return true
      if (hasVisibleText(slot.textContent)) return true
    }
    return false
  }
  // No DOM (a worker, a test without happy-dom): drop every locked span and
  // protected token, then look for words in what remains.
  const withoutLocked = html.replace(
    /<span\b[^>]*\bcontenteditable="false"[^>]*>[\s\S]*?<\/span>/gi,
    "",
  )
  if (/<br\b/i.test(withoutLocked)) return true
  return hasVisibleText(withoutLocked.replace(/<[^>]+>/g, ""))
}

function hasVisibleText(text: string | null): boolean {
  return (text ?? "").replace(/\u200b/g, "").trim().length > 0
}
