// InsertCell / DeleteCell / SplitCell prepare-commit engine (AQU-1234).
//
// Prepare resolves the file's live anchor chain, refuses the shapes that would
// break a slot-preserving export (see ROUND-TRIP below), pins every chain head
// the compiled events will use as a `parentId`, and stages a plan with
// prepare-time event ids. Commit re-checks those pins (plan_stale on drift),
// compiles the same cell-lifecycle events the workspace emits, and routes them
// through the /events perimeter, which re-authorizes roles and arbitrates the
// AD-2 chain exactly as it does for a human edit.
//
// ── Pinning ──────────────────────────────────────────────────────────────────
// These commands pin their own heads in `plannedIds.structure` rather than in
// the shared `preconditions` list. The shared drift gate compares BOTH the
// source head and the lane's target head for every precondition it holds, and a
// structural edit only cares about the source chain of the cells it re-anchors:
// pinning through the shared list would fail a perfectly good insert because
// somebody translated the successor cell in the meantime. LinkMedia makes the
// same call for the same reason.
//
// ── ROUND-TRIP ───────────────────────────────────────────────────────────────
// Structural edits are REFUSED on a file whose cells carry a preserved export
// slot (IDML v2 / OOXML package-block locators). That is not timidity — those
// exporters address cells by locator and throw on any cell without one:
//   * inserting → `cellContract` throws "no supported IDML v2 locator";
//   * deleting a rejoin sibling → `mergeSlicedUnit` throws "N of them are
//     missing from this export";
//   * splitting → both halves would need consistent rejoin index/count/ranges
//     and a protected-HTML cut that no plain-text offset can make safely.
// Refusing keeps the hard requirement true by construction: a file that
// round-tripped before a structure command still round-trips after it. USFM's
// lossless overlay is keyed by canonical ref instead, so it needs the narrower
// guards noted at each call site.

import { errorResponse, toErrorResponse } from './errors'
import type {
  DeleteCellCommand,
  InsertCellCommand,
  SplitCellCommand,
  StructureCommand,
} from './commands-structure'
import {
  buildProvenance,
  markChangesetStale,
  stampProvenance,
  writeCommittedReceipt,
  type EventsWriteResponse,
} from './commit-gates'
import { stageAndRespond } from './stage'
import { mintInternalSyncToken } from './token-bridge'
import { uuidv7 } from './uuid'
import { handleEventsWriteRequest } from '../events/route'
import type { EventKind, RawEvent } from '../events/types'
import type {
  ChangesetReceipt,
  ChangesetSummary,
  ChangesetWarning,
  ExternalEnv,
  ProvenanceChannel,
  StoredChangeset,
  StructurePlan,
} from './types'
import type { ApiCredentialContext } from '../../../db/shared/api-credentials'

/** One source-side row of a file's anchor chain. */
interface ChainCell {
  cellId: string
  anchorCellId: string | null
  /** Source chain head — the `parentId` a chain-mutating event must carry. */
  eventId: string
  value: string
  valueHtml: string | null
  type: string | null
  canonicalRef: string | null
  sequenceIndex: number | null
}

interface TargetRow {
  lane: string
  eventId: string
  value: string
  valueHtml: string | null
}

/** Mirrors src/lib/timeline/derive.ts `sequenceBetween` — the workspace's
 *  insert uses the same midpoint so display order matches chain order. */
function sequenceBetween(before?: number | null, after?: number | null): number {
  if (before != null && after != null) return (before + after) / 2
  if (before != null) return before + 1
  if (after != null) return after - 1
  return 0
}

function chainCellFromRow(r: {
  cell_id: string
  anchor_cell_id: string | null
  event_id: string
  value: string
  value_html: string | null
  type: string | null
  canonical_ref: string | null
  sequence_index: number | null
}): ChainCell {
  return {
    cellId: r.cell_id,
    anchorCellId: r.anchor_cell_id,
    eventId: r.event_id,
    value: r.value,
    valueHtml: r.value_html,
    type: r.type,
    canonicalRef: r.canonical_ref,
    sequenceIndex: r.sequence_index == null ? null : Number(r.sequence_index),
  }
}

const CHAIN_COLUMNS =
  'cell_id, anchor_cell_id, event_id, value, value_html, type, canonical_ref, sequence_index'

/** One source cell by id, or null. */
async function loadCell(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellId: string,
): Promise<ChainCell | null> {
  const row = await db
    .prepare(
      `SELECT ${CHAIN_COLUMNS} FROM cells
        WHERE project_id = ? AND file_id = ? AND cell_id = ?
          AND side = 'source' AND target_lang = ''`,
    )
    .bind(projectId, fileId, cellId)
    .first<Parameters<typeof chainCellFromRow>[0]>()
  return row ? chainCellFromRow(row) : null
}

/** Every source cell currently anchored AT `anchorCellId` (null = the file
 *  head). Normally one; more than one is a pre-existing sibling split, and
 *  re-pointing all of them preserves that shape one position along. */
async function loadSuccessors(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  anchorCellId: string | null,
): Promise<ChainCell[]> {
  const { results } = anchorCellId === null
    ? await db
        .prepare(
          `SELECT ${CHAIN_COLUMNS} FROM cells
            WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''
              AND anchor_cell_id IS NULL`,
        )
        .bind(projectId, fileId)
        .all<Parameters<typeof chainCellFromRow>[0]>()
    : await db
        .prepare(
          `SELECT ${CHAIN_COLUMNS} FROM cells
            WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''
              AND anchor_cell_id = ?`,
        )
        .bind(projectId, fileId, anchorCellId)
        .all<Parameters<typeof chainCellFromRow>[0]>()
  return results.map(chainCellFromRow)
}

/** Target rows of one cell, one per lane. */
async function loadTargets(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellId: string,
): Promise<TargetRow[]> {
  const { results } = await db
    .prepare(
      `SELECT target_lang, event_id, value, value_html FROM cells
        WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'target'`,
    )
    .bind(projectId, fileId, cellId)
    .all<{ target_lang: string | null; event_id: string; value: string; value_html: string | null }>()
  return results.map((r) => ({
    lane: r.target_lang ?? '',
    eventId: r.event_id,
    value: r.value,
    valueHtml: r.value_html,
  }))
}

/** True when ANY source cell in the file carries a preserved export slot —
 *  see the ROUND-TRIP note at the top of this module.
 *
 *  Only the SLOT-ADDRESSED locator kinds count: `package-block` (the OOXML
 *  docx/pptx path, the one `translationsByPackageBlock` reads) and IDML's own
 *  metadata keys. Every import stamps SOME `sourceLocator` — `PlanImport`
 *  gives plain content a synthetic `{ kind: 'sequence' }` — so testing for the
 *  field's mere existence refused these commands on every file an agent can
 *  create, which is the whole surface AQU-1234 exists to serve. The other
 *  kinds (`sequence`, `cue`, `usfm`, `recipe`, `translation-unit`) are
 *  positional or ref-keyed, not slot-addressed: nothing throws on a cell that
 *  lacks one. USFM's lossless overlay keeps its own narrower guard
 *  (`fileHasLosslessSource`) at each call site.
 *
 *  `jsonb_exists` is the function form of the `?` operator: the Postgres shim
 *  rewrites `?` as a bind placeholder, so the operator form cannot be used
 *  here. */
async function fileHasPreservedSlots(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS hit FROM cells
        WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''
          AND (
            metadata -> 'aquillaImport' -> 'sourceLocator' ->> 'kind' = 'package-block'
            OR jsonb_exists(metadata, 'idml')
            OR jsonb_exists(metadata, 'idmlLocator')
          )
        LIMIT 1`,
    )
    .bind(projectId, fileId)
    .first<{ hit: number }>()
  return row != null
}

/** True when the file keeps a preserved raw source that export overlays
 *  translations onto BY canonical ref (the lossless USFM bundle path). */
async function fileHasLosslessSource(
  db: AquillaDb,
  projectId: string,
  fileId: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM file_source_blobs WHERE project_id = ? AND file_id = ?`)
    .bind(projectId, fileId)
    .first<{ hit: number }>()
  return row != null
}

/**
 * Rows that hang off a cell and would be orphaned by `source.cell.delete`,
 * whose projection removes exactly one `cells` row and cleans up nothing else.
 * Returns the human-readable names of whatever still points at the cell.
 */
async function loadDependents(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  cellId: string,
): Promise<string[]> {
  const probes: [string, string][] = [
    ['validators', `SELECT 1 AS hit FROM cell_validators WHERE project_id = ? AND file_id = ? AND cell_id = ? LIMIT 1`],
    ['waivers', `SELECT 1 AS hit FROM cell_waivers WHERE project_id = ? AND file_id = ? AND cell_id = ? LIMIT 1`],
    ['back-translations', `SELECT 1 AS hit FROM cell_backtranslations WHERE project_id = ? AND file_id = ? AND cell_id = ? LIMIT 1`],
    ['comments', `SELECT 1 AS hit FROM comments WHERE project_id = ? AND file_id = ? AND cell_id = ? AND deleted_at IS NULL LIMIT 1`],
    ['audio takes', `SELECT 1 AS hit FROM cell_audio WHERE project_id = ? AND file_id = ? AND cell_id = ? AND deleted = 0 LIMIT 1`],
  ]
  const found: string[] = []
  for (const [label, sql] of probes) {
    const row = await db.prepare(sql).bind(projectId, fileId, cellId).first<{ hit: number }>()
    if (row) found.push(label)
  }
  const link = await db
    .prepare(
      `SELECT 1 AS hit FROM cell_links
        WHERE project_id = ? AND linked = 1
          AND ((from_file_id = ? AND from_cell_id = ?) OR (to_file_id = ? AND to_cell_id = ?))
        LIMIT 1`,
    )
    .bind(projectId, fileId, cellId, fileId, cellId)
    .first<{ hit: number }>()
  if (link) found.push('cell links')
  const assigned = await db
    .prepare(`SELECT 1 AS hit FROM assignment_cells WHERE file_id = ? AND cell_id = ? LIMIT 1`)
    .bind(fileId, cellId)
    .first<{ hit: number }>()
  if (assigned) found.push('assignment rows')
  return found
}

/** The origin marker an agent-created row carries. Same `kind` the workspace
 *  writes (`isUserAddedLine` is the predicate the exporters read — a blank
 *  inserted cue keeps its timing in VTT/SRT only because of it); `via` records
 *  that this one arrived through the Agent API rather than the editor. */
function agentLineOrigin(splitFrom?: string): Record<string, unknown> {
  return {
    version: 1,
    kind: 'user-insert',
    createdAt: Date.now(),
    via: 'agent-api',
    ...(splitFrom ? { splitFrom } : {}),
  }
}

// ── prepare ──────────────────────────────────────────────────────────────────

/**
 * Prepare a structure changeset (sole command). Resolves the live chain,
 * enforces the round-trip and orphan guards, and stages a fully pinned plan.
 * Any unresolvable reference rejects the whole plan (validation_failed) — a
 * structural plan with a silently skipped step is not an approvable plan.
 */
export async function prepareStructure(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: StructureCommand,
  env: ExternalEnv,
): Promise<Response> {
  const file = await db
    .prepare(`SELECT id, deleted_at FROM files WHERE project_id = ? AND id = ?`)
    .bind(projectId, cmd.fileId)
    .first<{ id: string; deleted_at: number | null }>()
  if (!file) return errorResponse('validation_failed', `file ${cmd.fileId} does not exist`)
  if (file.deleted_at != null) {
    return errorResponse('validation_failed', `file ${cmd.fileId} is deleted`)
  }

  if (await fileHasPreservedSlots(db, projectId, cmd.fileId)) {
    return errorResponse(
      'validation_failed',
      `file ${cmd.fileId} was imported with preserved export slots (IDML/OOXML locators); ` +
        'structural edits would break its round-trip export, so InsertCell / DeleteCell / ' +
        'SplitCell are refused on it. Restructure before import, or export, edit and re-import.',
      { fileId: cmd.fileId, reason: 'preserved_export_slots' },
    )
  }

  if (cmd.kind === 'InsertCell') return prepareInsert(db, cred, projectId, id, autonomyMode, cmd, env)
  if (cmd.kind === 'DeleteCell') return prepareDelete(db, cred, projectId, id, autonomyMode, cmd, env)
  return prepareSplit(db, cred, projectId, id, autonomyMode, cmd, env)
}

async function prepareInsert(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: InsertCellCommand,
  env: ExternalEnv,
): Promise<Response> {
  const anchorId = cmd.afterCellId ?? null
  let anchor: ChainCell | null = null
  if (anchorId !== null) {
    anchor = await loadCell(db, projectId, cmd.fileId, anchorId)
    if (!anchor) {
      return errorResponse(
        'validation_failed',
        `afterCellId ${anchorId} does not exist in file ${cmd.fileId}`,
      )
    }
  }

  const newCellId = cmd.cellId ?? uuidv7()
  const clash = await loadCell(db, projectId, cmd.fileId, newCellId)
  if (clash) {
    return errorResponse('validation_failed', `cell ${newCellId} already exists in file ${cmd.fileId}`)
  }

  // Lossless USFM export overlays translations onto the original source BY
  // canonical ref, into a map — a duplicate ref would silently drop one of the
  // two cells' translations from the deliverable.
  if (cmd.canonicalRef !== undefined) {
    const dup = await db
      .prepare(
        `SELECT 1 AS hit FROM cells
          WHERE project_id = ? AND file_id = ? AND side = 'source' AND target_lang = ''
            AND canonical_ref = ? LIMIT 1`,
      )
      .bind(projectId, cmd.fileId, cmd.canonicalRef)
      .first<{ hit: number }>()
    if (dup) {
      return errorResponse(
        'validation_failed',
        `canonicalRef "${cmd.canonicalRef}" is already used in file ${cmd.fileId}; ` +
          'export overlays translations by ref, so two cells cannot share one',
      )
    }
  }

  const successors = await loadSuccessors(db, projectId, cmd.fileId, anchorId)
  const afterSeq = successors
    .map((s) => s.sequenceIndex)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b)[0]

  const plan: StructurePlan = {
    kind: 'InsertCell',
    newCellId,
    createEventId: uuidv7(),
    sequenceIndex: sequenceBetween(anchor?.sequenceIndex ?? null, afterSeq ?? null),
    reanchor: successors.map((s) => ({
      cellId: s.cellId,
      parentEventId: s.eventId,
      eventId: uuidv7(),
    })),
  }

  const summary: ChangesetSummary = {
    structure: {
      command: 'InsertCell',
      fileId: cmd.fileId,
      cellsAdded: 1,
      cellsRemoved: 0,
      cellsReanchored: plan.reanchor.length,
      targetsRemoved: 0,
      targetsRewritten: 0,
    },
    warnings: [],
  }

  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [cmd],
    preconditions: [],
    summary,
    plannedIds: { structure: plan },
  })
}

async function prepareDelete(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: DeleteCellCommand,
  env: ExternalEnv,
): Promise<Response> {
  const cell = await loadCell(db, projectId, cmd.fileId, cmd.cellId)
  if (!cell) {
    return errorResponse('validation_failed', `cell ${cmd.cellId} does not exist in file ${cmd.fileId}`)
  }

  const dependents = await loadDependents(db, projectId, cmd.fileId, cmd.cellId)
  if (dependents.length > 0) {
    return errorResponse(
      'validation_failed',
      `cell ${cmd.cellId} still owns ${dependents.join(', ')}; deleting the cell would leave them ` +
        'pointing at a row that no longer exists. Clear them first, then delete the cell.',
      { fileId: cmd.fileId, cellId: cmd.cellId, dependents },
    )
  }

  const successors = await loadSuccessors(db, projectId, cmd.fileId, cmd.cellId)
  const targets = await loadTargets(db, projectId, cmd.fileId, cmd.cellId)

  const plan: StructurePlan = {
    kind: 'DeleteCell',
    cellId: cmd.cellId,
    sourceParentEventId: cell.eventId,
    deleteEventId: uuidv7(),
    anchorCellId: cell.anchorCellId,
    reanchor: successors.map((s) => ({
      cellId: s.cellId,
      parentEventId: s.eventId,
      eventId: uuidv7(),
    })),
    targetDeletes: targets.map((t) => ({ lane: t.lane, eventId: uuidv7() })),
  }

  const summary: ChangesetSummary = {
    structure: {
      command: 'DeleteCell',
      fileId: cmd.fileId,
      cellsAdded: 0,
      cellsRemoved: 1,
      cellsReanchored: plan.reanchor.length,
      targetsRemoved: targets.length,
      targetsRewritten: 0,
    },
    warnings: [],
  }

  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [cmd],
    preconditions: [],
    summary,
    plannedIds: { structure: plan },
  })
}

async function prepareSplit(
  db: AquillaDb,
  cred: ApiCredentialContext,
  projectId: string,
  id: string,
  autonomyMode: 'ask' | 'act',
  cmd: SplitCellCommand,
  env: ExternalEnv,
): Promise<Response> {
  const cell = await loadCell(db, projectId, cmd.fileId, cmd.cellId)
  if (!cell) {
    return errorResponse('validation_failed', `cell ${cmd.cellId} does not exist in file ${cmd.fileId}`)
  }
  if (cmd.offset >= cell.value.length) {
    return errorResponse(
      'validation_failed',
      `SplitCell.offset ${cmd.offset} is not inside the cell's source text (length ${cell.value.length}); ` +
        'both halves must be non-empty',
      { fileId: cmd.fileId, cellId: cmd.cellId, sourceLength: cell.value.length },
    )
  }
  // Cutting rich source markup at a plain-text offset would land unbalanced
  // tags on both halves; nothing downstream could repair that.
  if (cell.valueHtml != null && cell.valueHtml.length > 0) {
    return errorResponse(
      'validation_failed',
      `cell ${cmd.cellId} carries structured source HTML; SplitCell cuts plain text only`,
      { fileId: cmd.fileId, cellId: cmd.cellId, reason: 'structured_source_html' },
    )
  }
  // The second half cannot carry the original's canonical ref (export overlays
  // by ref — a duplicate drops one half), so on a lossless-source file the
  // split would silently truncate the exported verse.
  if (cell.canonicalRef && (await fileHasLosslessSource(db, projectId, cmd.fileId))) {
    return errorResponse(
      'validation_failed',
      `cell ${cmd.cellId} is addressed by canonical ref "${cell.canonicalRef}" in a file whose original ` +
        'source is preserved for lossless export; splitting it would drop the second half from the ' +
        'deliverable. Edit the cell text instead, or re-import the file split as you want it.',
      { fileId: cmd.fileId, cellId: cmd.cellId, reason: 'lossless_source_ref' },
    )
  }

  if (cmd.newCellId !== undefined && (await loadCell(db, projectId, cmd.fileId, cmd.newCellId))) {
    return errorResponse(
      'validation_failed',
      `newCellId ${cmd.newCellId} already exists in file ${cmd.fileId}`,
    )
  }

  const targets = await loadTargets(db, projectId, cmd.fileId, cmd.cellId)
  const targetSplits: NonNullable<StructurePlan['targetSplits']> = []
  const targetDeletes: { lane: string; eventId: string }[] = []

  if (cmd.targets === 'divide') {
    const offsets = new Map<string, number>()
    for (const entry of cmd.targetOffsets ?? []) offsets.set(entry.laneId ?? '', entry.offset)
    for (const lane of offsets.keys()) {
      if (!targets.some((t) => t.lane === lane)) {
        return errorResponse(
          'validation_failed',
          `SplitCell.targetOffsets names lane "${lane}", which has no translation on cell ${cmd.cellId}`,
        )
      }
    }
    for (const t of targets) {
      const offset = offsets.get(t.lane)
      if (offset === undefined) {
        return errorResponse(
          'validation_failed',
          `cell ${cmd.cellId} has a translation in ${t.lane ? `lane "${t.lane}"` : 'the default lane'} ` +
            "but targetOffsets gives it no cut point; supply one, or use targets: 'blank'",
          { fileId: cmd.fileId, cellId: cmd.cellId, lane: t.lane },
        )
      }
      if (offset > t.value.length) {
        return errorResponse(
          'validation_failed',
          `SplitCell.targetOffsets offset ${offset} is past the end of the translation in ` +
            `${t.lane ? `lane "${t.lane}"` : 'the default lane'} (length ${t.value.length})`,
          { lane: t.lane, targetLength: t.value.length },
        )
      }
      if (t.valueHtml != null && t.valueHtml.length > 0) {
        return errorResponse(
          'validation_failed',
          `the translation in ${t.lane ? `lane "${t.lane}"` : 'the default lane'} carries structured HTML; ` +
            "SplitCell cuts plain text only — use targets: 'blank' and re-translate both halves",
          { lane: t.lane, reason: 'structured_target_html' },
        )
      }
      targetSplits.push({
        lane: t.lane,
        parentEventId: t.eventId,
        headValue: t.value.slice(0, offset),
        tailValue: t.value.slice(offset),
        headEventId: uuidv7(),
        tailEventId: uuidv7(),
      })
    }
  } else {
    for (const t of targets) targetDeletes.push({ lane: t.lane, eventId: uuidv7() })
  }

  const successors = await loadSuccessors(db, projectId, cmd.fileId, cmd.cellId)
  const afterSeq = successors
    .map((s) => s.sequenceIndex)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b)[0]

  const plan: StructurePlan = {
    kind: 'SplitCell',
    cellId: cmd.cellId,
    sourceParentEventId: cell.eventId,
    commitEventId: uuidv7(),
    sourceHead: cell.value.slice(0, cmd.offset),
    sourceTail: cell.value.slice(cmd.offset),
    newCellId: cmd.newCellId ?? uuidv7(),
    createEventId: uuidv7(),
    sequenceIndex: sequenceBetween(cell.sequenceIndex, afterSeq ?? null),
    ...(cell.type ? { newCellType: cell.type } : {}),
    reanchor: successors.map((s) => ({
      cellId: s.cellId,
      parentEventId: s.eventId,
      eventId: uuidv7(),
    })),
    targetDeletes,
    targetSplits,
  }

  const summary: ChangesetSummary = {
    structure: {
      command: 'SplitCell',
      fileId: cmd.fileId,
      cellsAdded: 1,
      cellsRemoved: 0,
      cellsReanchored: plan.reanchor.length,
      targetsRemoved: targetDeletes.length,
      // Each divided lane rewrites the original AND seeds the new half.
      targetsRewritten: targetSplits.length * 2,
    },
    warnings: [],
  }

  return stageAndRespond(db, env, {
    id,
    projectId,
    createdByUserId: String(cred.userId),
    credentialId: cred.credentialId,
    autonomyMode,
    commands: [cmd],
    preconditions: [],
    summary,
    plannedIds: { structure: plan },
  })
}

// ── commit ───────────────────────────────────────────────────────────────────

/** Re-check every head the plan pinned. Returns a plan_stale Response on drift
 *  (first attempt only — a crash-retry's own partial apply legitimately moved
 *  these heads, and the re-posted prepare-time ids converge through /events
 *  idempotency). */
async function checkPins(
  db: AquillaDb,
  cs: StoredChangeset,
  cmd: StructureCommand,
  plan: StructurePlan,
): Promise<Response | null> {
  const projectId = cs.projectId
  const stale = async (message: string, details?: unknown): Promise<Response> => {
    await markChangesetStale(db, cs.id)
    return errorResponse('plan_stale', message, details)
  }

  for (const r of plan.reanchor) {
    const live = await loadCell(db, projectId, cmd.fileId, r.cellId)
    if (!live) return stale(`cell ${r.cellId} no longer exists`)
    if (live.eventId !== r.parentEventId) {
      return stale(`cell ${r.cellId} changed since prepare`, { cellId: r.cellId })
    }
  }

  if (plan.kind !== 'InsertCell') {
    const live = await loadCell(db, projectId, cmd.fileId, plan.cellId!)
    if (!live) return stale(`cell ${plan.cellId} no longer exists`)
    if (live.eventId !== plan.sourceParentEventId) {
      return stale(`cell ${plan.cellId} changed since prepare`, { cellId: plan.cellId })
    }
  }

  // The reanchor list is the WHOLE set of rows anchored at the edit position.
  // Somebody inserting their own row there between prepare and commit would be
  // left anchored at a cell that is about to move or disappear — an unreachable
  // row the chain walk drags to the tail of the file. Compare the sets, not
  // just the heads we already knew about.
  const anchorPoint = plan.kind === 'InsertCell'
    ? (cmd as InsertCellCommand).afterCellId ?? null
    : plan.cellId!
  const liveSuccessors = await loadSuccessors(db, projectId, cmd.fileId, anchorPoint)
  const plannedSuccessors = new Set(plan.reanchor.map((r) => r.cellId))
  for (const s of liveSuccessors) {
    if (!plannedSuccessors.has(s.cellId)) {
      return stale(`cell ${s.cellId} was moved into this position since prepare`, { cellId: s.cellId })
    }
  }

  // Same reasoning for a delete: a validator, comment, recording or assignment
  // added after prepare would be orphaned by the delete the human approved.
  if (plan.kind === 'DeleteCell') {
    const dependents = await loadDependents(db, projectId, cmd.fileId, plan.cellId!)
    if (dependents.length > 0) {
      return stale(`cell ${plan.cellId} gained ${dependents.join(', ')} since prepare`, { dependents })
    }
  }

  if (plan.newCellId && (await loadCell(db, projectId, cmd.fileId, plan.newCellId))) {
    return stale(`cell ${plan.newCellId} was created since prepare`)
  }

  // An insert whose anchor was deleted would create an orphan pointing at a row
  // that no longer exists.
  if (plan.kind === 'InsertCell') {
    const anchorId = (cmd as InsertCellCommand).afterCellId ?? null
    if (anchorId !== null && !(await loadCell(db, projectId, cmd.fileId, anchorId))) {
      return stale(`afterCellId ${anchorId} no longer exists`, { cellId: anchorId })
    }
  }

  const liveTargets = plan.kind === 'InsertCell'
    ? []
    : await loadTargets(db, projectId, cmd.fileId, plan.cellId!)
  for (const split of plan.targetSplits ?? []) {
    const live = liveTargets.find((t) => t.lane === split.lane)
    if (!live) return stale(`the translation in lane "${split.lane}" no longer exists`)
    if (live.eventId !== split.parentEventId) {
      return stale(`the translation in lane "${split.lane}" changed since prepare`, { lane: split.lane })
    }
  }
  // A lane that gained a translation after prepare would survive a delete or a
  // 'blank' split untouched, contradicting the approved summary — and in the
  // delete case would orphan a target row whose source is gone.
  if (plan.kind !== 'InsertCell' && (plan.targetSplits?.length ?? 0) === 0) {
    const planned = new Set((plan.targetDeletes ?? []).map((t) => t.lane))
    for (const t of liveTargets) {
      if (!planned.has(t.lane)) {
        return stale(`cell ${plan.cellId} gained a translation in lane "${t.lane}" since prepare`, {
          lane: t.lane,
        })
      }
    }
  }

  return null
}

/**
 * Commit a structure changeset. The shared gates (expiry, ask-mode
 * confirmation, the staged→committing flip) already ran in the commit core;
 * this re-checks the plan's own pins, compiles the cell-lifecycle events, and
 * routes them through the /events perimeter.
 *
 * Event ORDER inside the batch matters: the create lands before the reorders
 * that point at it, so the chain is never momentarily broken, and a split's
 * `source.cell.commit` lands before the target commits that pin their
 * staleness against its new event id.
 */
export async function commitStructure(
  request: Request,
  env: ExternalEnv,
  db: AquillaDb,
  cred: ApiCredentialContext,
  cs: StoredChangeset,
  cmd: StructureCommand,
  confirmationId: string | null,
  channel: ProvenanceChannel,
  wasStaged: boolean,
  ctx: Pick<ExecutionContext, 'waitUntil'> | undefined,
): Promise<Response> {
  const plan = cs.plannedIds?.structure
  if (!plan || plan.kind !== cmd.kind) {
    return errorResponse('job_failed', 'stored plan is missing its structure ledger')
  }

  if (wasStaged) {
    const drifted = await checkPins(db, cs, cmd, plan)
    if (drifted) return drifted
  }

  const projectId = cs.projectId
  const clientTs = Date.now()
  const fileId = cmd.fileId
  const events: RawEvent[] = []

  const push = (
    kind: EventKind,
    eventId: string,
    cellId: string,
    parentId: string | null,
    payload: Record<string, unknown>,
  ): void => {
    events.push({
      id: eventId,
      schemaVersion: 1,
      kind,
      projectId,
      fileId,
      cellId,
      parentId,
      author: cred.username,
      payload,
      clientTs,
    } as unknown as RawEvent)
  }

  if (cmd.kind === 'InsertCell') {
    push('source.cell.create', plan.createEventId!, plan.newCellId!, null, {
      cellId: plan.newCellId,
      anchorCellId: cmd.afterCellId ?? null,
      value: cmd.value,
      ...(cmd.type !== undefined ? { type: cmd.type } : {}),
      ...(cmd.canonicalRef !== undefined ? { canonicalRef: cmd.canonicalRef } : {}),
      ...(cmd.startMs !== undefined ? { startMs: cmd.startMs } : {}),
      ...(cmd.endMs !== undefined ? { endMs: cmd.endMs } : {}),
      sequenceIndex: plan.sequenceIndex,
      metadata: { ...(cmd.metadata ?? {}), aquillaOrigin: agentLineOrigin() },
    })
    for (const r of plan.reanchor) {
      push('source.cell.reorder', r.eventId, r.cellId, r.parentEventId, {
        anchorCellId: plan.newCellId,
      })
    }
  }

  if (cmd.kind === 'DeleteCell') {
    // Re-point first: whatever followed this cell must land on its anchor, or
    // the rows behind it become unreachable and walk to the file's tail.
    for (const r of plan.reanchor) {
      push('source.cell.reorder', r.eventId, r.cellId, r.parentEventId, {
        anchorCellId: plan.anchorCellId ?? null,
      })
    }
    // parentId null is the trusted-tombstone shape for a target delete (it is
    // deliberately not chain-arbitrated), matching the workspace's remove-line.
    for (const t of plan.targetDeletes ?? []) {
      push('target.cell.delete', t.eventId, plan.cellId!, null, t.lane ? { targetLang: t.lane } : {})
    }
    push('source.cell.delete', plan.deleteEventId!, plan.cellId!, plan.sourceParentEventId!, {})
  }

  if (cmd.kind === 'SplitCell') {
    // Both halves were cut at prepare, from the source text the pin above
    // proves is still the live one — commit applies the plan, never a fresh
    // recomputation of it.
    push('source.cell.commit', plan.commitEventId!, plan.cellId!, plan.sourceParentEventId!, {
      value: plan.sourceHead ?? '',
    })
    push('source.cell.create', plan.createEventId!, plan.newCellId!, null, {
      cellId: plan.newCellId,
      anchorCellId: plan.cellId,
      value: plan.sourceTail ?? '',
      ...(plan.newCellType ? { type: plan.newCellType } : {}),
      sequenceIndex: plan.sequenceIndex,
      metadata: { aquillaOrigin: agentLineOrigin(plan.cellId) },
    })
    for (const r of plan.reanchor) {
      push('source.cell.reorder', r.eventId, r.cellId, r.parentEventId, {
        anchorCellId: plan.newCellId,
      })
    }
    for (const t of plan.targetDeletes ?? []) {
      push('target.cell.delete', t.eventId, plan.cellId!, null, t.lane ? { targetLang: t.lane } : {})
    }
    for (const s of plan.targetSplits ?? []) {
      // The original keeps the head of its translation, re-pinned to the source
      // text it now holds; the new cell's first target commit chains on its
      // source create, exactly as a bilingual import's variants do.
      push('target.cell.commit', s.headEventId, plan.cellId!, s.parentEventId, {
        value: s.headValue ?? '',
        sourceEventId: plan.commitEventId,
        ...(s.lane ? { targetLang: s.lane } : {}),
      })
      push('target.cell.commit', s.tailEventId, plan.newCellId!, plan.createEventId!, {
        value: s.tailValue ?? '',
        sourceEventId: plan.createEventId,
        ...(s.lane ? { targetLang: s.lane } : {}),
      })
    }
  }

  let token: string
  try {
    token = await mintInternalSyncToken(env, db, cred, projectId, fileId)
  } catch (err) {
    return toErrorResponse(err)
  }

  const req = new Request('https://internal/events', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  })
  const res = await handleEventsWriteRequest(req, env, ctx)
  if (!res) return errorResponse('job_failed', 'events perimeter did not respond')
  const out = (await res.json()) as EventsWriteResponse

  const acceptedIds = new Set(out.accepted.map((a) => a.id))
  const rejected = out.rejected
  if (acceptedIds.size === 0 && rejected.length > 0) {
    const anyForbidden = rejected.some((r) => r.status === 403)
    return errorResponse(
      anyForbidden ? 'permission_denied' : 'job_failed',
      'no events were applied',
      { rejected },
    )
  }

  const provenance = buildProvenance(request, cs, confirmationId, channel)
  const appliedIds = events.map((e) => e.id).filter((eid) => acceptedIds.has(eid))
  await stampProvenance(db, provenance, appliedIds)

  const warnings: ChangesetWarning[] = [...cs.summary.warnings]
  for (const r of rejected) {
    warnings.push({ code: 'rejected', fileId, cellId: '', message: `${r.id}: ${r.reason}` })
  }
  // A structural plan is one indivisible edit: a partially applied chain is a
  // broken document, so a rejection keeps the row in 'committing' and a retry
  // re-posts the same ids until every event lands.
  const receipt: ChangesetReceipt = {
    eventIds: appliedIds,
    appliedCount: appliedIds.length,
    staleCount: out.stale?.length ?? 0,
    warnings,
    committedAt: new Date().toISOString(),
  }
  if (rejected.length > 0) {
    await db
      .prepare(`UPDATE changesets SET receipt = ?::text::jsonb WHERE id = ? AND status = 'committing'`)
      .bind(JSON.stringify(receipt), cs.id)
      .run()
    return errorResponse(
      'job_failed',
      'structural edit partially failed — retry will resume the same plan',
      { receipt },
    )
  }

  await writeCommittedReceipt(db, cs.id, receipt, confirmationId)
  return Response.json({ receipt })
}
