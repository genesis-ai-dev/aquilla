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
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as { bold?: unknown }).bold === "boolean"
    && typeof (value as { italic?: unknown }).italic === "boolean",
  )
}

/** Persist only the Bold/Italic styles a cell actually uses. */
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
    if (typeof styleId === "string" && isEmphasis(emphasis) && (emphasis.bold || emphasis.italic)) {
      catalog[styleId] = { bold: emphasis.bold, italic: emphasis.italic }
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
