import { describe, expect, it, vi } from "vitest"
import type { CellData } from "@/hooks/useCells"

const fetchCellAudio = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => new Uint8Array([1, 2, 3])))
vi.mock("./upload", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchCellAudio: (...a: unknown[]) => fetchCellAudio(...a),
}))
const uploadVoiceReference = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => {}))
vi.mock("./voice-clone", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uploadVoiceReference: (...a: unknown[]) => uploadVoiceReference(...a),
}))

import { cloneVoiceFromTake } from "./clone-from-take"
import { buildFrontierAudioUrl } from "./upload"

describe("cloneVoiceFromTake", () => {
  it("copies the take into the reference store and returns a clone voice on a cloning engine", async () => {
    const url = buildFrontierAudioUrl("r1", "webm")
    const cell = {
      id: "cell-1", fileId: "file-1", selectedAudioId: "r1",
      attachments: { r1: { url, type: "audio/webm" } },
    } as unknown as CellData
    const voice = await cloneVoiceFromTake({
      projectId: "proj-1", cell, audioId: "r1", name: " Ana ", provider: "mms", paletteIndex: 2, session: null,
    })
    expect(fetchCellAudio.mock.calls[0][0]).toMatchObject({ projectId: "proj-1", fileId: "file-1", audioId: "r1", ext: "webm" })
    expect(uploadVoiceReference).toHaveBeenCalledTimes(1)
    expect(voice.name).toBe("Ana")
    expect(voice.referenceAudioId).toBeTruthy()
    expect(voice.referenceTakeKey).toBe("cell-1:recorded")
    // On-device MMS can't clone; the hosted default takes over.
    expect(voice.provider).toBe("inworld")
  })

  it("refuses a take with no stored audio", async () => {
    const cell = { id: "c", fileId: "f", attachments: { a: { url: "blob:x" } } } as unknown as CellData
    await expect(cloneVoiceFromTake({ projectId: "p", cell, audioId: "a", name: "X", paletteIndex: 0, session: null }))
      .rejects.toThrow(/isn't available/)
  })
})
