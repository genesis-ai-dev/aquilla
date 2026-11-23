import {
  extractIdmlStyleCatalog,
  styleCatalogForSlots,
  type IdmlStyleCatalog,
  type IdmlStyleEmphasis,
} from "@aquilla/idml-roundtrip"

export {
  extractIdmlStyleCatalog,
  styleCatalogForSlots,
  type IdmlStyleCatalog,
  type IdmlStyleEmphasis,
}

const DISPLAY_KEY = "idmlStyleDisplay"

function isEmphasis(value: unknown): value is IdmlStyleEmphasis {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as { bold?: unknown; italic?: unknown; smallCaps?: unknown }
  return typeof record.bold === "boolean"
    && typeof record.italic === "boolean"
    && (record.smallCaps === undefined || typeof record.smallCaps === "boolean")
}

function emphasisMatters(emphasis: IdmlStyleEmphasis): boolean {
  return emphasis.bold || emphasis.italic || emphasis.smallCaps === true
}

function storedEmphasis(emphasis: IdmlStyleEmphasis): IdmlStyleEmphasis {
  return emphasis.smallCaps
    ? { bold: emphasis.bold, italic: emphasis.italic, smallCaps: true }
    : { bold: emphasis.bold, italic: emphasis.italic }
}

/** Persist only the bold, italic, and small-caps styles a cell actually uses. */
export function idmlStyleDisplayMetadata(
  catalog: IdmlStyleCatalog | undefined,
  styleIds: readonly string[],
): { idmlStyleDisplay: IdmlStyleCatalog } | undefined {
  if (!catalog) return undefined
  const used = styleCatalogForSlots(catalog, styleIds)
  return used ? { idmlStyleDisplay: used } : undefined
}

export function idmlStyleCatalogFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): IdmlStyleCatalog | undefined {
  const raw = metadata?.[DISPLAY_KEY]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const catalog: Record<string, IdmlStyleEmphasis> = {}
  for (const [styleId, emphasis] of Object.entries(raw)) {
    if (typeof styleId === "string" && isEmphasis(emphasis) && emphasisMatters(emphasis)) {
      catalog[styleId] = storedEmphasis(emphasis)
    }
  }
  return Object.keys(catalog).length > 0 ? catalog : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Paragraph style the display layer inherits onto `[No character style]` slots.
 * New imports persist `idmlParagraphStyle`; Biblica adapters also keep the
 * same id on `biblica.paragraphStyle` for already-imported cells.
 */
export function idmlParagraphStyleFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!metadata) return undefined
  const explicit = asNonEmptyString(metadata.idmlParagraphStyle)
  if (explicit) return explicit
  const biblica = metadata.biblica
  if (biblica && typeof biblica === "object" && !Array.isArray(biblica)) {
    return asNonEmptyString((biblica as { paragraphStyle?: unknown }).paragraphStyle)
  }
  return undefined
}
