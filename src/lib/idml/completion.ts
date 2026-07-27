import {
  validateIdmlTranslation,
  type IdmlDiagnostic,
  type IdmlFormatMetadataV2,
} from "@aquilla/idml-roundtrip"
import { plainTextFromProtectedHtml } from "./protected-html"

export interface IdmlCompletionCell {
  readonly id: string
  readonly originalHtml?: string
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

  const validation = validateIdmlTranslation(
    cell.originalHtml,
    generated,
    metadata,
  )
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
    value: plainTextFromProtectedHtml(generated, validation.slots),
    valueHtml: generated,
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
