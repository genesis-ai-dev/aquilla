// The document preview's data: the file an export would write now, built in
// the browser from the stored original and the cells on screen.
//
// It calls the same exporters with the same cell scoping as the export dialog
// (ExportDialog's docx, pptx and idml branches, content mode "current"), so the
// text in the preview is the text in the download.

import type { CellData } from "@/hooks/useCells"
import { hiddenRoundTripRemovals, scopeRoundTripCells } from "@/lib/export/validation-scope"
import type { RemovedCellRecord } from "@/lib/sync/source-export"

/**
 * The formats with a preview. Word and PowerPoint are drawn as the document
 * they are; InDesign is drawn as its text in reading order (idml-flow.ts),
 * because nothing in a browser can draw its pages.
 */
export type DocumentPreviewKind = "docx" | "pptx" | "idml"

export function documentPreviewKind(fileType: string | null | undefined): DocumentPreviewKind | null {
  return fileType === "docx" || fileType === "pptx" || fileType === "idml" ? fileType : null
}

export interface BuildPreviewOptions {
  /** Source cells the file has lost (`fetchRemovedCells`): their paragraphs leave the document. */
  removedCells?: readonly RemovedCellRecord[]
  /** BCP 47 code of the translation's language, when the project knows one. */
  targetLanguage?: string | null
}

/**
 * The translated document's bytes, as the export would write them now.
 *
 * Throws when the export does: the InDesign export refuses to write a package
 * while any translation fails its proof (a protected mark missing from a line
 * still being typed, say). `original` is left usable either way.
 */
export async function buildPreviewDocument(
  kind: DocumentPreviewKind,
  original: ArrayBuffer,
  cells: CellData[],
  options: BuildPreviewOptions = {},
): Promise<ArrayBuffer> {
  const removedCells = [...(options.removedCells ?? []), ...hiddenRoundTripRemovals(cells)]
  const scoped = scopeRoundTripCells(cells, "current")
  if (kind === "docx") {
    const { exportDocx } = await import("@/lib/export/exporters/docx")
    const result = await exportDocx(original, scoped, { removedCells, targetLanguage: options.targetLanguage })
    return result.blob.arrayBuffer()
  }
  if (kind === "idml") {
    const { exportIdml } = await import("@/lib/export/exporters/idml")
    // The export hands its buffer to a worker and loses it: give it a copy.
    const result = await exportIdml(original.slice(0), scoped)
    return result.blob.arrayBuffer()
  }
  const { exportPptx } = await import("@/lib/export/exporters/pptx")
  const result = await exportPptx(original, scoped, { removedCells })
  return result.blob.arrayBuffer()
}

/**
 * What the preview depends on in the cells: a rebuild is due only when this
 * changes. Validation, comments and audio change cells too, and none of them
 * changes the document.
 */
export function previewSignature(cells: readonly CellData[]): string {
  let out = ""
  for (const cell of cells) {
    out += `${cell.id}\u0001${cell.hidden ? 1 : 0}\u0001${cell.translatedHtml ?? ""}\u0001${cell.translated}\u0002`
  }
  return out
}
