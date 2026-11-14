// The live export preview (AQU-2559): the USFM file an export would produce
// now, computed in the browser from the cells already on screen.
//
// The server builds the same plan from Postgres
// (sync-worker/src/events/usfm-export-plan.ts) and both sides hand it to one
// serializer (db/shared/usfm-layout.ts). This module is the browser's half of
// the plan: translations by verse address, lines added in the app, and the
// verses that were removed or hidden.

import type { CellData } from "@/hooks/useCells"
import { parseUsfmLossless, type UsfmDocument } from "@/lib/parsers/usfm-lossless"
import {
  countLossyVersesWithLayout,
  renderUsfmWithLayout,
  type UsfmLayoutEdits,
  type UsfmOutputSpan,
} from "../../../db/shared/usfm-layout"
import { readUsfmNotes, reattachUsfmNotes } from "../../../db/shared/usfm-notes"

export interface ClientUsfmPlan {
  overrides: Map<string, string>
  edits: UsfmLayoutEdits
}

function isUserInsert(metadata: CellData["metadata"]): boolean {
  const origin = (metadata as { aquillaOrigin?: { kind?: unknown } } | null | undefined)?.aquillaOrigin
  return origin?.kind === "user-insert"
}

/**
 * @param cells the file's cells in store order (the anchor chain's order)
 * @param removedRefs verse addresses of cells removed from the file
 * @param unsaved words typed in the document that have not been saved yet
 */
export function buildClientUsfmPlan(
  cells: readonly CellData[],
  removedRefs: readonly string[] = [],
  unsaved?: ReadonlyMap<string, string>,
): ClientUsfmPlan {
  const overrides = new Map<string, string>()
  const appendAfter = new Map<string, string[]>()
  const remove = new Set<string>(removedRefs)
  /** The verse an added line follows. */
  let anchorRef: string | null = null

  for (const cell of cells) {
    const ref = cell.globalReferences?.[0] || null
    const value = unsaved?.get(cell.id) ?? cell.translated ?? ""
    if (ref) {
      anchorRef = ref
      if (cell.hidden) remove.add(ref)
      else if (value !== "") overrides.set(ref, reattachUsfmNotes(value, readUsfmNotes(cell.metadata)))
      continue
    }
    // The server walks the anchor chain past any cell with no address, so an
    // added line still finds the verse above it.
    if (!isUserInsert(cell.metadata) || cell.hidden || value.trim() === "" || !anchorRef) continue
    const list = appendAfter.get(anchorRef) ?? []
    list.push(value.trim())
    appendAfter.set(anchorRef, list)
  }

  const edits: UsfmLayoutEdits = {}
  if (appendAfter.size > 0) edits.appendAfter = appendAfter
  if (remove.size > 0) edits.remove = remove
  return { overrides, edits }
}

export interface UsfmPreview {
  text: string
  spans: UsfmOutputSpan[]
  translated: number
  total: number
  /** Translated verses whose source words carried markers the translation replaced. */
  lossy: number
}

export function parsePreviewSource(raw: string): UsfmDocument {
  return parseUsfmLossless(raw)
}

export function renderUsfmPreview(doc: UsfmDocument, plan: ClientUsfmPlan): UsfmPreview {
  const { text, spans } = renderUsfmWithLayout(doc, plan.overrides, plan.edits)
  return {
    text,
    spans,
    translated: spans.filter((s) => s.state === "translated").length,
    total: spans.length,
    lossy: countLossyVersesWithLayout(doc, plan.overrides),
  }
}
