// AQU-1472: the translated `.txt` export, built on the server.
//
// Until this existed the export route handed back the stored upload for a
// plain-text file (`X-Export-Mode: raw-original`), so an Agent API export of a
// `.txt` file came back with no translations in it. The in-app exporter
// already wrote them (`exportPlainTextStructured`); this rebuilds that output
// from the projection so the two agree byte for byte:
//
//   - cells in the editor's order: source rows in anchor-chain order, then
//     target-only rows in theirs (useCells `joinSourceAndTarget`);
//   - text decoded the way the cell store decodes it (`decodeHtmlEntities`),
//     source read through `semanticSourceText`;
//   - paragraph key = target canonical_ref ?? source canonical_ref, which is
//     where the importer stored each segment's `group`;
//   - hidden cells leave the file, and `validatedOnly` omits every cell that
//     is not validated, both as `scopeCellsForExport` does in the app;
//   - the paragraph rules themselves come from the shared
//     `plainTextStructuredBody`, so there is no second copy to drift.
//
// AQU-2383: the rebuilt body is LF-terminated and BOM-less, because that is
// what the plain-text parser normalized the upload to. A Windows upload must
// not come back as a Unix file, so the caller passes the source's envelope
// (`detectTextFidelity`) and it is restored here.
//
// The caller also needs to know whether this rebuild says anything the upload
// does not. Two things can make it differ, and BOTH have to be absent before
// the route may serve the stored bytes instead:
//
//   - a translation went in (`translatedCells`), or
//   - a cell was left out (`droppedCells`) — hidden in the editor, or filtered
//     by `validatedOnly`. A hidden cell means a paragraph of the upload is
//     deliberately missing from the export, which is a real edit even though
//     no words were translated.

import { walkAnchorChain } from "./cells-read-route"
import { targetLaneDualReadBinds, targetLaneDualReadSql } from "./lane-id-sql"
import { decodeHtmlEntities } from "../../../src/lib/html-entities"
import { semanticSourceText } from "../../../src/lib/semantic-source-text"
import {
  plainTextStructuredBody,
  type PlainTextStructuredCell,
} from "../../../src/lib/export/plaintext-structured"
import {
  applyTextFidelity,
  NORMALIZED_TEXT_FIDELITY,
  type TextFidelity,
} from "../../../src/lib/export/text-fidelity"

interface CellRow {
  cell_id: string
  anchor_cell_id: string | null
  event_id: string
  value: string | null
  canonical_ref: string | null
  medium: string | null
  transcription: string | null
  validated: number | null
  hidden_at: number | string | null
}

const COLUMNS =
  "cell_id, anchor_cell_id, event_id, value, canonical_ref, medium, transcription, validated, hidden_at"

export interface PlainTextExportOptions {
  validatedOnly?: boolean
  /** The source upload's envelope, from `detectTextFidelity` on its decoded
   *  text. Omitted when the file has no stored blob to read it from, in which
   *  case the body keeps the parser's normalized form. */
  fidelity?: TextFidelity
}

export interface PlainTextExportResult {
  /** The rebuilt body, in the source's line terminator and byte-order mark. */
  body: string
  /** Exported cells carrying a committed translation for this lane. */
  translatedCells: number
  /** Cells the export left out: hidden, or filtered by `validatedOnly`. */
  droppedCells: number
  /** AQU-2383: this rebuild says nothing the upload does not, so the upload
   *  itself is the faithful export. True only when no translation went in AND
   *  no cell was left out. */
  untouched: boolean
}

export async function buildPlainTextExport(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  lane: string,
  options: PlainTextExportOptions = {},
): Promise<PlainTextExportResult> {
  const sources = await db
    .prepare(
      `SELECT ${COLUMNS} FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source'`,
    )
    .bind(projectId, fileId)
    .all<CellRow>()
  const targets = await db
    .prepare(
      `SELECT ${COLUMNS} FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'target'
          AND ${targetLaneDualReadSql()}`,
    )
    .bind(projectId, fileId, ...targetLaneDualReadBinds(projectId, lane))
    .all<CellRow>()

  const sourceById = new Map<string, CellRow>()
  const order: string[] = []
  for (const row of walkAnchorChain(sources.results ?? [])) {
    if (sourceById.has(row.cell_id)) continue
    sourceById.set(row.cell_id, row)
    order.push(row.cell_id)
  }
  const targetById = new Map<string, CellRow>()
  for (const row of walkAnchorChain(targets.results ?? [])) {
    if (targetById.has(row.cell_id)) continue
    targetById.set(row.cell_id, row)
    if (!sourceById.has(row.cell_id)) order.push(row.cell_id)
  }

  const cells: PlainTextStructuredCell[] = []
  let translatedCells = 0
  let droppedCells = 0
  for (const cellId of order) {
    const source = sourceById.get(cellId)
    const target = targetById.get(cellId)
    // Hiding is per cell and read off the SOURCE row only (AQU-1422).
    if (source?.hidden_at != null) {
      droppedCells++
      continue
    }
    const translated = decodeHtmlEntities(target?.value ?? "")
    if (options.validatedOnly && !(translated.trim() && Number(target?.validated ?? 0) !== 0)) {
      droppedCells++
      continue
    }
    if (translated.trim() !== "") translatedCells++
    cells.push({
      translated,
      source: semanticSourceText({
        medium: target?.medium ?? source?.medium ?? "text",
        transcription: target?.transcription ?? source?.transcription ?? undefined,
        original: decodeHtmlEntities(source?.value ?? ""),
      }),
      group: target?.canonical_ref ?? source?.canonical_ref ?? "",
    })
  }
  const body = plainTextStructuredBody(cells)
  return {
    body: applyTextFidelity(body, options.fidelity ?? NORMALIZED_TEXT_FIDELITY),
    translatedCells,
    droppedCells,
    untouched: translatedCells === 0 && droppedCells === 0,
  }
}
