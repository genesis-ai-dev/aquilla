/**
 * AQU-1174: the "source serif" apostrophe glue in Biblica's English InDesign
 * templates.
 *
 * English study-Bible templates set the apostrophe inside a possessive
 * ("Israelʼs") as its own character run, so the paragraph imports as
 * `[Israel][ʼ][s covenant history]` — three protected IDML slots. The middle
 * one is typesetting for the English wording, not text: it belongs to the way
 * InDesign kerns the possessive and has no counterpart in Marathi.
 *
 * The importer already leaves every editable slot empty in the target, so the
 * glue only reaches a translation when the AI draft copies the source
 * apostrophe straight through — which is exactly what models do with a slot
 * whose whole content is punctuation. It then rides along inside translated
 * words as a stray `'`, and partners reasonably conclude their translation must
 * keep the publisher's punctuation.
 *
 * Front and back matter is prose-heavy English where the same runs are ordinary
 * possessives and contractions, so there the apostrophe is real text and is
 * left alone — the same split `noteHasVisibleText` already makes at import.
 */

import type { IdmlFormatMetadataV2 } from "@aquilla/idml-roundtrip"
import { isStructuralApostropheContent, isStructuralApostropheSegment } from "./note-rules"

/** Cell metadata bucket written by the Biblica study-notes importer. */
interface BiblicaCellMetadata {
  readonly contentType?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * True for a cell imported from a Biblica *book* volume — the study notes that
 * sit beside scripture. Front/back matter volumes carry `front-back-matter`,
 * and a non-Biblica IDML cell carries no bucket at all.
 */
export function isBiblicaBookVolumeCell(
  cellMetadata: Record<string, unknown> | null | undefined,
): boolean {
  const biblica = cellMetadata?.biblica
  return isRecord(biblica) && (biblica as BiblicaCellMetadata).contentType === "notes"
}

/**
 * The editable slots whose SOURCE is publisher glue: a "source serif" character
 * run, or a run whose whole text is apostrophes.
 */
export function biblicaApostropheGlueSlots(
  sourceHtml: string,
  metadata: IdmlFormatMetadataV2,
): ReadonlySet<number> {
  const glue = new Set<number>()
  if (typeof document === "undefined") return glue
  const container = document.createElement("div")
  container.innerHTML = sourceHtml
  for (const index of metadata.editableSlotIndexes) {
    const slot = container.querySelector<HTMLElement>(`span[data-idml-slot="${index}"]`)
    if (!slot) continue
    const characterStyle = slot.getAttribute("data-idml-character-style") ?? undefined
    if (isStructuralApostropheSegment(slot.textContent ?? "", characterStyle)) glue.add(index)
  }
  return glue
}

/**
 * Drop English apostrophe glue an AI draft copied into the target.
 *
 * Only a glue slot the draft filled with nothing but apostrophes is cleared: if
 * the model put real words there it is translation, not typesetting, and is
 * kept. Clearing a slot leaves its span in place, so the protected anchor
 * sequence — and therefore the export — is untouched.
 */
export function clearBiblicaApostropheGlue(
  cellMetadata: Record<string, unknown> | null | undefined,
  sourceHtml: string,
  targetHtml: string,
  metadata: IdmlFormatMetadataV2,
): string {
  if (!isBiblicaBookVolumeCell(cellMetadata) || typeof document === "undefined") return targetHtml
  const glue = biblicaApostropheGlueSlots(sourceHtml, metadata)
  if (glue.size === 0) return targetHtml

  const container = document.createElement("div")
  container.innerHTML = targetHtml
  const paragraph = container.firstElementChild
  if (!(paragraph instanceof HTMLParagraphElement) || container.children.length !== 1) {
    return targetHtml
  }
  let changed = false
  for (const index of glue) {
    const slot = paragraph.querySelector<HTMLElement>(`span[data-idml-slot="${index}"]`)
    if (!slot || !isStructuralApostropheContent(slot.textContent ?? "")) continue
    slot.replaceChildren()
    changed = true
  }
  return changed ? paragraph.outerHTML : targetHtml
}
