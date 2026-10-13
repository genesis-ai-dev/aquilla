import { v7 as uuidv7 } from "uuid"
import { buildRawEvent } from "@/lib/sync/events-emit"
import { enqueueOutboxEvent, peekPendingOutboxBatch, removeOutboxEvents } from "@/lib/sync/outbox"
import { checkingRequest, type CheckingSession, type CheckingRow } from "./api"
export const guestOutboxScope = (guest: CheckingSession) => ({ ownerKey: `checking:${guest.guestId}` })
export async function queueCheckingFeedback(guest: CheckingSession, row: CheckingRow, body: string) {
  const event = buildRawEvent({
    kind: "comment.create", projectId: guest.projectId, fileId: row.fileId,
    cellId: row.cellId, author: guest.name,
    payload: { commentId: uuidv7(), scope: { kind: "cell", fileId: row.fileId, cellId: row.cellId },
      body: body.trim(), parentCommentId: null, createdForTranslated: row.side === "target" ? row.text : null },
  })
  await enqueueOutboxEvent(event, guestOutboxScope(guest))
  return event.id
}
export async function flushCheckingFeedback(link: string, guest: CheckingSession) {
  const scope = guestOutboxScope(guest)
  const pending = await peekPendingOutboxBatch(100, scope)
  for (const record of pending) {
    const result = await checkingRequest<{ accepted: Array<{ id: string }>; rejected: Array<{ reason: string }> }>(`/${link}/events`, guest.session, record.event)
    if (!result.accepted.some(entry => entry.id === record.id)) throw new Error(result.rejected[0]?.reason ?? "Feedback has not been saved yet.")
    await removeOutboxEvents([record.id], scope)
  }
  return pending.length
}
