/**
 * Typed access to the cells projection in the local store.
 * See docs/DATA_PERSISTENCE_PLAN.md §4.4 for column semantics.
 */

import type { LocalStore } from "./db"

/** One row of the local `cells` table. Field shapes match the schema 1:1. */
export interface CellRow {
  id: string
  project_id: string
  scope_id: string
  address: string
  ord: number
  kind: string
  parent_cell_id: string | null

  source_text: string
  source_text_hash: string
  source_version_id: string

  translation_text: string
  tag_dictionary: string

  status: string
  approved_at_version: number | null
  locked_by_user_id: string | null

  version: number
  last_edited_by: string | null
  last_edited_at: number | null

  seq: number
  created_at: number
  updated_at: number

  org_id: string
  source_lang: string
  target_lang: string

  format_meta: string

  // Added in migration 002. Optional on the input side so existing fixtures
  // and pre-migration code keep working; the DB columns themselves are
  // nullable so the absence is faithful.
  label?: string | null
  backtranslation_pinned_id?: string | null
}

const UPSERT_SQL = `INSERT OR REPLACE INTO cells (
  id, project_id, scope_id, address, ord, kind, parent_cell_id,
  source_text, source_text_hash, source_version_id,
  translation_text, tag_dictionary,
  status, approved_at_version, locked_by_user_id,
  version, last_edited_by, last_edited_at,
  seq, created_at, updated_at,
  org_id, source_lang, target_lang,
  format_meta, label, backtranslation_pinned_id
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`

export async function upsertCell(
  store: LocalStore,
  cell: CellRow,
): Promise<void> {
  await store.run(UPSERT_SQL, [
    cell.id,
    cell.project_id,
    cell.scope_id,
    cell.address,
    cell.ord,
    cell.kind,
    cell.parent_cell_id,
    cell.source_text,
    cell.source_text_hash,
    cell.source_version_id,
    cell.translation_text,
    cell.tag_dictionary,
    cell.status,
    cell.approved_at_version,
    cell.locked_by_user_id,
    cell.version,
    cell.last_edited_by,
    cell.last_edited_at,
    cell.seq,
    cell.created_at,
    cell.updated_at,
    cell.org_id,
    cell.source_lang,
    cell.target_lang,
    cell.format_meta,
    cell.label ?? null,
    cell.backtranslation_pinned_id ?? null,
  ])
}

export async function getCell(
  store: LocalStore,
  id: string,
): Promise<CellRow | null> {
  const rows = await store.query<CellRow>("SELECT * FROM cells WHERE id = ?", [
    id,
  ])
  return rows[0] ?? null
}

export async function getCellsByScope(
  store: LocalStore,
  projectId: string,
  scopeId: string,
): Promise<CellRow[]> {
  return store.query<CellRow>(
    "SELECT * FROM cells WHERE project_id = ? AND scope_id = ? ORDER BY ord",
    [projectId, scopeId],
  )
}
