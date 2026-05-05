/**
 * Client mirror of sync-worker `events/types.ts` for kinds the web app sends
 * in CQRS Phase 2. Keep field names aligned with RawEvent on the server.
 */

export type CqrsEventKind = "cell.commit" | "cell.validate" | "cell.unvalidate"

export interface CqrsEventPayloads {
  "cell.commit": {
    value: string
    valueHtml: string
    prevEventId?: string
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
