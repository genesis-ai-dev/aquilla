// An InDesign translation is typed as one unstyled sentence and stays outside
// the source's style runs until the translator passes it across
// (src/lib/idml/preview-segment.ts). The export refuses a file that holds such
// a sentence, and the export dialog offers to place them first.
//
// The preview cannot wait for that: a line being typed is always unplaced.
// So it places them itself, on a copy of the cells that is never saved:
//
//   - one style run: the sentence becomes that run, exactly as "Pass to style
//     segments" would write it. What the preview shows is what placing gives.
//   - several style runs: only a person or the model can say which words go
//     in which run. The preview puts the whole sentence in the first run and
//     counts the line, so the panel can say its styling is not final.

import type { CellData } from "@/hooks/useCells"
import { idmlReimportPlacement } from "@/lib/idml/align-reimported-targets"
import { stitchIdmlSlotTexts } from "@/lib/idml/completion"
import { placeIdmlPreviewInOnlySlot, readIdmlMetadataV2 } from "@/lib/idml/preview-segment"

export interface PreviewPlacement {
  cells: CellData[]
  /** Lines with several style runs, shown with the sentence in the first. */
  approximated: number
}

export function placeIdmlTranslationsForPreview(cells: CellData[]): PreviewPlacement {
  let approximated = 0
  const placed = cells.map((cell) => {
    const placement = idmlReimportPlacement(cell)
    if (placement !== "single" && placement !== "align") return cell
    try {
      const first = readIdmlMetadataV2(cell.metadata)?.editableSlotIndexes[0]
      const completion = placement === "single" || first === undefined
        ? placeIdmlPreviewInOnlySlot(cell, cell.translated)
        : stitchIdmlSlotTexts(cell, new Map([[first, cell.translated]]))
      if (!completion.valueHtml) return cell
      if (placement === "align") approximated++
      return { ...cell, translated: completion.value, translatedHtml: completion.valueHtml }
    } catch {
      // Left as it is: the export then refuses, and the panel says so.
      return cell
    }
  })
  return { cells: placed, approximated }
}
