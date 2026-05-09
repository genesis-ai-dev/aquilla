/**
 * One-shot Y.Doc → local-store importer. Run on first project open in
 * this branch so the local SQLite shadow gets populated from the legacy
 * Y.Doc state. Idempotent: skips when the local store already holds cells
 * for the scope (the local store is canonical from then on).
 *
 * Maps the legacy Y.Doc cell shape to the new CellRow:
 *
 *   Y.Doc cell.original          → cells.source_text
 *   Y.Doc cell.translatedXml     → cells.translation_text (plain text)
 *   Y.Doc cell.cellLabel         → cells.label (and cells.address if set)
 *   Y.Doc cell.context/group/    → cells.format_meta JSON
 *     section/globalReferences
 *   Y.Doc cell.type              → cells.kind
 *   Y.Doc order index            → cells.ord
 *
 * Threads, attachments, validations, etc. are *not* imported here — they
 * land via subsystem-specific bootstraps in Phase F. See the editor
 * refactor checklist.
 */

import * as Y from "yjs"
import type { LocalStore } from "./db"
import type { CellRow } from "./cells"
import { getCellsByScope, upsertCell } from "./cells"

export interface YDocImportContext {
  store: LocalStore
  yDoc: Y.Doc
  projectId: string
  /** The legacy fileId becomes the new scope_id. */
  fileId: string
  sourceLang: string
  targetLang: string
  orgId: string
  now: () => number
}

export interface YDocImportResult {
  imported: number
  skipped: boolean
}

export async function importYDocIfEmpty(
  ctx: YDocImportContext,
): Promise<YDocImportResult> {
  const existing = await getCellsByScope(
    ctx.store,
    ctx.projectId,
    ctx.fileId,
  )
  if (existing.length > 0) {
    return { imported: 0, skipped: true }
  }

  const cellsMap = ctx.yDoc.getMap("cells")
  if (cellsMap.size === 0) {
    return { imported: 0, skipped: false }
  }

  const order = ctx.yDoc.getArray("order") as Y.Array<string>
  const orderedIds: string[] =
    order.length > 0
      ? (order.toArray() as string[])
      : Array.from(cellsMap.keys())

  let imported = 0
  await ctx.store.transaction(async () => {
    let ord = 0
    for (const cellId of orderedIds) {
      const yCell = cellsMap.get(cellId)
      if (!(yCell instanceof Y.Map)) continue
      await upsertCell(ctx.store, mapYCellToRow(yCell, cellId, ord, ctx))
      await importCellAttachments(ctx, cellId, yCell)
      ord++
      imported++
    }
  })
  return { imported, skipped: false }
}

interface LegacyAttachment {
  url?: string
  type?: string
  createdAt?: number
  isDeleted?: boolean
}

interface LegacyWordTiming {
  word: string
  t0: number
  t1: number
  start: number
  end: number
}

async function importCellAttachments(
  ctx: YDocImportContext,
  cellId: string,
  yCell: Y.Map<unknown>,
): Promise<void> {
  const source = yCell.get("__source") as
    | {
        metadata?: {
          attachments?: Record<string, LegacyAttachment>
          audioTimings?: Record<string, LegacyWordTiming[]>
        }
      }
    | undefined

  const attachments = source?.metadata?.attachments
  if (attachments) {
    for (const [attId, att] of Object.entries(attachments)) {
      if (!att || att.isDeleted) continue
      await ctx.store.run(
        `INSERT OR REPLACE INTO cell_attachments (
          id, cell_id, kind, ref, blob_key, display_name, metadata,
          added_by, added_at, seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `${cellId}::${attId}`,
          cellId,
          att.type ?? "file",
          att.url ?? null,
          null,
          attId,
          "{}",
          "ydoc-imported",
          att.createdAt ?? ctx.now(),
          0,
        ],
      )
    }
  }

  // Audio timings — paired with attachments by attachmentId. The legacy
  // shape doesn't carry text_snapshot or cell_version_at; on import we
  // capture both from the cell's *current* row so the edit-keyed
  // contract holds going forward. Re-running the importer will refresh
  // these to the latest cell version.
  const audioTimings = source?.metadata?.audioTimings
  if (audioTimings) {
    const cellRow = await ctx.store.query<{
      version: number
      translation_text: string
    }>(
      "SELECT version, translation_text FROM cells WHERE id = ?",
      [cellId],
    )
    const version = cellRow[0]?.version ?? 0
    const text = cellRow[0]?.translation_text ?? ""
    for (const [attId, timings] of Object.entries(audioTimings)) {
      if (!Array.isArray(timings) || timings.length === 0) continue
      await ctx.store.run(
        `INSERT OR REPLACE INTO audio_timings (
          attachment_id, cell_id, cell_version_at, text_snapshot,
          timings_json, generated_by, generated_at, seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `${cellId}::${attId}`,
          cellId,
          version,
          text,
          JSON.stringify(timings),
          "ydoc-imported",
          ctx.now(),
          0,
        ],
      )
    }
  }
}

function mapYCellToRow(
  yCell: Y.Map<unknown>,
  cellId: string,
  ord: number,
  ctx: YDocImportContext,
): CellRow {
  const original = (yCell.get("original") as string | undefined) ?? ""
  const translation = derivePlainText(yCell)
  const context = (yCell.get("context") as string | undefined) ?? ""
  const group = (yCell.get("group") as string | undefined) ?? ""
  const section = (yCell.get("section") as string | undefined) ?? ""
  const type = (yCell.get("type") as string | undefined) ?? "text"
  const cellLabel =
    (yCell.get("cellLabel") as string | undefined) ?? null
  const globalReferences =
    (yCell.get("globalReferences") as string[] | undefined) ?? []

  return {
    id: cellId,
    project_id: ctx.projectId,
    scope_id: ctx.fileId,
    address: cellLabel ?? `cell-${ord}`,
    ord,
    kind: type,
    parent_cell_id: null,
    source_text: original,
    source_text_hash: "ydoc-imported",
    source_version_id: "ydoc-imported",
    translation_text: translation,
    tag_dictionary: "{}",
    status: translation.trim() ? "draft" : "empty",
    approved_at_version: null,
    locked_by_user_id: null,
    version: 0,
    last_edited_by: null,
    last_edited_at: null,
    seq: 0,
    created_at: ctx.now(),
    updated_at: ctx.now(),
    org_id: ctx.orgId,
    source_lang: ctx.sourceLang,
    target_lang: ctx.targetLang,
    format_meta: JSON.stringify({
      context,
      group,
      section,
      globalReferences,
    }),
    label: cellLabel,
    backtranslation_pinned_id: null,
  }
}

function derivePlainText(yCell: Y.Map<unknown>): string {
  const fragment = yCell.get("translatedXml")
  if (fragment instanceof Y.XmlFragment) {
    const parts: string[] = []
    for (const child of fragment.toArray()) {
      parts.push(collectNodeText(child))
    }
    return parts.join("\n").replace(/\n+$/g, "")
  }
  const plain = yCell.get("translated")
  return typeof plain === "string" ? plain : ""
}

function collectNodeText(
  node: Y.XmlElement | Y.XmlText | Y.XmlHook,
): string {
  if (node instanceof Y.XmlText) return node.toString()
  if (node instanceof Y.XmlElement) {
    const inner: string[] = []
    for (const child of node.toArray()) {
      inner.push(
        collectNodeText(child as Y.XmlElement | Y.XmlText | Y.XmlHook),
      )
    }
    return inner.join("")
  }
  return ""
}
