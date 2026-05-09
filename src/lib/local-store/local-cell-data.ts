/**
 * Composes a CellRow + sub-table joins into the read-shape that React
 * consumers want: `LocalCellData`. The shape is a *strict subset* of the
 * legacy CellData interface so consumers can swap the import in place.
 *
 * Joins:
 *   - threads      → cells.id  (cell-keyed)
 *     thread_messages → threads.id
 *   - waivers      → cells.id where state ∈ {proposed, approved}
 *                    (edit-keyed; carries is_stale flag)
 *   - backtranslations → latest by cell_version_at DESC
 *                        (edit-keyed; carries is_stale flag)
 *
 * Fields not yet sourced from local-store are populated with safe
 * defaults so consumers don't crash; they migrate as those subsystems
 * land:
 *   - validationStatus: "none"  (Phase F.8 — audit-overlay migration)
 *   - history:          []      (server-only cell_revisions; fetched on demand)
 *   - attachments:      {}      (Phase F.7 — fold into D.1 importer)
 *   - audioTimings:     {}      (Phase F.7)
 *   - translatedXml:    undefined (legacy Y.XmlFragment; not in local-store)
 *
 * See DATA_PERSISTENCE_PLAN.md §4.10–§4.12 for the data model and
 * EDITOR_REFACTOR_CHECKLIST.md Phase E.3.
 */

import type { LocalStore } from "./db"
import type { CellRow } from "./cells"
import {
  getThreadsByCell,
  getMessagesByThread,
  type ThreadMessageRow,
} from "./threads"
import { getActiveWaiversForCell, type WaiverRow } from "./waivers"
import {
  getActiveBacktranslation,
  type BacktranslationRow,
} from "./backtranslations"

export interface LocalThread {
  id: string
  cell_id: string
  status: string
  created_by: string
  created_at: number
  resolved_by: string | null
  resolved_at: number | null
  messages: ThreadMessageRow[]
}

/** Active waiver with a staleness flag derived from cell.version. */
export interface LocalWaiver extends WaiverRow {
  is_stale: boolean
}

/** Active backtranslation with a staleness flag derived from cell.version. */
export interface LocalBacktranslation extends BacktranslationRow {
  is_stale: boolean
}

export interface LocalCellData {
  /** Stable cell id (`{projectId}:{address}`). */
  id: string
  /** Legacy alias for `scope_id`. */
  fileId: string
  /** Source text (legacy alias for `source_text`). */
  original: string
  /** Translation text (legacy alias for `translation_text`). */
  translated: string
  /** Cell kind (legacy alias for `kind`). */
  type: string
  status: string
  /** Placeholder until Phase F.8 lands the validations join. */
  validationStatus: "none" | "unvalidated" | "validated" | "approved" | "rejected"

  cellLabel?: string | null
  version: number
  /** Per-cell tag dictionary, parsed JSON. */
  tagDictionary: Record<string, unknown>

  // Format-meta-derived fields, parsed once.
  context: string
  group: string
  section: string
  globalReferences?: string[]

  threads: LocalThread[]
  waivers: LocalWaiver[]
  backtranslation: LocalBacktranslation | null
}

export async function rowToLocalCellData(
  store: LocalStore,
  cell: CellRow,
): Promise<LocalCellData> {
  const formatMeta = safeJson(cell.format_meta) as {
    context?: string
    group?: string
    section?: string
    globalReferences?: string[]
  }

  const threadRows = await getThreadsByCell(store, cell.id)
  const threads: LocalThread[] = await Promise.all(
    threadRows.map(async (t) => ({
      id: t.id,
      cell_id: t.cell_id,
      status: t.status,
      created_by: t.created_by,
      created_at: t.created_at,
      resolved_by: t.resolved_by,
      resolved_at: t.resolved_at,
      messages: await getMessagesByThread(store, t.id),
    })),
  )

  const waiverRows = await getActiveWaiversForCell(store, cell.id)
  const waivers: LocalWaiver[] = waiverRows.map((w) => ({
    ...w,
    is_stale: w.cell_version_at !== cell.version,
  }))

  const btRow = await getActiveBacktranslation(store, cell.id)
  const backtranslation: LocalBacktranslation | null = btRow
    ? { ...btRow, is_stale: btRow.cell_version_at !== cell.version }
    : null

  return {
    id: cell.id,
    fileId: cell.scope_id,
    original: cell.source_text,
    translated: cell.translation_text,
    type: cell.kind,
    status: cell.status,
    validationStatus: "none",
    cellLabel: cell.label ?? null,
    version: cell.version,
    tagDictionary: safeJson(cell.tag_dictionary) as Record<string, unknown>,
    context: formatMeta.context ?? "",
    group: formatMeta.group ?? "",
    section: formatMeta.section ?? "",
    globalReferences: formatMeta.globalReferences,
    threads,
    waivers,
    backtranslation,
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return {}
  }
}
