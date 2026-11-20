import type { CellData } from "@/hooks/useCells"
import { isUserAddedLine, splitFromCellId } from "@/lib/timeline/user-line-origin"

export interface PackageBlockTranslation {
  plain: string
  html: string
  label: string
  /** The block's segments in order, each with its own plain text and (when
   *  the translator's editor wrote one) its own HTML. The joined `html` above
   *  only holds the segments that HAVE html, so a reader that wants every
   *  segment's words must read these (AQU-2539, the DOCX exporter). */
  parts: BlockPart[]
  /** Every segment's source text, translated or not, in order. */
  source: string
}

/** One line of a block, as the export writes it. */
export interface BlockPart {
  plain: string
  html: string
  source: string
  /** AQU-2539: the line has no translation, so it is written as its source
   *  (`plain` is that source): a partly translated block keeps every line. */
  untranslated?: true
}

/**
 * AQU-2539, AQU-2552: a block (a paragraph cut into lines) is written as its
 * lines in order, each line's translation, or its source where it has none. A
 * hidden or deleted line contributes nothing (`lostLines`: the block lost a
 * line the cells no longer show). A block with no translated line and no lost
 * line has no parts: the client's paragraph stays as it is.
 */
export function blockParts(cells: readonly CellData[], lostLines = false): BlockPart[] {
  const live = cells.filter((cell) => cell.hidden !== true)
  const translated = (cell: CellData) => visibleTranslation(cell) !== ""
  if (!live.some(translated) && !lostLines && live.length === cells.length) return []
  return live.map((cell): BlockPart => translated(cell)
    ? { plain: visibleTranslation(cell), html: cell.translatedHtml?.trim() ?? "", source: cell.original ?? "" }
    : { plain: (cell.original ?? "").trim(), html: "", source: cell.original ?? "", untranslated: true })
}

/**
 * AQU-2552 (review r6): the parts of a paragraph of a file imported before
 * locators. Such a file can place no removal, so a hidden line keeps its
 * original text, as the export dialog's note says: it is written as its
 * source, like an untranslated line, and a paragraph with no translated line
 * is left as it is.
 */
export function positionalBlockParts(cells: readonly CellData[]): BlockPart[] {
  return blockParts(cells.map((cell) => (cell.hidden === true
    ? { ...cell, hidden: undefined, translated: "", translatedHtml: undefined }
    : cell)))
}

/**
 * AQU-2552 (review r6): a line's translation as a reader sees it. A line counts
 * as translated only when this is not blank: a translation typed and then
 * erased leaves its empty markup behind (`<p></p>`), and that is no
 * translation, so the line keeps its source.
 */
function visibleTranslation(cell: CellData): string {
  const plain = (cell.translated ?? "").trim()
  if (plain !== "") return plain
  const html = cell.translatedHtml ?? ""
  if (html.trim() === "") return ""
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim()
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

/** A row a split chain can pass through: a live cell, or a deleted one as the
 *  server reports it (AQU-2552 review r7). */
type LineRecord = Pick<CellData, "id" | "metadata" | "group">

/**
 * AQU-2552 (review r6): a line split in the editor is still a line of the
 * paragraph it came from. The piece has no locator of its own; it carries
 * `splitFrom`, the row it was cut from (itself a piece when a piece was cut
 * again). This follows that chain back to the imported line it starts at. A
 * line a person added on its own has no `splitFrom` and gets null: it stays an
 * added line.
 *
 * AQU-2552 (review r7): a row of the chain may have been deleted, the line
 * itself included; the piece is still a line of that line's paragraph. The
 * chain goes on through the server's records of deleted rows (`removed`),
 * which carry the row's `cellId` and its create-time metadata.
 */
function splitPieceRoot(
  cells: readonly CellData[],
  removed: readonly RemovedCellLocatorSource[] = [],
): (cell: Pick<CellData, "metadata">) => LineRecord | null {
  const byId = new Map<string, LineRecord>()
  for (const entry of removed) {
    if (typeof entry.cellId === "string" && entry.cellId !== "") {
      byId.set(entry.cellId, { id: entry.cellId, metadata: entry.metadata, group: entry.canonicalRef ?? "" })
    }
  }
  for (const cell of cells) byId.set(cell.id, cell)
  return (cell) => {
    const seen = new Set<string>()
    let from = splitFromCellId(cell)
    while (from !== null && !seen.has(from)) {
      seen.add(from)
      const parent = byId.get(from)
      if (!parent) return null
      if (!isUserAddedLine(parent)) return parent
      from = splitFromCellId(parent)
    }
    return null
  }
}

/** The locator of the imported line a split piece came from (see above). */
function splitPieceHome(
  cells: readonly CellData[],
  removed: readonly RemovedCellLocatorSource[] = [],
): (cell: Pick<CellData, "metadata">) => PackageBlockLocator | null {
  const rootOf = splitPieceRoot(cells, removed)
  return (cell) => {
    const root = rootOf(cell)
    return root ? packageBlockLocator(root) : null
  }
}

/**
 * The lines of each paragraph of a file imported before locators, keyed by the
 * group the importer gave them, in first-seen order: the k-th group fills the
 * k-th paragraph with text. A line added here has no paragraph and takes no
 * slot (AQU-1068). AQU-2552 (review r6): a piece split off a line joins that
 * line's paragraph, right after it, so its words are not lost.
 *
 * AQU-2552 (review r7): a piece whose line was deleted joins the deleted
 * line's paragraph, at its own place in the list. `removed` (the server's
 * records of deleted rows) names that line and its group.
 */
export function positionalLines(
  cells: readonly CellData[],
  removed: readonly RemovedCellLocatorSource[] = [],
): Map<string, CellData[]> {
  const rootOf = splitPieceRoot(cells, removed)
  const live = new Set<LineRecord>(cells)
  const pieces = new Map<LineRecord, CellData[]>()
  for (const cell of cells) {
    if (!isUserAddedLine(cell)) continue
    const root = rootOf(cell)
    if (root) pieces.set(root, [...(pieces.get(root) ?? []), cell])
  }
  const lines = new Map<string, CellData[]>()
  for (const cell of cells) {
    if (isUserAddedLine(cell)) {
      const root = rootOf(cell)
      if (root && !live.has(root)) {
        const group = root.group || root.id
        lines.set(group, [...(lines.get(group) ?? []), cell])
      }
      continue
    }
    const group = cell.group || cell.id
    const list = lines.get(group) ?? []
    list.push(cell, ...(pieces.get(cell) ?? []))
    lines.set(group, list)
  }
  return lines
}

function packageBlockLocator(cell: Pick<CellData, "metadata">): PackageBlockLocator | null {
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
 * deleting cells must never inject a translation into a different paragraph.
 * `removed` (the server's removed cells) tells which blocks lost a line. */
export function translationsByPackageBlock(
  cells: CellData[],
  removed: readonly RemovedCellLocatorSource[] = [],
): Map<string, PackageBlockTranslation> {
  const lost = blocksOf(removed, cells)
  const homeOf = splitPieceHome(cells, removed)
  const grouped = new Map<string, Array<{ cell: CellData; locator: PackageBlockLocator; rank: number }>>()
  cells.forEach((cell, index) => {
    // AQU-2552 (review r6): a split piece is a line of its line's paragraph,
    // after that line (rank 0) and after earlier pieces, in row order.
    const own = packageBlockLocator(cell)
    const locator = own ?? homeOf(cell)
    if (!locator) return
    const key = packageBlockKey(locator.memberPath, locator.blockPath)
    const list = grouped.get(key) ?? []
    list.push({ cell, locator, rank: own ? 0 : index + 1 })
    grouped.set(key, list)
  })

  const translations = new Map<string, PackageBlockTranslation>()
  for (const [key, entries] of grouped) {
    entries.sort((a, b) =>
      a.locator.segment - b.locator.segment
      || a.locator.physicalOrder - b.locator.physicalOrder
      || a.rank - b.rank,
    )
    const parts = blockParts(entries.map(({ cell }) => cell), lost.has(key))
    const plain = parts.map((part) => part.plain).filter(Boolean).join(" ")
    const html = parts.map((part) => part.html).filter(Boolean).join(" ")
    translations.set(key, {
      plain,
      html,
      label: `${entries[0].locator.memberPath}:${entries[0].locator.blockPath}`,
      parts,
      source: entries.map(({ cell }) => cell.original ?? "").join(" "),
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
  /** AQU-2552 (review r7): the row's id, so a piece split off it still finds
   *  its line (see `splitPieceRoot`). The server always sends it; a hidden
   *  line, still among the cells, needs none. */
  cellId?: string
  /** The row's group (its canonical ref), for a file imported before locators. */
  canonicalRef?: string | null
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
 *
 * AQU-2552: a paragraph leaves only when every line of it is gone. While one
 * of its lines is still in `cells` and not hidden, the paragraph stays, written
 * as its remaining lines (see `blockParts`).
 */
export function removedPackageBlockKeys(
  removed: readonly RemovedCellLocatorSource[],
  cells: readonly CellData[] = [],
): Set<string> {
  const keys = blocksOf(removed, cells)
  const homeOf = splitPieceHome(cells, removed)
  for (const cell of cells) {
    if (cell.hidden === true) continue
    const locator = packageBlockLocator(cell) ?? homeOf(cell)
    if (locator) keys.delete(packageBlockKey(locator.memberPath, locator.blockPath))
  }
  return keys
}

/** The package blocks these removed cells came from (a removed split piece's
 *  is its line's, AQU-2552 review r6, even when that line is gone too, r7). */
function blocksOf(removed: readonly RemovedCellLocatorSource[], cells: readonly CellData[] = []): Set<string> {
  const homeOf = splitPieceHome(cells, removed)
  const keys = new Set<string>()
  for (const entry of removed) {
    const locator = packageBlockLocator(entry) ?? homeOf(entry)
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
 *
 * AQU-2552 (review r7): `removed` (the server's records of deleted rows) lets
 * a piece whose line was deleted find that line's paragraph, so it is written
 * there and not as a paragraph of its own.
 */
export function insertionsAfterPackageBlock(
  cells: readonly CellData[],
  isAdded: (cell: CellData) => boolean,
  removed: readonly RemovedCellLocatorSource[] = [],
): Map<string, string[]> {
  const insertions = new Map<string, string[]>()
  const homeOf = splitPieceHome(cells, removed)
  let anchorKey: string | null = null
  for (const cell of cells) {
    // AQU-2552 (review r6): a piece split off an imported line is a line of
    // that line's paragraph (translationsByPackageBlock), not a new paragraph.
    const home = homeOf(cell)
    if (home) {
      anchorKey = packageBlockKey(home.memberPath, home.blockPath)
      continue
    }
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
