/**
 * An untranslated IDML cell is typed as one unstyled preview. The words stay
 * out of the source's style runs until the translator passes them across, or
 * an AI draft writes the runs directly. The visible-style-segments toggle only
 * paints runs that already hold a translation.
 */

import type { IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { sanitizeIdmlEditorHtml } from "@/lib/richtext/editor-content"
import {
  stitchIdmlSlotTexts,
  type IdmlCompletionCell,
  type NormalizedCompletion,
} from "@/lib/idml/completion"

export function readIdmlMetadataV2(
  metadata: Record<string, unknown> | null | undefined,
): IdmlFormatMetadataV2 | undefined {
  const candidate = metadata?.idml
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
  if (indexes.length === 0) return undefined
  return candidate as IdmlFormatMetadataV2
}

/**
 * True when no editable run holds the translation yet. Missing HTML is an
 * untranslated cell, and so is a blank copy of the source runs.
 *
 * HTML with no run markup at all is a preview too: a translation typed as a
 * plain sentence before the cell had its IDML contract. A file a source link
 * mirrored before the link carried the import envelope was translated that
 * way, and received the contract later (sync-worker link-envelope.ts). Its
 * `<p>Qajeelfama Leenjisaa</p>` has no run for the IDML editor to open — handed
 * to it, the words vanished and there was no caret, on a line that was a
 * perfectly good, often validated, translation. As a preview it stays a
 * sentence the translator can read and edit, and passes into the runs like any
 * other preview.
 */
export function idmlTargetIsPreview(
  html: string | undefined,
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const idml = readIdmlMetadataV2(metadata)
  if (!idml) return false
  if (!html?.trim()) return true
  if (typeof document === "undefined") return false

  const container = document.createElement("div")
  container.innerHTML = sanitizeIdmlEditorHtml(html)
  const slots = container.querySelectorAll<HTMLElement>("span[data-idml-protected=\"slot\"]")
  if (slots.length === 0) return true

  const editable = new Set(idml.editableSlotIndexes)
  let sawEditable = false
  for (const slot of slots) {
    const index = Number(slot.getAttribute("data-idml-slot"))
    if (!editable.has(index)) continue
    sawEditable = true
    if (slot.querySelector("br")) return false
    if ((slot.textContent ?? "").replace(/\u200b/g, "").length > 0) return false
  }
  return sawEditable
}

/** Canonical target shell: locked runs keep their text, editable runs are cleared. */
export function emptyIdmlEditableHtml(
  sourceHtml: string,
  metadata: IdmlFormatMetadataV2,
): string {
  if (typeof document === "undefined") return sourceHtml
  const template = document.createElement("template")
  template.innerHTML = sanitizeIdmlEditorHtml(sourceHtml)
  const editable = new Set(metadata.editableSlotIndexes)
  for (const slot of template.content.querySelectorAll<HTMLElement>(
    "span[data-idml-protected=\"slot\"][data-idml-slot]",
  )) {
    const index = Number(slot.getAttribute("data-idml-slot"))
    if (Number.isSafeInteger(index) && editable.has(index)) slot.replaceChildren()
  }
  const container = document.createElement("div")
  container.append(template.content.cloneNode(true))
  return container.innerHTML
}

/**
 * A cell with one editable run has nowhere for the model to distribute words.
 * The preview sentence becomes that run, and takes its style.
 */
export function placeIdmlPreviewInOnlySlot(
  cell: IdmlCompletionCell,
  text: string,
): NormalizedCompletion {
  const metadata = readIdmlMetadataV2(cell.metadata)
  const index = metadata?.editableSlotIndexes.length === 1
    ? metadata.editableSlotIndexes[0]
    : undefined
  if (index === undefined) {
    throw new Error("This cell has more than one style run")
  }
  return stitchIdmlSlotTexts(cell, new Map([[index, text]]))
}
