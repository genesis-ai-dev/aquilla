// Live-state reader for the supersession predicate (P1 §3.1). The predicate
// itself (supersede.ts) is pure; this module is the only place that touches the
// database for it, and it reads ONLY what the plan's commands actually
// reference — a plan with no checkable command costs no query.
//
// The readers mirror the ones the changeset engine already uses for
// preconditions (preconditions.ts) and existence (emit-events-engine.ts): same
// `(file_id, cell_id) IN (…)` tuple form, same key helpers, so a lane means
// the same thing here as it does at prepare.

import { cellKey, laneCellKey } from './cell-keys'
import type { Command } from './commands'
import type { LiveTargetValue, SupersedeLiveState } from './supersede'
import { loadProjectSettings } from '../../../db/shared/projects'

interface CellPair {
  fileId: string
  cellId: string
}

/** Exactly the rows a plan's checkable rules need — nothing speculative. */
interface PlanRefs {
  /** Cells a target VALUE is wanted for (SetTranslation). */
  targetCells: CellPair[]
  /** Cells a VALIDATOR set is wanted for (EmitEvents cell.validate). */
  validatorCells: CellPair[]
  /** Cells a WAIVER set is wanted for (EmitEvents cell.waive). */
  waiverCells: CellPair[]
  commentIds: string[]
  needsSettings: boolean
}

function collectRefs(commands: readonly Command[]): PlanRefs {
  const target = new Map<string, CellPair>()
  const validator = new Map<string, CellPair>()
  const waiver = new Map<string, CellPair>()
  const comments = new Set<string>()
  let needsSettings = false

  for (const c of commands) {
    if (c.kind === 'SetTranslation') {
      target.set(cellKey(c.fileId, c.cellId), { fileId: c.fileId, cellId: c.cellId })
      continue
    }
    if (c.kind === 'PatchSettings') {
      needsSettings = true
      continue
    }
    if (c.kind !== 'EmitEvents') continue
    for (const e of c.events) {
      if (e.kind === 'cell.waive' && e.fileId && e.cellId) {
        waiver.set(cellKey(e.fileId, e.cellId), { fileId: e.fileId, cellId: e.cellId })
      }
      if (e.kind === 'cell.validate' && e.fileId && e.cellId) {
        validator.set(cellKey(e.fileId, e.cellId), { fileId: e.fileId, cellId: e.cellId })
      }
      if (e.kind === 'comment.resolve' && typeof e.payload.commentId === 'string') {
        comments.add(e.payload.commentId)
      }
    }
  }
  return {
    targetCells: [...target.values()],
    validatorCells: [...validator.values()],
    waiverCells: [...waiver.values()],
    commentIds: [...comments],
    needsSettings,
  }
}

/** `(file_id, cell_id) IN ((?,?), …)` placeholder + bind list. */
function pairBinds(pairs: readonly { fileId: string; cellId: string }[]): {
  placeholders: string
  binds: unknown[]
} {
  const binds: unknown[] = []
  for (const p of pairs) binds.push(p.fileId, p.cellId)
  return { placeholders: pairs.map(() => '(?, ?)').join(', '), binds }
}

async function readTargetValues(
  db: AquillaDb,
  projectId: string,
  pairs: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, LiveTargetValue>> {
  const map = new Map<string, LiveTargetValue>()
  if (pairs.length === 0) return map
  const { placeholders, binds } = pairBinds(pairs)
  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, target_lang, value, value_html FROM cells
        WHERE project_id = ? AND side = 'target'
          AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(projectId, ...binds)
    .all<{ file_id: string; cell_id: string; target_lang: string | null; value: string; value_html: string | null }>()
  for (const r of results) {
    map.set(laneCellKey(r.file_id, r.cell_id, r.target_lang ?? ''), {
      value: r.value,
      valueHtml: r.value_html,
    })
  }
  return map
}

async function readWaivedRules(
  db: AquillaDb,
  projectId: string,
  pairs: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>()
  if (pairs.length === 0) return map
  const { placeholders, binds } = pairBinds(pairs)
  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, rule_id FROM cell_waivers
        WHERE project_id = ? AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(projectId, ...binds)
    .all<{ file_id: string; cell_id: string; rule_id: string }>()
  for (const r of results) {
    const key = cellKey(r.file_id, r.cell_id)
    const set = map.get(key) ?? new Set<string>()
    set.add(r.rule_id)
    map.set(key, set)
  }
  return map
}

async function readValidators(
  db: AquillaDb,
  projectId: string,
  pairs: readonly { fileId: string; cellId: string }[],
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>()
  if (pairs.length === 0) return map
  const { placeholders, binds } = pairBinds(pairs)
  const { results } = await db
    .prepare(
      `SELECT file_id, cell_id, target_lang, username FROM cell_validators
        WHERE project_id = ? AND (file_id, cell_id) IN (${placeholders})`,
    )
    .bind(projectId, ...binds)
    .all<{ file_id: string; cell_id: string; target_lang: string | null; username: string }>()
  for (const r of results) {
    const key = laneCellKey(r.file_id, r.cell_id, r.target_lang ?? '')
    const set = map.get(key) ?? new Set<string>()
    set.add(r.username)
    map.set(key, set)
  }
  return map
}

async function readCommentResolved(
  db: AquillaDb,
  projectId: string,
  ids: readonly string[],
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>()
  if (ids.length === 0) return map
  const placeholders = ids.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT comment_id, resolved, deleted_at FROM comments
        WHERE project_id = ? AND comment_id IN (${placeholders})`,
    )
    .bind(projectId, ...ids)
    .all<{ comment_id: string; resolved: number; deleted_at: number | null }>()
  // A deleted comment is left OUT of the map: absent means "gone", which the
  // predicate reads as unsatisfied rather than as a resolved thread.
  for (const r of results) {
    if (r.deleted_at != null) continue
    map.set(r.comment_id, Number(r.resolved) === 1)
  }
  return map
}

/**
 * Resolve exactly the live state `isPlanSatisfied` needs for these commands.
 * `actorUsername` is the username the plan's events would be authored by (the
 * committing credential's user) — validation testimony is per-person, so the
 * predicate compares against that name and no other.
 *
 * `settingsOverride` lets the PatchSettings commit path hand in the blob it
 * already re-read as part of its version conflict, instead of paying for a
 * second read of the same row.
 */
export async function resolveSupersedeState(
  db: AquillaDb,
  projectId: string,
  commands: readonly Command[],
  actorUsername: string,
  settingsOverride?: Record<string, unknown>,
): Promise<SupersedeLiveState> {
  const refs = collectRefs(commands)
  const [targetValues, waivedRules, validators, commentResolved] = await Promise.all([
    readTargetValues(db, projectId, refs.targetCells),
    readWaivedRules(db, projectId, refs.waiverCells),
    readValidators(db, projectId, refs.validatorCells),
    readCommentResolved(db, projectId, refs.commentIds),
  ])
  let settings = settingsOverride
  if (settings === undefined && refs.needsSettings) {
    settings = (await loadProjectSettings(db, projectId)).settings
  }
  return {
    targetValues,
    waivedRules,
    validators,
    commentResolved,
    ...(settings !== undefined ? { settings } : {}),
    actorUsername,
  }
}
