// AQU-1693: a concept's Bible entity link in the term.* payloads that reach
// the outbox. Why: the projector keeps a link unless an update carries
// `externalIds`, so an unlink must put `{}` on the wire (not drop the key),
// and a create must carry the link or a linked suggestion arrives unlinked.
import { describe, it, expect, beforeEach } from "vitest"
import "fake-indexeddb/auto"
import { emitTermCreate, emitTermUpdate } from "./events-emit"
import { peekOutboxBatch, resetOutboxConnectionForTests } from "./outbox"
import { setCqrsOutboxBridge } from "./cqrs-bridge"

async function payloads(): Promise<unknown[]> {
  return (await peekOutboxBatch(10)).map((record) => (record.event as unknown as { payload: unknown }).payload)
}

describe("term events carry the Bible entity link", () => {
  beforeEach(async () => {
    setCqrsOutboxBridge(null)
    await resetOutboxConnectionForTests()
    await new Promise<void>((resolve, reject) => {
      const d = indexedDB.deleteDatabase("aquilla-cqrs-outbox")
      d.onblocked = () => resolve()
      d.onsuccess = () => resolve()
      d.onerror = () => reject(d.error)
    })
  })

  it("a created concept's link is in its term.create", async () => {
    await emitTermCreate({
      projectId: "p",
      conceptId: "c1",
      sourceTerm: "Jesus",
      renderings: [],
      status: "draft",
      externalIds: { acai: "person:Jesus.2" },
      author: "u",
    })
    expect(await payloads()).toEqual([expect.objectContaining({ externalIds: { acai: "person:Jesus.2" } })])
  })

  it("an unlink puts `{}` on the wire, and an edit that leaves the link alone sends no key", async () => {
    await emitTermUpdate({ projectId: "p", conceptId: "c1", externalIds: {}, author: "u" })
    await emitTermUpdate({ projectId: "p", conceptId: "c1", notes: "n", author: "u" })
    const [unlink, edit] = await payloads()
    expect(unlink).toEqual({ conceptId: "c1", externalIds: {} })
    expect(edit).not.toHaveProperty("externalIds")
  })
})
