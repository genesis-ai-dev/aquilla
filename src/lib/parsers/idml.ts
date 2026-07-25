import {
  renderIdmlUnitHtml,
  type IdmlParseResult,
  type IdmlTranslationUnit,
} from "@aquilla/idml-roundtrip"
import { parseIdmlInWorker } from "@/lib/idml/idml-worker-client"
import type { TranslatableString } from "./types"

export type IdmlParseExecutor = (
  bytes: ArrayBuffer,
  profile: "generic" | "biblica",
) => Promise<IdmlParseResult>

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

function toTranslatableString(unit: IdmlTranslationUnit): TranslatableString {
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
    paragraphStart: true,
    sourceLocator: unit.locator,
    metadata: {
      idml: unit.metadata,
    },
  }
}

/**
 * Parse every IDML translation unit through the shared v2 engine. Production
 * uses a transferable Web Worker and has no main-thread fallback; tests may
 * inject the same runtime-neutral parser directly.
 *
 * One engine unit becomes one Aquilla cell. The generic text splitter is
 * deliberately absent: IDML units may only be partitioned between known slots
 * by the shared engine, which records `part` and exact `slotIndexes`.
 */
export async function extractIdmlStrings(
  buffer: ArrayBuffer,
  parse: IdmlParseExecutor = parseIdmlInWorker,
  profile: "generic" | "biblica" = "generic",
): Promise<TranslatableString[]> {
  const result = await parse(buffer, profile)
  return result.units.map(toTranslatableString)
}
