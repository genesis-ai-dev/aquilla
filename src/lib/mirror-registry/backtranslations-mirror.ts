/**
 * Mirror: Y.Doc cell.backtranslation/backtranslationForText/
 * backtranslationUpdatedAt → local-store `backtranslations` rows.
 *
 * Edit-keyed: each row's `text_snapshot` is the legacy
 * `backtranslationForText` (the translated text the back-translation
 * was generated from). `cell_version_at` comes from the live cell when
 * the back-translation appears.
 *
 * Identity scheme: synthesized id = `bt:{cellId}@v{version}`. Combined
 * with the UNIQUE(cell_id, cell_version_at) index, regenerating at the
 * same version replaces in-place; regenerating after a version move
 * creates a new historical row.
 *
 * Mutation kind emitted (DATA_PERSISTENCE_PLAN.md §9.2):
 *   backtranslation.set — accept-as-historical (no version check needed
 *   since the row pins to its own cell_version_at)
 *
 * The user-edit path (`backtranslation.edit`, version-checked LWW)
 * isn't covered here — the legacy Y.Doc shape doesn't distinguish
 * AI vs user. Future work will surface that via UI then route it
 * through a dedicated mutation.
 */

import * as Y from "yjs"
import {
  enqueueOutboxRecord,
  getActiveBacktranslation,
  getCell,
  upsertBacktranslation,
  type BacktranslationRow,
} from "@/lib/local-store"
import type { Mirror, MirrorContext } from "./registry"

export interface BacktranslationsMirrorOptions {
  yDoc: Y.Doc
}

export function createBacktranslationsMirror(
  opts: BacktranslationsMirrorOptions,
): Mirror {
  const { yDoc } = opts

  return {
    name: "backtranslations",
    async bootstrap(ctx) {
      const cellsMap = yDoc.getMap("cells") as Y.Map<unknown>
      for (const cellId of cellsMap.keys()) {
        const yCell = cellsMap.get(cellId)
        if (yCell instanceof Y.Map) {
          await syncCellBacktranslation(ctx, cellId, yCell, { silent: true })
        }
      }
    },
    attach(ctx) {
      const cellsMap = yDoc.getMap("cells") as Y.Map<unknown>
      const handler = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>) => {
        const dirty = new Set<string>()
        for (const event of events) {
          for (const key of event.changes.keys.keys()) {
            dirty.add(key)
          }
          if (typeof event.path[0] === "string") {
            dirty.add(event.path[0])
          }
        }
        for (const cellId of dirty) {
          const yCell = cellsMap.get(cellId)
          if (yCell instanceof Y.Map) {
            void syncCellBacktranslation(ctx, cellId, yCell, {
              silent: false,
            })
          }
        }
      }
      cellsMap.observeDeep(handler)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        cellsMap.unobserveDeep(handler)
      }
    },
  }
}

async function syncCellBacktranslation(
  ctx: MirrorContext,
  cellId: string,
  yCell: Y.Map<unknown>,
  opts: { silent: boolean },
): Promise<void> {
  const back = yCell.get("backtranslation") as string | undefined
  const forText =
    (yCell.get("backtranslationForText") as string | undefined) ?? ""
  const updatedAtStr =
    yCell.get("backtranslationUpdatedAt") as string | undefined

  if (!back) return // No back-translation set on this cell

  const cell = await getCell(ctx.store, cellId)
  if (!cell) return // wait for Phase D.1 importer to land the cell

  const id = `bt:${cellId}@v${cell.version}`
  const existing = await getActiveBacktranslation(ctx.store, cellId)
  const isNewVersion =
    !existing || existing.cell_version_at !== cell.version
  const sameRow =
    existing &&
    existing.cell_version_at === cell.version &&
    existing.back_text === back &&
    existing.text_snapshot === forText
  if (sameRow) return

  const row: BacktranslationRow = {
    id,
    cell_id: cellId,
    cell_version_at: cell.version,
    text_snapshot: forText,
    back_text: back,
    generated_by: "ai:legacy",
    generated_at: parseTime(updatedAtStr) ?? ctx.now(),
    is_user_edited: 0,
    seq: 0,
  }
  await upsertBacktranslation(ctx.store, row)

  if (!opts.silent && isNewVersion) {
    await enqueueOutboxRecord(ctx.store, {
      local_id: `backtranslation.set:${id}`,
      project_id: cell.project_id,
      endpoint: `/projects/${cell.project_id}/backtranslations`,
      payload: JSON.stringify({
        kind: "backtranslation.set",
        cell_id: cellId,
        cell_version_at: row.cell_version_at,
        text_snapshot: row.text_snapshot,
        back_text: row.back_text,
      }),
      expected_version: null,
      created_at: ctx.now(),
    })
  }
}

function parseTime(v: unknown): number | null {
  if (typeof v === "number") return v
  if (typeof v !== "string" || !v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}
