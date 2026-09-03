import {
  partitionIdmlUnitAtLineBreaks,
  renderIdmlUnitHtml,
  type IdmlParseResult,
  type IdmlProgress,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import {
  parseIdmlInWorker,
  type IdmlWorkerCallOptions,
} from "@/lib/idml/idml-worker-client"
import { MAX_CELL_TEXT_BYTES, utf8ByteLength } from "../../../shared/import-contract"
import type { TranslatableString } from "./types"

export type IdmlParseExecutor = (
  bytes: ArrayBuffer,
  profile: "generic" | "biblica",
  options?: IdmlWorkerCallOptions,
) => Promise<IdmlParseResult>

export interface IdmlImportParseOptions {
  signal?: AbortSignal
  onProgress?: (progress: IdmlProgress) => void
}

function scopeLabel(scope: IdmlTranslationUnit["locator"]["scope"]): string {
  switch (scope) {
    case "story-paragraph":
      return "Paragraph"
    case "table-cell":
      return "Table cell"
    case "footnote":
      return "Footnote"
    case "endnote":
      return "Endnote"
    case "note":
      return "Note"
    case "text-path":
      return "Text on path"
    case "anchored-story":
      return "Anchored story"
    case "master-story":
      return "Master story"
    case "custom-variable":
      return "Custom text variable"
  }
}

/**
 * IDML target rows start with the exact protected structure but no editable
 * source words. Non-editable literal slots remain present because they are
 * source structure, not translator-owned content.
 */
function emptyProtectedTarget(unit: IdmlTranslationUnit): {
  html: string
} {
  const slots = unit.slots.map((slot) => (
    slot.editable ? { ...slot, text: "" } : slot
  ))
  return {
    html: renderIdmlUnitHtml({ ...unit, slots }),
  }
}

/**
 * Map one engine unit to one Aquilla cell. Semantic IDML adapters (e.g. the
 * Biblica study-notes importer) reuse this so every IDML cell carries the same
 * protected anchors, locator, and v2 metadata regardless of which units the
 * adapter chose to import.
 */
export function idmlUnitToTranslatableString(unit: IdmlTranslationUnit): TranslatableString {
  const target = emptyProtectedTarget(unit)
  return {
    id: unit.id,
    original: unit.sourceText,
    originalHtml: unit.sourceHtml,
    translated: "",
    translatedHtml: target.html,
    context: scopeLabel(unit.locator.scope),
    group: `${unit.locator.memberPath}:${unit.locator.elementPath}`,
    type: "text",
    sourceLocator: unit.locator,
    metadata: {
      idml: unit.metadata,
    },
  }
}

/** Largest UTF-8 field this cell would upload — the bulk-import route caps
 *  source and target text alike, and an IDML cell carries both, so the widest
 *  one decides whether the server will take it. */
function widestCellFieldBytes(cell: TranslatableString): number {
  return Math.max(
    utf8ByteLength(cell.original),
    cell.originalHtml ? utf8ByteLength(cell.originalHtml) : 0,
    utf8ByteLength(cell.translated),
    cell.translatedHtml ? utf8ByteLength(cell.translatedHtml) : 0,
  )
}

/**
 * Map engine units to cells, partitioning any unit too large for the
 * bulk-import route at the line breaks the engine already knows (AQU-990).
 *
 * A single IDML story can hold a whole frontmatter section in one paragraph,
 * which used to fail the import with a bare HTTP 413 after the entire file had
 * uploaded. `partitionIdmlUnitAtLineBreaks` is the only sanctioned way to break
 * a unit up — it re-projects each line onto its own slot range, so `part` /
 * `slotIndexes` still address the original paragraph and export reassembles it
 * unchanged. A paragraph with no interior break comes back whole and reaches
 * the importer's size guard, which names it instead of failing anonymously.
 */
export function idmlUnitsToTranslatableStrings(
  units: readonly IdmlTranslationUnit[],
): TranslatableString[] {
  return units.flatMap((unit) => {
    const cell = idmlUnitToTranslatableString(unit)
    if (widestCellFieldBytes(cell) <= MAX_CELL_TEXT_BYTES) return [cell]
    let parts: readonly IdmlTranslationUnit[]
    try {
      parts = partitionIdmlUnitAtLineBreaks(unit)
    } catch {
      // The engine refuses to partition this paragraph (ANCHOR_INVALID). Keep
      // it whole rather than guessing at a boundary it does not recognize.
      return [cell]
    }
    return parts.length > 1 ? parts.map(idmlUnitToTranslatableString) : [cell]
  })
}

/**
 * Parse every IDML translation unit through the shared v2 engine. Production
 * uses a transferable Web Worker and has no main-thread fallback; tests may
 * inject the same runtime-neutral parser directly.
 *
 * One engine unit becomes one Aquilla cell. The generic text splitter is
 * deliberately absent: IDML units may only be partitioned between known slots
 * by the shared engine, which records `part` and exact `slotIndexes` (see
 * `partitionIdmlUnitAtLineBreaks`, which the Biblica adapter opts into, and
 * which `idmlUnitsToTranslatableStrings` applies to an oversized unit).
 */
export async function extractIdmlStrings(
  buffer: ArrayBuffer,
  parse: IdmlParseExecutor = parseIdmlInWorker,
  profile: "generic" | "biblica" = "generic",
  options?: IdmlImportParseOptions,
): Promise<TranslatableString[]> {
  const result = await parse(buffer, profile, options)
  return idmlUnitsToTranslatableStrings(result.units)
}
