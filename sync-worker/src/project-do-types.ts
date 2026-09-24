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
  | "source.cell.metadata.patch"
  | "target.cell.create"
  | "target.cell.commit"
  | "target.cell.delete"
  | "target.cell.reorder"
  | "cell.validate"
  | "cell.unvalidate"
  | "cell.audio.attach"
  | "cell.audio.select"
  | "cell.audio.remove"
  // This union had drifted behind the client's outbox grammar, which is the
  // real one (src/lib/sync/outbox-types.ts) — four audio kinds were already
  // missing. It types one descriptive field on a wire frame rather than
  // gating anything, so nothing broke; caught while adding AQU-490's pair.
  | "cell.audio.rename"
  | "cell.audio.trim"
  | "cell.audio.place"
  | "cell.audio.measure"
  | "cell.audio.validate"
  | "cell.audio.unvalidate"
  | "file.create"

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
