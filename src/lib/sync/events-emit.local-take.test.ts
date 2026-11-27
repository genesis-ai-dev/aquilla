// Re-check M1a: which of this tab's emits tell auto-even a take changed, and
// how. A words-only attach (transcribe, Transcribe all, a transcript save or
// clear) changes no audio and tells it nothing; a new take is "new"; a trim
// or a cut is "changed".
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./cqrs-bridge", () => ({ getCqrsOutboxBridge: () => null }))
vi.mock("./outbox", () => ({ enqueueOutboxEvent: vi.fn(async () => {}), enqueueOutboxEvents: vi.fn(async () => {}) }))
vi.mock("@/lib/posthog", () => ({ default: { scope: () => ({ capture: () => {} }) } }))

import { emitCellAudioAttach, emitCellAudioCut, emitCellAudioTrim } from "./events-emit"
import { onLocalTakeChange } from "@/lib/audio/local-take-changes"

const where = { projectId: "p1", fileId: "f1", cellId: "c1", author: "sam" }
const heard: Array<{ refs: unknown; kind: string }> = []
const off = onLocalTakeChange((refs, kind) => heard.push({ refs, kind }))
afterEach(() => { heard.length = 0 })
void off

const attach = { ...where, audioId: "a1.wav", url: "frontier-audio://a1.wav", slot: "recording", mimeType: "audio/wav", durationMs: 1000 }

describe("this tab's take changes, from the emitters", () => {
  it("a words-only attach tells auto-even nothing", async () => {
    await emitCellAudioAttach({ ...attach, wordsOnly: true } as Parameters<typeof emitCellAudioAttach>[0])
    expect(heard).toEqual([])
  })

  it("a new take's attach is \"new\"", async () => {
    await emitCellAudioAttach(attach as Parameters<typeof emitCellAudioAttach>[0])
    expect(heard).toEqual([{ refs: [{ cellId: "c1", audioId: "a1.wav" }], kind: "new" }])
  })

  it("an attach that asks to stay quiet (bulk upload) tells it nothing", async () => {
    await emitCellAudioAttach({ ...attach, skipAutoEven: true } as Parameters<typeof emitCellAudioAttach>[0])
    expect(heard).toEqual([])
  })

  it("a trim and a cut are \"changed\"", async () => {
    await emitCellAudioTrim({ ...where, audioId: "a1.wav", trimStartMs: 100, trimEndMs: 900 } as Parameters<typeof emitCellAudioTrim>[0])
    await emitCellAudioCut({ ...where, audioId: "a1.wav", newAudioId: "a2.wav", atMs: 500 } as unknown as Parameters<typeof emitCellAudioCut>[0])
    expect(heard.map((h) => h.kind)).toEqual(["changed", "changed"])
    expect(heard[1].refs).toEqual([{ cellId: "c1", audioId: "a1.wav" }, { cellId: "c1", audioId: "a2.wav" }])
  })
})
