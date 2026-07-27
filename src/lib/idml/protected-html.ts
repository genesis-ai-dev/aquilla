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
