/**
 * Client mirror of sync-worker `events/types.ts` for kinds the web app sends
 * in CQRS Phase 2. Keep field names aligned with RawEvent on the server.
 */

export type CqrsEventKind = "cell.commit" | "cell.validate" | "cell.unvalidate"

/**
 * Cell creation metadata captured on first commit (typically during legacy
 * gitlab import). Mirrors `CellSeedMeta` in sync-worker/events/types.ts.
 * Phase 4d hydration on the server reads these to reconstruct a Y.Doc when
 * no R2 snapshot exists yet.
 */
export interface CqrsCellSeedMeta {
  original?: string
  originalHtml?: string
  context?: string
  group?: string
  type?: string
  sourceLocation?: { startTime?: number; endTime?: number; [k: string]: unknown }
  globalReferences?: string[]
  cellLabel?: string
}

export interface CqrsEventPayloads {
  "cell.commit": {
    value: string
    valueHtml: string
    prevEventId?: string
    /** Optional one-time seed metadata; populated on first commit during import. */
    meta?: CqrsCellSeedMeta
  }
  "cell.validate": {
    editEventId: string
  }
  "cell.unvalidate": {
    editEventId: string
  }
}

export type CqrsPayloadFor<K extends CqrsEventKind> = CqrsEventPayloads[K]

export interface CqrsRawEvent<K extends CqrsEventKind = CqrsEventKind> {
  id: string
  schemaVersion: number
  kind: K
  projectId: string
  fileId?: string
  cellId?: string
  author: string
  payload: CqrsPayloadFor<K>
  clientTs: number
}

export const CQRS_SCHEMA_VERSION = 1
