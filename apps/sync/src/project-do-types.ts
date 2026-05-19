/**
 * Wire-format types shared between the per-project DO and the client.
 * Re-exports the client's outbox event grammar so both ends are typed
 * against the same shape.
 */

export type OutboxEventKind =
  | "source.cell.create"
  | "source.cell.commit"
  | "source.cell.delete"
  | "source.cell.reorder"
  | "target.cell.create"
  | "target.cell.commit"
  | "target.cell.delete"
  | "target.cell.reorder"
  | "cell.validate"
  | "cell.unvalidate"
  | "cell.endorsement"
  | "cell.endorsement.revoke"
  | "file.create"
  | "project.link-source"

export interface OutboxRawEvent {
  id: string
  schemaVersion: number
  kind: OutboxEventKind
  projectId: string
  fileId?: string
  cellId?: string
  parentId?: string | null
  author: string
  payload: Record<string, unknown>
  clientTs: number
}
