// Pure extraction of D1 projection rows from the live Y.Doc. Doc schema is
// documented in codex-web-app/src/lib/store/file-doc.ts — three root
// collections (meta, cells, order); each cell is a Y.Map with id, original,
// translatedXml (Y.XmlFragment), history (Y.Array<CellHistoryEntry>), etc.
//
// Keep this file dependency-free from CF bindings so it's unit-testable.

import * as Y from "yjs"

export interface CellProjection {
  fileId: string
  cellId: string
  contentText: string
  contentHash: string
  validated: 0 | 1
  wordCount: number
  lastEditor: string | null
  lastEditAt: number // ms since epoch
}

export interface FileProjection {
  fileId: string
  projectId: string
  name: string
  fileType: string
  sourceLanguage: string | null
  targetLanguage: string | null
  cellCount: number
  approvedCount: number
  wordCount: number
  lastEditAt: number | null
}

export interface ProjectionResult {
  file: FileProjection
  cells: CellProjection[]
}

export function projectDoc(
  projectId: string,
  fileId: string,
  doc: Y.Doc
): ProjectionResult {
  const meta = doc.getMap("meta")
  const cellsMap = doc.getMap("cells")

  const cells: CellProjection[] = []
  let approvedCount = 0
  let totalWords = 0
  let maxEditAt = 0

  for (const cellId of cellsMap.keys()) {
    const cellNode = cellsMap.get(cellId)
    if (!(cellNode instanceof Y.Map)) continue
    const proj = projectCell(fileId, cellId, cellNode as Y.Map<unknown>)
    cells.push(proj)
    if (proj.validated) approvedCount += 1
    totalWords += proj.wordCount
    if (proj.lastEditAt > maxEditAt) maxEditAt = proj.lastEditAt
  }

  return {
    file: {
      fileId,
      projectId,
      name: (meta.get("fileName") as string | undefined) ?? "",
      fileType: (meta.get("fileType") as string | undefined) ?? "codex",
      sourceLanguage: (meta.get("sourceLanguage") as string | undefined) ?? null,
      targetLanguage: (meta.get("targetLanguage") as string | undefined) ?? null,
      cellCount: cells.length,
      approvedCount,
      wordCount: totalWords,
      lastEditAt: maxEditAt > 0 ? maxEditAt : null,
    },
    cells,
  }
}

function projectCell(
  fileId: string,
  cellId: string,
  cell: Y.Map<unknown>
): CellProjection {
  const frag = cell.get("translatedXml")
  const contentText =
    frag instanceof Y.XmlFragment ? extractPlainText(frag) : ""
  const contentHash = hashDjb2(contentText)
  const wordCount = countWords(contentText)

  const history = cell.get("history")
  let lastEditor: string | null = null
  let lastEditAt = 0
  let validated = false

  if (history instanceof Y.Array) {
    const entries = history.toArray() as Array<{
      timestamp?: string
      author?: string
      validated?: boolean
    }>
    for (const entry of entries) {
      if (!entry) continue
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN
      if (Number.isFinite(ts) && ts > lastEditAt) {
        lastEditAt = ts
        lastEditor = entry.author ?? null
      }
      if (entry.validated === true) validated = true
    }
  }

  return {
    fileId,
    cellId,
    contentText,
    contentHash,
    validated: validated ? 1 : 0,
    wordCount,
    lastEditor,
    lastEditAt,
  }
}

// Plain-text extraction from a Y.XmlFragment. Mirrors the structural walk in
// codex-web-app/src/lib/richtext/translated-xml.ts but yields text only — no
// tags, no marks, no HTML escaping. Used purely as a search + word-count
// feeder for the D1 projection; NOT for anything reversible.
function extractPlainText(frag: Y.XmlFragment): string {
  const parts: string[] = []
  for (let i = 0; i < frag.length; i++) {
    const node = frag.get(i)
    if (node instanceof Y.XmlText) {
      parts.push(node.toString())
    } else if (node instanceof Y.XmlElement) {
      parts.push(extractTextFromElement(node))
      parts.push(" ") // paragraph separator
    }
  }
  return parts.join("").replace(/\s+/g, " ").trim()
}

function extractTextFromElement(el: Y.XmlElement): string {
  const parts: string[] = []
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i)
    if (child instanceof Y.XmlText) {
      parts.push(child.toString())
    } else if (child instanceof Y.XmlElement) {
      parts.push(extractTextFromElement(child))
    }
  }
  return parts.join("")
}

function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

// djb2, 32-bit. Cheap change-detection marker — not a cryptographic hash.
// Collisions are OK; we only use it to avoid unnecessary FTS re-indexing on
// cells whose plain-text projection hasn't changed.
function hashDjb2(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * Apply a ProjectionResult to codex-db. File row is always upserted (cheap).
 * Cell rows use the last_edit_at guard clause so stale / out-of-order
 * projections don't overwrite newer data. Idempotent.
 *
 * projectedFrom records the R2 snapshot key (or tail key) the projection was
 * built from — useful for reconcile / debugging.
 */
export async function writeProjection(
  db: D1Database,
  result: ProjectionResult,
  projectedFrom: string
): Promise<void> {
  const stmts: D1PreparedStatement[] = []

  // Upsert the file row. No guard clause — file-level counters should reflect
  // the most recently processed projection even if last_edit_at didn't advance
  // (e.g. a validated flag flipped without a new history entry).
  const fileStmt = db.prepare(
    `INSERT INTO files (
      id, project_id, name, file_type, source_language, target_language,
      cell_count, approved_count, word_count, last_edit_at, projected_from,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch('now') * 1000)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      file_type = excluded.file_type,
      source_language = excluded.source_language,
      target_language = excluded.target_language,
      cell_count = excluded.cell_count,
      approved_count = excluded.approved_count,
      word_count = excluded.word_count,
      last_edit_at = excluded.last_edit_at,
      projected_from = excluded.projected_from,
      updated_at = unixepoch('now') * 1000`
  )
  stmts.push(
    fileStmt.bind(
      result.file.fileId,
      result.file.projectId,
      result.file.name,
      result.file.fileType,
      result.file.sourceLanguage,
      result.file.targetLanguage,
      result.file.cellCount,
      result.file.approvedCount,
      result.file.wordCount,
      result.file.lastEditAt,
      projectedFrom
    )
  )

  // Per-cell upsert, guarded by last_edit_at so out-of-order projections don't
  // win over newer data. Matches the schema we shipped in codex_migrations.
  const cellStmt = db.prepare(
    `INSERT INTO cells (
      file_id, cell_id, content_text, content_hash, validated, word_count,
      last_editor, last_edit_at, projected_from
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_id, cell_id) DO UPDATE SET
      content_text = excluded.content_text,
      content_hash = excluded.content_hash,
      validated = excluded.validated,
      word_count = excluded.word_count,
      last_editor = excluded.last_editor,
      last_edit_at = excluded.last_edit_at,
      projected_from = excluded.projected_from
    WHERE excluded.last_edit_at > cells.last_edit_at`
  )
  for (const c of result.cells) {
    stmts.push(
      cellStmt.bind(
        c.fileId,
        c.cellId,
        c.contentText,
        c.contentHash,
        c.validated,
        c.wordCount,
        c.lastEditor,
        c.lastEditAt,
        projectedFrom
      )
    )
  }

  if (stmts.length > 0) await db.batch(stmts)
}
