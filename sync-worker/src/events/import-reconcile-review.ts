// Sidebar re-import ("Update this file" / "Make an updated copy").
//
// The collision path's reconcile keeps validation and leaves removed units in
// place. This mode is the other contract: a source-text change keeps the
// translation, withdraws its votes, and flags the lane for review; a unit that
// only moves is reanchored so the source head (and the amber stale badge) stay
// put; a unit the new file dropped is parked, not deleted.

import { normalizeForMatch } from './import-content-match'
import type { PersistedEvent } from './event-projection'
import type {
  ExistingImportCell,
  ReconciliationPlan,
  ReconcileImportCell,
  ReconcilePlannedCell,
} from './import-reconcile-route'

export interface ReviewTargetRow {
  cellId: string
  laneId: string | null
  /** Event id of the target row the repin must still find. */
  eventId: string
  targetLang: string
}

export interface ReviewValidatorRow {
  cellId: string
  username: string
  laneId: string | null
  targetLang: string
  /** Target commit the vote currently endorses. */
  editEventId: string
}

export interface ReviewCellDecision {
  writeSource: boolean
  reanchor: boolean
  patchMetadata: boolean
  /** Source string changed: unvalidate, flag, and repin. */
  textChanged: boolean
  /** Head moves for a reason other than the source string: repin, keep votes. */
  repinQuiet: boolean
}

function nilStr(value: string | undefined): string | null {
  return value === undefined ? null : value
}

function nilNum(value: number | undefined): number | null {
  return value === undefined ? null : value
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function sourceTextChanged(
  existing: { value: string; valueHtml: string | null },
  incoming: { value?: string; valueHtml?: string },
): boolean {
  return existing.value !== (incoming.value ?? '')
    || existing.valueHtml !== nilStr(incoming.valueHtml)
}

export function reimportHiddenFlag(metadata: Record<string, unknown> | undefined): boolean {
  return objectRecord(metadata?.aquillaImport).reimportHidden === true
}

/** Drop the re-import hide tag without touching the rest of the metadata object. */
function withoutReimportHidden(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = { ...(metadata ?? {}) }
  const aquilla = { ...objectRecord(next.aquillaImport) }
  if (!('reimportHidden' in aquilla) && Object.keys(aquilla).length === 0 && next.aquillaImport === undefined) {
    return next
  }
  delete aquilla.reimportHidden
  next.aquillaImport = aquilla
  return next
}

/** Shallow-merge patch that replaces `aquillaImport` and leaves cast names alone. */
export function aquillaImportPatch(
  metadata: Record<string, unknown> | undefined,
  extra: Record<string, unknown>,
  omit: readonly string[] = [],
): Record<string, unknown> {
  const aquilla = { ...objectRecord(metadata?.aquillaImport), ...extra }
  for (const key of omit) delete aquilla[key]
  return { aquillaImport: aquilla }
}

function structureMatches(
  existing: ExistingImportCell,
  incoming: ReconcileImportCell,
  anchor: string | null,
): boolean {
  return !sourceTextChanged(existing, incoming)
    && existing.type === nilStr(incoming.type)
    && existing.canonicalRef === nilStr(incoming.canonicalRef)
    && existing.startMs === nilNum(incoming.startMs)
    && existing.endMs === nilNum(incoming.endMs)
    && existing.sequenceIndex === nilNum(incoming.sequenceIndex)
    && existing.medium === nilStr(incoming.medium)
    && existing.anchorCellId === anchor
}

export function decideReviewCell(
  cell: ReconcilePlannedCell,
  existing: ExistingImportCell | undefined,
): ReviewCellDecision {
  const none: ReviewCellDecision = {
    writeSource: false, reanchor: false, patchMetadata: false, textChanged: false, repinQuiet: false,
  }
  if (!existing || cell.matchKind === 'new') {
    return { ...none, writeSource: true }
  }
  if (sourceTextChanged(existing, cell.incoming)) {
    // A republished package can change only the apostrophe glyph or the slot
    // split of a heading ("Israelʼs" → "Israel's"). The words are the same, so
    // the translation stays validated and the new source is written quietly.
    const sameWords = normalizeForMatch(existing.value) === normalizeForMatch(cell.incoming.value ?? '')
    if (!sameWords) return { ...none, writeSource: true, textChanged: true }
    return { ...none, writeSource: true, repinQuiet: true }
  }
  const anchor = cell.incoming.anchorCellId ?? null
  if (structureMatches(existing, cell.incoming, anchor)) {
    const metadataDiffers = stableJson(existing.metadata) !== stableJson(cell.incoming.metadata ?? {})
    return { ...none, patchMetadata: metadataDiffers }
  }
  const anchorOnly = structureMatches(existing, cell.incoming, existing.anchorCellId)
    && existing.anchorCellId !== anchor
  if (anchorOnly) {
    const metadataDiffers = stableJson(existing.metadata) !== stableJson(cell.incoming.metadata ?? {})
    return { ...none, reanchor: true, patchMetadata: metadataDiffers }
  }
  return { ...none, writeSource: true, repinQuiet: true }
}

function stampReviewLanes(cell: ReconcilePlannedCell, laneIds: readonly string[]): void {
  const metadata = { ...(cell.incoming.metadata ?? {}) }
  const aquilla = { ...objectRecord(metadata.aquillaImport) }
  delete aquilla.reimportHidden
  if (laneIds.length > 0) aquilla.reviewLanes = [...laneIds]
  else delete aquilla.reviewLanes
  metadata.aquillaImport = aquilla
  cell.incoming.metadata = metadata
}

export interface BuiltReviewEvents {
  events: PersistedEvent[]
  /** Final cell ids that still need a source.cell.create. */
  writeSourceIds: Set<string>
}

/**
 * Side events for one review apply. Mutates text-changed cells' metadata so
 * the source create that follows carries `reviewLanes`. `serverTsStart` is the
 * first free timestamp; returned events consume one each, in order.
 */
export function buildReviewEvents(input: {
  projectId: string
  fileId: string
  author: string
  clientTs: number
  serverTsStart: number
  plan: ReconciliationPlan
  existingById: Map<string, ExistingImportCell>
  hiddenAt: ReadonlyMap<string, number | null>
  targets: readonly ReviewTargetRow[]
  validators: readonly ReviewValidatorRow[]
}): BuiltReviewEvents {
  let serverTs = input.serverTsStart
  const events: PersistedEvent[] = []
  const writeSourceIds = new Set<string>()
  const decisions = new Map<string, ReviewCellDecision>()
  const targetsByCell = new Map<string, ReviewTargetRow[]>()
  for (const target of input.targets) {
    const list = targetsByCell.get(target.cellId) ?? []
    list.push(target)
    targetsByCell.set(target.cellId, list)
  }

  const push = (event: PersistedEvent) => {
    event.serverTs = serverTs++
    events.push(event)
  }

  for (const cell of input.plan.cells) {
    const existing = input.existingById.get(cell.finalCellId)
    const decision = decideReviewCell(cell, existing)
    decisions.set(cell.finalCellId, decision)
    if (decision.writeSource) writeSourceIds.add(cell.finalCellId)
    if (decision.textChanged) {
      const laneIds = (targetsByCell.get(cell.finalCellId) ?? [])
        .map((target) => target.laneId)
        .filter((laneId): laneId is string => Boolean(laneId))
      stampReviewLanes(cell, [...new Set(laneIds)])
    }
    if (decision.reanchor) {
      push({
        id: crypto.randomUUID(),
        schemaVersion: 1,
        projectId: input.projectId,
        fileId: input.fileId,
        cellId: cell.finalCellId,
        parentId: null,
        kind: 'source.cell.reanchor',
        author: input.author,
        payload: { anchorCellId: cell.incoming.anchorCellId ?? null },
        clientTs: input.clientTs,
        serverTs: 0,
      })
    }
    if (decision.patchMetadata && !decision.writeSource) {
      push({
        id: crypto.randomUUID(),
        schemaVersion: 2,
        projectId: input.projectId,
        fileId: input.fileId,
        cellId: cell.finalCellId,
        parentId: null,
        kind: 'source.cell.metadata.patch',
        author: input.author,
        payload: {
          version: 1,
          metadata: withoutReimportHidden(cell.incoming.metadata),
        },
        clientTs: input.clientTs,
        serverTs: 0,
      })
    }
    if ((decision.textChanged || decision.repinQuiet) && decision.writeSource) {
      const sourceEventId = cell.incoming.id
      for (const target of targetsByCell.get(cell.finalCellId) ?? []) {
        push({
          id: crypto.randomUUID(),
          schemaVersion: 1,
          projectId: input.projectId,
          fileId: input.fileId,
          cellId: cell.finalCellId,
          parentId: null,
          kind: 'target.cell.repin',
          author: input.author,
          payload: { sourceEventId, expectedTargetEventId: target.eventId },
          clientTs: input.clientTs,
          serverTs: 0,
        })
      }
    }
    if (decision.textChanged) {
      for (const validator of input.validators) {
        if (validator.cellId !== cell.finalCellId) continue
        push({
          id: crypto.randomUUID(),
          schemaVersion: 1,
          projectId: input.projectId,
          fileId: input.fileId,
          cellId: cell.finalCellId,
          parentId: null,
          kind: 'cell.unvalidate',
          author: input.author,
          payload: {
            editEventId: validator.editEventId,
            targetUsername: validator.username,
            ...(validator.targetLang ? { targetLang: validator.targetLang } : {}),
            ...(validator.laneId ? { laneId: validator.laneId } : {}),
          },
          clientTs: input.clientTs,
          serverTs: 0,
        })
      }
    }
    if (existing && reimportHiddenFlag(existing.metadata) && input.hiddenAt.get(cell.finalCellId) != null) {
      push({
        id: crypto.randomUUID(),
        schemaVersion: 1,
        projectId: input.projectId,
        fileId: input.fileId,
        cellId: cell.finalCellId,
        parentId: null,
        kind: 'source.cell.visibility.set',
        author: input.author,
        payload: { hidden: false },
        clientTs: input.clientTs,
        serverTs: 0,
      })
      if (!decision.writeSource && !decision.patchMetadata) {
        push({
          id: crypto.randomUUID(),
          schemaVersion: 2,
          projectId: input.projectId,
          fileId: input.fileId,
          cellId: cell.finalCellId,
          parentId: null,
          kind: 'source.cell.metadata.patch',
          author: input.author,
          payload: {
            version: 1,
            metadata: aquillaImportPatch(existing.metadata, {}, ['reimportHidden']),
          },
          clientTs: input.clientTs,
          serverTs: 0,
        })
      }
    }
  }

  for (const cellId of input.plan.retainedMissing) {
    const existing = input.existingById.get(cellId)
    if (!existing) continue
    if (input.hiddenAt.get(cellId) != null && reimportHiddenFlag(existing.metadata)) continue
    if (input.hiddenAt.get(cellId) != null && !reimportHiddenFlag(existing.metadata)) continue
    push({
      id: crypto.randomUUID(),
      schemaVersion: 1,
      projectId: input.projectId,
      fileId: input.fileId,
      cellId,
      parentId: null,
      kind: 'source.cell.visibility.set',
      author: input.author,
      payload: { hidden: true },
      clientTs: input.clientTs,
      serverTs: 0,
    })
    push({
      id: crypto.randomUUID(),
      schemaVersion: 2,
      projectId: input.projectId,
      fileId: input.fileId,
      cellId,
      parentId: null,
      kind: 'source.cell.metadata.patch',
      author: input.author,
      payload: {
        version: 1,
        metadata: aquillaImportPatch(existing.metadata, { reimportHidden: true }),
      },
      clientTs: input.clientTs,
      serverTs: 0,
    })
  }

  return { events, writeSourceIds }
}
