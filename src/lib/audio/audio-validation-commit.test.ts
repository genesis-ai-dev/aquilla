/**
 * AQU-490: what has to happen after an audio vote.
 *
 * These tests assert the REFETCH, never an icon. That distinction is the whole
 * lesson of the bug: every validation surface looked correct after a click
 * because the control paints an optimistic vote, while the data underneath had
 * not moved and would not until a reload. An icon assertion would have passed
 * throughout.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const flushOutboxBatch = vi.hoisted(() => vi.fn(async () => ({}) as never))
vi.mock("@/lib/sync/outbox-flush", () => ({ flushOutboxBatch }))

import { commitAudioValidation } from "./audio-validation-commit"
import { subscribeAudioAttachments } from "./audio-attachments-bus"

const deps = { getTokenForFile: vi.fn(async () => ({ token: "t" }) as never) }

beforeEach(() => {
  flushOutboxBatch.mockClear()
  flushOutboxBatch.mockImplementation(async () => ({}) as never)
})

/** Record the order of everything, because the order is the fix. */
function watch(fileId: string, log: string[]) {
  return subscribeAudioAttachments(fileId, () => log.push(`poke:${fileId}`))
}

describe("commitAudioValidation", () => {
  it("pokes the file whose take was voted on", async () => {
    const log: string[] = []
    const off = watch("f1", log)
    await commitAudioValidation(["f1"], deps)
    expect(log).toEqual(["poke:f1"])
    off()
  })

  // THE ORDERING, and the reason this is a function rather than a line of
  // `notifyAudioAttachmentsChanged` at five call sites. A vote rides the
  // outbox; poking first refetches the server BEFORE the vote reaches it, so
  // the gutter would repaint the old value — a flicker backwards, which is
  // worse than the staleness it replaces.
  it("flushes BEFORE it pokes, never after", async () => {
    const log: string[] = []
    flushOutboxBatch.mockImplementation(async () => {
      log.push("flush")
      return {} as never
    })
    const off = watch("f1", log)
    await commitAudioValidation(["f1"], deps)
    expect(log).toEqual(["flush", "poke:f1"])
    off()
  })

  // A bulk validation over subtitle rows touches the CUE SIBLING, where the
  // takes actually live. Poking only the open file left the file that changed
  // stale, which is what the whole-file action did before this existed.
  it("pokes every file the vote touched, once each", async () => {
    const log: string[] = []
    const offs = [watch("f1", log), watch("f2", log)]
    await commitAudioValidation(["f1", "f2", "f1"], deps)
    expect(log.sort()).toEqual(["poke:f1", "poke:f2"])
    expect(flushOutboxBatch).toHaveBeenCalledTimes(1)
    for (const off of offs) off()
  })

  // A queued vote is not worth an error dialog: the periodic flusher will
  // carry it. The poke still happens, because another client may have moved
  // the same take in the meantime.
  it("still pokes when the flush fails, and does not throw", async () => {
    const log: string[] = []
    flushOutboxBatch.mockImplementation(async () => { throw new Error("offline") })
    const off = watch("f1", log)
    await expect(commitAudioValidation(["f1"], deps)).resolves.toBeUndefined()
    expect(log).toEqual(["poke:f1"])
    off()
  })

  it("does nothing at all when there is no file to poke", async () => {
    await commitAudioValidation([], deps)
    expect(flushOutboxBatch).not.toHaveBeenCalled()
  })
})
