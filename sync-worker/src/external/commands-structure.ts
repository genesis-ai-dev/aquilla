// Cell-structure commands — InsertCell / DeleteCell / SplitCell (AQU-1234).
//
// The changeset surface could already write a cell's TEXT (SetTranslation) and
// create a whole file (PlanImport), but not restructure an existing one: adding
// a row, removing one, or cutting a long source sentence in two required the
// UI. These three commands close that gap using the SAME cell-lifecycle events
// the workspace emits (`source.cell.create` / `source.cell.reorder` /
// `source.cell.delete` / `source.cell.commit` / `target.cell.*`), so the event
// log after an agent restructure is indistinguishable from a human one.
//
// This module owns the STATIC layer: the command shapes, hand validation, and
// the role floor. Live-state resolution (the anchor chain, the round-trip
// guards, lane discovery) and the compile/commit engine live in
// structure-engine.ts — mirroring the commands-emit-events.ts /
// emit-events-engine.ts split.
//
// MergeCells is DEFERRED, deliberately — see docs/AGENT-API.md § "MergeCells
// (deferred)" for the semantics that could not be settled without a human call.

import { REQUIRED_ROLE, ROLE } from '../events/role-policy'

/**
 * Insert a new source cell into a file's anchor chain.
 *
 * `afterCellId` names the cell the new one follows; null/omitted puts it at the
 * head of the file. Whatever was anchored at that position is re-pointed onto
 * the new cell, so the chain (which is what exporters and `findIndexByCellId`
 * read, not the visual sort) stays in document order — the same two-event
 * shape the workspace's add-row emits.
 */
export interface InsertCellCommand {
  kind: 'InsertCell'
  fileId: string
  /** The cell the new cell follows; null/omitted = insert at the file head. */
  afterCellId?: string | null
  /** Client-chosen id for the new cell; minted at prepare when omitted. */
  cellId?: string
  /** Source text. May be empty — a blank row with timings is legitimate. */
  value: string
  type?: string
  /** Canonical reference (e.g. "GEN 1:1"). Must not collide with an existing
   *  ref in the file: lossless USFM export overlays translations BY ref, so a
   *  duplicate would silently drop one of the two. */
  canonicalRef?: string
  startMs?: number
  endMs?: number
  /** Merged into the cell's metadata bucket alongside the origin marker. */
  metadata?: Record<string, unknown>
}

/**
 * Remove a source cell (and its target rows) from a file.
 *
 * `source.cell.delete`'s projection drops exactly one row and cleans up nothing
 * else, so prepare refuses a cell that still owns validators, waivers,
 * comments, back-translations, audio takes, links or assignment rows rather
 * than orphaning them — the same reasoning the workspace's remove-line applies
 * (see src/lib/timeline/user-lines.ts `isLineEmpty`). Clear those first and the
 * cell becomes removable.
 */
export interface DeleteCellCommand {
  kind: 'DeleteCell'
  fileId: string
  cellId: string
}

/** What a split does with the translations the cell already has. */
export type SplitTargetHandling = 'blank' | 'divide'

/** One lane's cut point for `targets: 'divide'`. */
export interface SplitTargetOffset {
  /** Target-language lane; omit for the default lane. */
  laneId?: string
  /** Character offset into that lane's target text. */
  offset: number
}

/**
 * Divide a cell's source text at a character offset into two cells — the
 * Ukrainian long-sentence case.
 *
 * The original cell keeps `value.slice(0, offset)` (a `source.cell.commit`, so
 * its chain head advances and downstream targets go stale per AD-9); a new cell
 * carrying `value.slice(offset)` is created immediately after it.
 *
 * `targets` is REQUIRED and never inferred: 'blank' deletes the existing
 * translations outright, 'divide' cuts each lane's target at an explicitly
 * supplied offset. Either way BOTH halves end up unvalidated — 'blank' removes
 * the target rows that carried the validation, and 'divide' re-commits them,
 * which resets `validated` because the chain head moved.
 */
export interface SplitCellCommand {
  kind: 'SplitCell'
  fileId: string
  cellId: string
  /** Character offset into the source text; 0 < offset < value.length. */
  offset: number
  targets: SplitTargetHandling
  /** Required with `targets: 'divide'` — one entry per lane that HAS a target
   *  row. A lane left out is rejected rather than silently blanked. */
  targetOffsets?: SplitTargetOffset[]
  /** Client-chosen id for the second half; minted at prepare when omitted. */
  newCellId?: string
}

export type StructureCommand = InsertCellCommand | DeleteCellCommand | SplitCellCommand

const STRUCTURE_KINDS: ReadonlySet<string> = new Set(['InsertCell', 'DeleteCell', 'SplitCell'])

export function isStructureCommandKind(kind: unknown): boolean {
  return typeof kind === 'string' && STRUCTURE_KINDS.has(kind)
}

/**
 * Changeset floor for a structure command: PROJECT_LEAD.
 *
 * role-policy dropped `source.cell.create|delete|reorder` to CONTRIBUTOR so the
 * app's `allowLineCreation` setting can admit contributors, with authorize.ts
 * enforcing the conditional part per event. This surface never runs those
 * per-event conditional checks — exactly the reasoning emitEventsFloor spells
 * out — so an integration restructuring source rows keeps the PROJECT_LEAD
 * floor. SplitCell's compiled target events sit below that, so the max is
 * PROJECT_LEAD for all three.
 */
export function structureCommandFloor(): number {
  return Math.max(
    ROLE.PROJECT_LEAD,
    REQUIRED_ROLE['target.cell.commit'],
    REQUIRED_ROLE['target.cell.delete'],
  )
}

export interface StructureValidationIssue {
  index: number
  message: string
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isIntegerAtLeast(v: unknown, min: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min
}

/**
 * Validate one raw structure command into its normalized form (shape only —
 * chain position, round-trip bindings, lane existence and offset bounds against
 * the real text are all prepare-time, in structure-engine.ts).
 */
export function validateStructureCommand(
  c: Record<string, unknown>,
  index: number,
  issues: StructureValidationIssue[],
): StructureCommand | null {
  const bad = (message: string): null => {
    issues.push({ index, message })
    return null
  }
  const kind = c.kind as string

  if (!isNonEmptyString(c.fileId)) return bad(`${kind}.fileId must be a non-empty string`)

  if (kind === 'InsertCell') {
    if (typeof c.value !== 'string') return bad('InsertCell.value must be a string')
    if (c.afterCellId !== undefined && c.afterCellId !== null && !isNonEmptyString(c.afterCellId)) {
      return bad('InsertCell.afterCellId must be a non-empty string or null when present')
    }
    if (c.cellId !== undefined && !isNonEmptyString(c.cellId)) {
      return bad('InsertCell.cellId must be a non-empty string when present')
    }
    for (const k of ['type', 'canonicalRef'] as const) {
      if (c[k] !== undefined && !isNonEmptyString(c[k])) {
        return bad(`InsertCell.${k} must be a non-empty string when present`)
      }
    }
    for (const k of ['startMs', 'endMs'] as const) {
      if (c[k] !== undefined && !isIntegerAtLeast(c[k], 0)) {
        return bad(`InsertCell.${k} must be an integer >= 0 when present`)
      }
    }
    if (c.metadata !== undefined && !isPlainObject(c.metadata)) {
      return bad('InsertCell.metadata must be an object when present')
    }
    // The origin marker is server-written (it is the durable "a person or agent
    // made this row" signal the exporters read); a caller-supplied one would
    // forge provenance.
    if (isPlainObject(c.metadata) && c.metadata.aquillaOrigin !== undefined) {
      return bad('InsertCell.metadata.aquillaOrigin is server-written — omit it')
    }
    return {
      kind: 'InsertCell',
      fileId: c.fileId,
      ...(c.afterCellId !== undefined ? { afterCellId: c.afterCellId as string | null } : {}),
      ...(c.cellId !== undefined ? { cellId: c.cellId as string } : {}),
      value: c.value,
      ...(c.type !== undefined ? { type: c.type as string } : {}),
      ...(c.canonicalRef !== undefined ? { canonicalRef: c.canonicalRef as string } : {}),
      ...(c.startMs !== undefined ? { startMs: c.startMs as number } : {}),
      ...(c.endMs !== undefined ? { endMs: c.endMs as number } : {}),
      ...(c.metadata !== undefined ? { metadata: c.metadata } : {}),
    }
  }

  if (kind === 'DeleteCell') {
    if (!isNonEmptyString(c.cellId)) return bad('DeleteCell.cellId must be a non-empty string')
    return { kind: 'DeleteCell', fileId: c.fileId, cellId: c.cellId }
  }

  if (kind === 'SplitCell') {
    if (!isNonEmptyString(c.cellId)) return bad('SplitCell.cellId must be a non-empty string')
    if (!isIntegerAtLeast(c.offset, 1)) {
      return bad('SplitCell.offset must be an integer >= 1 (both halves must be non-empty)')
    }
    if (c.targets !== 'blank' && c.targets !== 'divide') {
      return bad("SplitCell.targets must be 'blank' or 'divide'")
    }
    if (c.newCellId !== undefined && !isNonEmptyString(c.newCellId)) {
      return bad('SplitCell.newCellId must be a non-empty string when present')
    }
    let targetOffsets: SplitTargetOffset[] | undefined
    if (c.targetOffsets !== undefined) {
      if (c.targets !== 'divide') {
        return bad("SplitCell.targetOffsets is only meaningful with targets: 'divide'")
      }
      if (!Array.isArray(c.targetOffsets)) return bad('SplitCell.targetOffsets must be an array')
      targetOffsets = []
      const seen = new Set<string>()
      for (const [i, raw] of c.targetOffsets.entries()) {
        if (!isPlainObject(raw)) return bad(`SplitCell.targetOffsets[${i}] must be an object`)
        if (raw.laneId !== undefined && !isNonEmptyString(raw.laneId)) {
          return bad(`SplitCell.targetOffsets[${i}].laneId must be a non-empty string when present`)
        }
        if (!isIntegerAtLeast(raw.offset, 0)) {
          return bad(`SplitCell.targetOffsets[${i}].offset must be an integer >= 0`)
        }
        const lane = (raw.laneId as string | undefined) ?? ''
        if (seen.has(lane)) {
          return bad(`SplitCell.targetOffsets names lane "${lane}" twice — one offset per lane`)
        }
        seen.add(lane)
        targetOffsets.push({
          ...(raw.laneId !== undefined ? { laneId: raw.laneId as string } : {}),
          offset: raw.offset as number,
        })
      }
    }
    return {
      kind: 'SplitCell',
      fileId: c.fileId,
      cellId: c.cellId,
      offset: c.offset as number,
      targets: c.targets,
      ...(targetOffsets !== undefined ? { targetOffsets } : {}),
      ...(c.newCellId !== undefined ? { newCellId: c.newCellId as string } : {}),
    }
  }

  // Unreachable — the caller checked the kind against STRUCTURE_KINDS.
  return bad(`unsupported structure command kind: ${String(kind)}`)
}
