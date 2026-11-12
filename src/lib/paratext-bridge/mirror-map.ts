// A Paratext project mirrored into a regular Aquilla project: the pure mapping
// between that project's cells and the book file's units.
//
// Cells were imported by `importParatextAsTarget`, so each carries the
// importer's reference in `canonicalRef` (`MAT 1:2`, `MAT 1:s1:3`); every unit
// carries the same reference in `ref`. That pairing is the whole join — no
// content matching, so it holds while the text changes on either side.

import type { Unit, UnitSet } from "./units"
import type { PendingEdit } from "./write-back"

/** The slice of a cell this module reads. Both rows of a cell are optional:
 *  a verse with no translation yet has a source row only. */
export interface MirrorCell {
  cellId: string
  ref: string
  /** Current target text. `undefined` when the lane has no row for the cell. */
  value?: string
  valueHtml?: string | null
}

const BLOCK_END_RE = /<\/(?:p|div|li|h[1-6]|blockquote|pre|tr)>|<br\s*\/?>/gi
const TAG_RE = /<[^>]+>/g
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" }

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/**
 * The editor's rich text as the plain, USFM-safe text a unit holds. Block
 * boundaries become line breaks (a poetry line stays its own line), inline
 * tags vanish, entities decode, and the result is NFC with no trailing
 * whitespace — the same shape `planWriteBack` compares against. Backslashes
 * are kept: a translator who types `\\nd Lord\\nd*` means the marker.
 */
export function htmlToUnitText(html: string): string {
  const withBreaks = html.replace(BLOCK_END_RE, "\n").replace(TAG_RE, "")
  return decodeEntities(withBreaks)
    .normalize("NFC")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
}

/** The plain text a cell wants in its unit. The editor stores plain `value`
 *  beside `valueHtml`; the HTML is the fallback for rows that have only it. */
export function cellUnitText(cell: MirrorCell): string {
  if (cell.value !== undefined && cell.value !== "") return cell.value.normalize("NFC").replace(/[ \t\r\n]+$/, "")
  if (cell.valueHtml) return htmlToUnitText(cell.valueHtml)
  return ""
}

export interface MirrorDiff {
  /** Edits whose cell text differs from the base unit's text. */
  edits: PendingEdit[]
  /** Cells whose reference matches no unit in the base (structure changed in
   *  Paratext, or a duplicate reference the importer and the bridge disagree on). */
  unmapped: MirrorCell[]
}

/** Units by importer reference. A reference that names two units (a chapter
 *  with two `\\v 4`) is ambiguous and maps to neither. */
export function unitsByRef(units: readonly Unit[]): Map<string, Unit> {
  const out = new Map<string, Unit>()
  const dupes = new Set<string>()
  for (const u of units) {
    if (out.has(u.ref)) dupes.add(u.ref)
    else out.set(u.ref, u)
  }
  for (const d of dupes) out.delete(d)
  return out
}

/**
 * Pending edits for a write: every cell whose text differs from the unit as
 * Aquilla last saw it, based on that unit's `rawHash` so a file that moved in
 * between is caught by `planWriteBack` (base-mismatch) rather than overwritten.
 * Cells with no target row are left alone — an empty cell is "not translated
 * yet", not "please empty this verse".
 */
export function diffCellsAgainstUnits(cells: readonly MirrorCell[], base: UnitSet): MirrorDiff {
  const byRef = unitsByRef(base.units)
  const edits: PendingEdit[] = []
  const unmapped: MirrorCell[] = []
  for (const cell of cells) {
    if (cell.value === undefined && !cell.valueHtml) continue
    const unit = byRef.get(cell.ref)
    if (!unit) { unmapped.push(cell); continue }
    const text = cellUnitText(cell)
    if (text === unit.text.replace(/[ \t\r\n]+$/, "")) continue
    edits.push({ unitId: unit.id, text, baseRawHash: unit.rawHash })
  }
  return { edits, unmapped }
}
