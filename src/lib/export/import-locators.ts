import type { CellData } from "@/hooks/useCells"

export interface PackageBlockTranslation {
  plain: string
  html: string
  label: string
}

interface PackageBlockLocator {
  memberPath: string
  blockPath: string
  segment: number
  physicalOrder: number
}

export function packageBlockKey(memberPath: string, blockPath: string): string {
  return `${memberPath}\u0000${blockPath}`
}

function packageBlockLocator(cell: CellData): PackageBlockLocator | null {
  const envelope = cell.metadata?.aquillaImport
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return null
  const normalized = envelope as Record<string, unknown>
  const locator = normalized.sourceLocator
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) return null
  const value = locator as Record<string, unknown>
  if (
    value.kind !== "package-block"
    || typeof value.memberPath !== "string"
    || typeof value.blockPath !== "string"
  ) return null
  return {
    memberPath: value.memberPath,
    blockPath: value.blockPath,
    segment: typeof value.segment === "number" && Number.isInteger(value.segment) ? value.segment : 0,
    physicalOrder:
      typeof normalized.physicalOrder === "number" && Number.isFinite(normalized.physicalOrder)
        ? normalized.physicalOrder
        : Number.MAX_SAFE_INTEGER,
  }
}

/** Build translations keyed by the reversible OOXML package locator emitted
 * at import. This deliberately ignores visual/editor order: reordering or
 * deleting cells must never inject a translation into a different paragraph. */
export function translationsByPackageBlock(
  cells: CellData[],
): Map<string, PackageBlockTranslation> {
  const grouped = new Map<string, Array<{ cell: CellData; locator: PackageBlockLocator }>>()
  for (const cell of cells) {
    const locator = packageBlockLocator(cell)
    if (!locator) continue
    const key = packageBlockKey(locator.memberPath, locator.blockPath)
    const list = grouped.get(key) ?? []
    list.push({ cell, locator })
    grouped.set(key, list)
  }

  const translations = new Map<string, PackageBlockTranslation>()
  for (const [key, entries] of grouped) {
    entries.sort((a, b) =>
      a.locator.segment - b.locator.segment
      || a.locator.physicalOrder - b.locator.physicalOrder,
    )
    const plain = entries.map(({ cell }) => cell.translated.trim()).filter(Boolean).join(" ")
    const html = entries.map(({ cell }) => cell.translatedHtml?.trim()).filter(Boolean).join(" ")
    translations.set(key, {
      plain,
      html,
      label: `${entries[0].locator.memberPath}:${entries[0].locator.blockPath}`,
    })
  }
  return translations
}
