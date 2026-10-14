import { describe, it, expect, beforeEach, vi } from "vitest"
import { queueCheckingFeedback, guestOutboxScope, flushCheckingFeedback } from "./feedback"
import { peekPendingOutboxBatch, setActiveOutboxOwner, resetOutboxConnectionForTests } from "@/lib/sync/outbox"
import { feedbackSchema } from "../../../sync-worker/src/checking/policy"
import type { CheckingSession } from "./api"
const request = vi.hoisted(() => vi.fn())
vi.mock("./api", () => ({ checkingRequest: request }))
const guest: CheckingSession = { guestId: "guest-1", session: "session", name: "Kathryn", title: "Review", role: "commenter", projectId: "p" }
beforeEach(async () => {
  await resetOutboxConnectionForTests()
  const dbs = await indexedDB.databases()
  for (const db of dbs) if (db.name) await new Promise<void>(resolve => { const r = indexedDB.deleteDatabase(db.name!); r.onsuccess = () => resolve() })
  setActiveOutboxOwner("signed-in-account")
  request.mockReset()
})
describe("guest feedback producer → gateway contract", () => {
  it("passes the real producer output to the gateway schema, isolates ownership, and removes only acknowledged feedback", async () => {
    const id = await queueCheckingFeedback(guest, { fileId: "f", cellId: "c", fileName: "Mark", label: "MRK 1:1", text: "Text", side: "target" }, " Clear! ")
    expect(await peekPendingOutboxBatch(100, { ownerKey: "signed-in-account" })).toEqual([])
    const [record] = await peekPendingOutboxBatch(100, guestOutboxScope(guest))
    expect(feedbackSchema.parse(record.event).payload.body).toBe("Clear!")
    request.mockRejectedValueOnce(new Error("offline"))
    await expect(flushCheckingFeedback("link", guest)).rejects.toThrow("offline")
    expect(await peekPendingOutboxBatch(100, guestOutboxScope(guest))).toHaveLength(1)
    request.mockResolvedValue({ accepted: [{ id }], rejected: [] })
    await flushCheckingFeedback("link", guest)
    expect(await peekPendingOutboxBatch(100, guestOutboxScope(guest))).toHaveLength(0)
  })
})
