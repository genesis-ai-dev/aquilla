/**
 * Receipt warnings for events the /events perimeter refused.
 *
 * The perimeter answers a refusal with only `{ id, status, reason }`, so every
 * commit engine used to emit `{ code: 'rejected', fileId: '', cellId: '' }` and
 * an agent could not tell which line was refused (AQU-1571 policy walk). The
 * engines all hold the raw events they sent, so the location is a lookup away.
 */
import { PROJECT_SENTINEL_FILE_ID } from '../events/authorize'
import type { RawEvent } from '../events/types'
import type { ChangesetWarning } from './types'

/** One refusal as `/events` reports it (EventsWriteResponse.rejected). */
export interface PerimeterRejection {
  id: string
  status: number
  reason: string
}

/** Where a sent event pointed. Blank strings mean "not file / cell scoped". */
export interface EventLocation {
  fileId: string
  cellId: string
}

const NOWHERE: EventLocation = { fileId: '', cellId: '' }

/**
 * Index sent events by id. A project-level event (comments, terms) is routed
 * under the internal `__project__` file id; that is an implementation detail,
 * never a file the agent named, so it reads back blank.
 */
export function locateEvents(
  events: Iterable<Pick<RawEvent, 'id' | 'fileId' | 'cellId'>>,
): Map<string, EventLocation> {
  const where = new Map<string, EventLocation>()
  for (const e of events) {
    const fileId = e.fileId && e.fileId !== PROJECT_SENTINEL_FILE_ID ? e.fileId : ''
    where.set(e.id, { fileId, cellId: e.cellId ?? '' })
  }
  return where
}

/** The perimeter's refusals with the file and cell each one targeted. */
export function locateRejections(
  rejected: readonly PerimeterRejection[],
  where: ReadonlyMap<string, EventLocation>,
): (PerimeterRejection & EventLocation)[] {
  return rejected.map((r) => ({ ...r, ...(where.get(r.id) ?? NOWHERE) }))
}

/** `rejected` receipt warnings naming the refused file and line. */
export function rejectedWarnings(
  rejected: readonly PerimeterRejection[],
  where: ReadonlyMap<string, EventLocation>,
): ChangesetWarning[] {
  return rejected.map((r) => {
    const { fileId, cellId } = where.get(r.id) ?? NOWHERE
    return { code: 'rejected', fileId, cellId, message: `${r.id}: ${r.reason}` }
  })
}
