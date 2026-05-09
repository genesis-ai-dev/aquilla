/**
 * Mirror: Y.Doc cell.waivers (legacy plain JS array of RuleWaiver) →
 * local-store `waivers` rows. *Edit-keyed* — each row captures
 * `text_snapshot` + `cell_version_at` from the live cell at the moment
 * the waiver appears, so it stays interpretable even after the cell
 * version moves on.
 *
 * Mutation kinds emitted (DATA_PERSISTENCE_PLAN.md §9.2):
 *   waiver.propose      — first time this (cell, rule) waiver is seen
 *   waiver.transition   — observed removal: state → 'revoked'
 *
 * Identity scheme: the legacy waiver shape lacks an id field, so we
 * synthesize one as `{cellId}::{ruleId}`. This keeps cells with multiple
 * concurrent waivers per rule from clobbering each other only because
 * the legacy doesn't allow that case anyway (waivers are deduped on add
 * by ruleId in src/lib/rules/waivers.ts).
 */

import * as Y from "yjs"
import {
  enqueueOutboxRecord,
  getCell,
  getActiveWaiversForCell,
  upsertWaiver,
  type WaiverRow,
} from "@/lib/local-store"
import type { Mirror, MirrorContext } from "./registry"

interface LegacyWaiver {
  ruleId: string
  reason?: string
  waivedAt: string
  waivedBy?: string
}

export interface WaiversMirrorOptions {
  yDoc: Y.Doc
}

export function createWaiversMirror(opts: WaiversMirrorOptions): Mirror {
  const { yDoc } = opts

  return {
    name: "waivers",
    async bootstrap(ctx) {
      const cellsMap = yDoc.getMap("cells") as Y.Map<unknown>
      for (const cellId of cellsMap.keys()) {
        const yCell = cellsMap.get(cellId)
        if (yCell instanceof Y.Map) {
          await syncCellWaivers(ctx, cellId, yCell, { silent: true })
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
            void syncCellWaivers(ctx, cellId, yCell, { silent: false })
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

function waiverIdFor(cellId: string, ruleId: string): string {
  return `${cellId}::${ruleId}`
}

async function syncCellWaivers(
  ctx: MirrorContext,
  cellId: string,
  yCell: Y.Map<unknown>,
  opts: { silent: boolean },
): Promise<void> {
  const liveWaivers =
    (yCell.get("waivers") as LegacyWaiver[] | undefined) ?? []

  const cell = await getCell(ctx.store, cellId)
  // text_snapshot + cell_version_at come from the live cell when the
  // waiver appears. If the cell row isn't in local-store yet (e.g. the
  // mirror runs before Phase D.1 imports the cells), bail — we'll re-sync
  // when the cell row lands.
  if (!cell) return

  const known = await getActiveWaiversForCell(ctx.store, cellId)
  const knownByRule = new Map(known.map((w) => [w.rule_id, w]))
  const liveRuleIds = new Set(liveWaivers.map((w) => w.ruleId))

  // Newly seen waivers → upsert + maybe propose.
  for (const lw of liveWaivers) {
    if (!lw.ruleId) continue
    const existing = knownByRule.get(lw.ruleId)
    if (existing) continue // active waiver already known; no-op
    const row: WaiverRow = {
      id: waiverIdFor(cellId, lw.ruleId),
      cell_id: cellId,
      cell_version_at: cell.version,
      text_snapshot: cell.translation_text,
      rule_id: lw.ruleId,
      state: "approved",
      justification: lw.reason ?? "",
      proposed_by: lw.waivedBy ?? ctx.actorId,
      proposed_at: parseTime(lw.waivedAt) ?? ctx.now(),
      resolved_by: lw.waivedBy ?? ctx.actorId,
      resolved_at: parseTime(lw.waivedAt) ?? ctx.now(),
      seq: 0,
      org_id: cell.org_id,
    }
    await upsertWaiver(ctx.store, row)
    if (!opts.silent) {
      await enqueueOutboxRecord(ctx.store, {
        local_id: `waiver.propose:${row.id}@${ctx.now()}`,
        project_id: cell.project_id,
        endpoint: `/projects/${cell.project_id}/waivers`,
        payload: JSON.stringify({
          kind: "waiver.propose",
          cell_id: cellId,
          cell_version_at: row.cell_version_at,
          text_snapshot: row.text_snapshot,
          rule_id: row.rule_id,
          justification: row.justification,
        }),
        expected_version: null,
        created_at: ctx.now(),
      })
    }
  }

  // Removed waivers → revoke + emit transition.
  for (const existing of known) {
    if (liveRuleIds.has(existing.rule_id)) continue
    const revoked: WaiverRow = {
      ...existing,
      state: "revoked",
      resolved_by: ctx.actorId,
      resolved_at: ctx.now(),
    }
    await upsertWaiver(ctx.store, revoked)
    if (!opts.silent) {
      await enqueueOutboxRecord(ctx.store, {
        local_id: `waiver.transition:${existing.id}@${ctx.now()}`,
        project_id: cell.project_id,
        endpoint: `/projects/${cell.project_id}/waivers/${existing.id}/transition`,
        payload: JSON.stringify({
          kind: "waiver.transition",
          waiver_id: existing.id,
          expected_state: existing.state,
          to_state: "revoked",
        }),
        expected_version: null,
        created_at: ctx.now(),
      })
    }
  }
}

function parseTime(v: unknown): number | null {
  if (typeof v === "number") return v
  if (typeof v !== "string" || !v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}
