// Clone a file's current projection onto a new file id so "Make an updated
// copy" can run the review apply there. The original file is not in the
// event list. Cell ids are reused: the cells key includes file_id.

import type { PersistedEvent } from './event-projection'
import type { EventPayloads } from './types'
import type { ExistingImportCell } from './import-reconcile-route'

export interface ForkTargetRow {
  cellId: string
  eventId: string
  value: string
  valueHtml: string | null
  laneId: string | null
  targetLang: string
}

export interface ForkValidatorRow {
  cellId: string
  username: string
  laneId: string | null
  targetLang: string
  /** Target event the vote currently endorses. Inactive votes are not copied. */
  editEventId: string
}

export interface ForkClone {
  fileEventId: string
  events: PersistedEvent[]
  /** Destination target event id keyed by `${cellId}\0${laneId ?? ''}`. */
  targetEventIds: Map<string, string>
}

function targetKey(cellId: string, laneId: string | null): string {
  return `${cellId}\0${laneId ?? ''}`
}

export function targetEventKey(cellId: string, laneId: string | null): string {
  return targetKey(cellId, laneId)
}

export function buildForkClone(input: {
  projectId: string
  fileId: string
  fileEventId: string
  author: string
  clientTs: number
  file: EventPayloads['file.create']
  cells: readonly ExistingImportCell[]
  sourceEventIds: ReadonlyMap<string, string>
  targets: readonly ForkTargetRow[]
  validators: readonly ForkValidatorRow[]
  /** Cells parked on the original. The copy starts parked too. */
  hiddenCellIds?: ReadonlySet<string>
}): ForkClone {
  const events: PersistedEvent[] = []
  events.push({
    id: input.fileEventId,
    schemaVersion: 1,
    projectId: input.projectId,
    fileId: input.fileId,
    cellId: null,
    parentId: null,
    kind: 'file.create',
    author: input.author,
    payload: input.file,
    clientTs: input.clientTs,
    serverTs: 0,
  })

  for (const cell of input.cells) {
    const id = input.sourceEventIds.get(cell.cellId)
    if (!id) continue
    const payload: EventPayloads['source.cell.create'] = {
      cellId: cell.cellId,
      anchorCellId: cell.anchorCellId,
      value: cell.value,
      ...(cell.valueHtml != null ? { valueHtml: cell.valueHtml } : {}),
      ...(cell.type != null ? { type: cell.type } : {}),
      ...(cell.canonicalRef != null ? { canonicalRef: cell.canonicalRef } : {}),
      ...(cell.startMs != null ? { startMs: cell.startMs } : {}),
      ...(cell.endMs != null ? { endMs: cell.endMs } : {}),
      ...(cell.sequenceIndex != null ? { sequenceIndex: cell.sequenceIndex } : {}),
      ...(cell.medium != null ? { medium: cell.medium } : {}),
      metadata: cell.metadata,
    }
    events.push({
      id,
      schemaVersion: 1,
      projectId: input.projectId,
      fileId: input.fileId,
      cellId: cell.cellId,
      parentId: null,
      kind: 'source.cell.create',
      author: input.author,
      payload,
      clientTs: input.clientTs,
      serverTs: 0,
    })
  }

  for (const cellId of input.hiddenCellIds ?? []) {
    events.push({
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
  }

  const targetEventIds = new Map<string, string>()
  const activeTargetEvent = new Map(input.targets.map((target) => [target.eventId, target]))
  for (const target of input.targets) {
    const sourceEventId = input.sourceEventIds.get(target.cellId)
    if (!sourceEventId) continue
    const id = crypto.randomUUID()
    targetEventIds.set(targetKey(target.cellId, target.laneId), id)
    events.push({
      id,
      schemaVersion: 1,
      projectId: input.projectId,
      fileId: input.fileId,
      cellId: target.cellId,
      parentId: sourceEventId,
      kind: 'target.cell.commit',
      author: input.author,
      payload: {
        value: target.value,
        ...(target.valueHtml != null ? { valueHtml: target.valueHtml } : {}),
        sourceEventId,
        ...(target.targetLang ? { targetLang: target.targetLang } : {}),
        ...(target.laneId ? { laneId: target.laneId } : {}),
      },
      clientTs: input.clientTs,
      serverTs: 0,
    })
  }

  for (const validator of input.validators) {
    const target = activeTargetEvent.get(validator.editEventId)
    if (!target || target.cellId !== validator.cellId) continue
    const editEventId = targetEventIds.get(targetKey(validator.cellId, validator.laneId))
    if (!editEventId) continue
    events.push({
      id: crypto.randomUUID(),
      schemaVersion: 1,
      projectId: input.projectId,
      fileId: input.fileId,
      cellId: validator.cellId,
      parentId: null,
      kind: 'cell.validate',
      author: validator.username,
      payload: {
        editEventId,
        ...(validator.targetLang ? { targetLang: validator.targetLang } : {}),
        ...(validator.laneId ? { laneId: validator.laneId } : {}),
      },
      clientTs: input.clientTs,
      serverTs: 0,
    })
  }

  return { fileEventId: input.fileEventId, events, targetEventIds }
}
