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

import { walkAnchorChain } from "./cells-read-route"
import { targetLaneDualReadBinds, targetLaneDualReadSql } from "./lane-id-sql"
import { decodeHtmlEntities } from "../../../src/lib/html-entities"
import { semanticSourceText } from "../../../src/lib/semantic-source-text"
import {
  plainTextStructuredBody,
  type PlainTextStructuredCell,
} from "../../../src/lib/export/plaintext-structured"

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

export async function buildPlainTextExport(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  lane: string,
  options: { validatedOnly?: boolean } = {},
): Promise<string> {
  const sources = await db
    .prepare(
      `SELECT ${COLUMNS} FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''`,
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
  for (const cellId of order) {
    const source = sourceById.get(cellId)
    const target = targetById.get(cellId)
    // Hiding is per cell and read off the SOURCE row only (AQU-1422).
    if (source?.hidden_at != null) continue
    const translated = decodeHtmlEntities(target?.value ?? "")
    if (options.validatedOnly && !(translated.trim() && Number(target?.validated ?? 0) !== 0)) continue
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
  return plainTextStructuredBody(cells)
}
