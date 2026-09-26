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

// ── AQU-1068: what the editor did to the file's structure ────────────────────
//
// Both OOXML exporters walk THE PACKAGE and look up a cell for each paragraph
// they find. That works for translating in place, and it is why neither can
// express "and then a new paragraph after this one", or notice that a paragraph
// has no cell any more. These two helpers turn the cell list and the server's
// record of removals into the two lookups the package walk needs.
//
// Sam settled the rules on 2026-09-09: an added cell is ALWAYS content the
// client's file is missing, so it must reach the export; it becomes a new
// paragraph after the one it follows, in that paragraph's style; and a removed
// cell's paragraph leaves the file.

/** The metadata shape the server hands back for a cell that is gone. */
export interface RemovedCellLocatorSource {
  metadata: Record<string, unknown> | null
}

/**
 * Package-block keys whose paragraph should be DROPPED from the output.
 *
 * A removed cell's row is gone from the projection, so at export time it looks
 * exactly like a paragraph nobody has translated — and the exporters leave
 * those alone, which quietly undoes the removal. The caller gets this set from
 * the server (`fetchRemovedCells`), never by inference: a package block that no
 * live cell claims is ALSO how a paragraph that was never imported as a cell
 * looks — a running head, an empty paragraph, a non-text frame — and dropping
 * those would damage the client's document.
 */
export function removedPackageBlockKeys(
  removed: readonly RemovedCellLocatorSource[],
): Set<string> {
  const keys = new Set<string>()
  for (const entry of removed) {
    const locator = packageBlockLocator({ metadata: entry.metadata } as CellData)
    if (locator) keys.add(packageBlockKey(locator.memberPath, locator.blockPath))
  }
  return keys
}

/**
 * Translations to insert as NEW paragraphs, keyed by the package block each one
 * should follow.
 *
 * The anchor needs no stored field: the cell list arrives in chain order, so an
 * added cell follows the nearest preceding cell that carries a locator. Several
 * added cells in a row therefore share one anchor and keep their order.
 *
 * Two cells are deliberately skipped. One with NO translation, because the
 * native export writes translations into the client's file and there is nothing
 * to write — the same treatment an untranslated imported paragraph gets. And
 * one with no preceding located cell at all, because there is nowhere to put
 * it; placing it at the top of the document would be a guess.
 */
export function insertionsAfterPackageBlock(
  cells: readonly CellData[],
  isAdded: (cell: CellData) => boolean,
): Map<string, string[]> {
  const insertions = new Map<string, string[]>()
  let anchorKey: string | null = null
  for (const cell of cells) {
    if (isAdded(cell)) {
      if (!anchorKey) continue
      const text = cell.translated?.trim()
      if (!text) continue
      const list = insertions.get(anchorKey) ?? []
      list.push(text)
      insertions.set(anchorKey, list)
      continue
    }
    const locator = packageBlockLocator(cell)
    // An imported cell with no locator (a legacy import) does not become an
    // anchor. On such a file the exporters fall back to POSITIONAL mapping,
    // where an inserted paragraph would shift every mapping after it — so
    // those files carry no insertions at all, and the export dialog says so.
    if (locator) anchorKey = packageBlockKey(locator.memberPath, locator.blockPath)
  }
  return insertions
}

/** Does this file carry the locators that make placement possible? Files
 *  imported before locators existed map cells to paragraphs BY POSITION, where
 *  neither an insertion nor a removal can be expressed. The export dialog reads
 *  this so its note describes what will really happen to THIS file. */
export function hasPackageLocators(cells: readonly CellData[]): boolean {
  return cells.some((cell) => packageBlockLocator(cell) !== null)
}
