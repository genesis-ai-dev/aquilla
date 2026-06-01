import { describe, it, expect } from "vitest"
import type { CodexCell } from "../codex-editor/types"
import { collectCellAudio, audioAttachEvent } from "./audio"
import { audioAttachEventId } from "./ids"

function cell(metadata: Record<string, unknown>): CodexCell {
  return { kind: 2, languageId: "html", value: "", metadata: metadata as never }
}

describe("collectCellAudio", () => {
  it("imports the selected recording, skips deleted, derives audioId from the url", () => {
    const c = cell({
      id: "x",
      type: "text",
      selectedAudioId: "a1",
      attachments: {
        a1: { url: ".project/attachments/files/seg/a1.webm", type: "audio", isDeleted: false, createdBy: "wendilord", createdAt: 99, metadata: { mimeType: "audio/webm", durationSec: 8.28 } },
        a0: { url: ".project/attachments/files/seg/a0.webm", type: "audio", isDeleted: true },
      },
    })
    const got = collectCellAudio(c)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({
      aquillaAudioId: "a1.webm",
      slot: "recording",
      createdBy: "wendilord",
      mimeType: "audio/webm",
      durationMs: 8280,
    })
  })

  it("returns nothing when the selected clip is deleted and selection is ambiguous", () => {
    const c = cell({
      id: "x",
      selectedAudioId: null,
      attachments: {
        a1: { url: "x/a1.webm", type: "audio", isDeleted: true },
        a2: { url: "x/a2.webm", type: "audio", isDeleted: true },
      },
    })
    expect(collectCellAudio(c)).toHaveLength(0)
  })

  it("falls back to the sole non-deleted clip when nothing is selected", () => {
    const c = cell({
      id: "x",
      attachments: { a2: { url: "x/a2.webm", type: "audio", isDeleted: false } },
    })
    const got = collectCellAudio(c)
    expect(got).toHaveLength(1)
    expect(got[0].aquillaAudioId).toBe("a2.webm")
  })

  it("imports a selected generated voice in its own slot", () => {
    const c = cell({
      id: "x",
      selectedGeneratedVoiceAudioId: "v1",
      attachments: { v1: { url: "x/v1.webm", type: "audio", isDeleted: false } },
    })
    const got = collectCellAudio(c)
    expect(got[0].slot).toBe("generatedVoice")
  })
})

describe("audioAttachEvent", () => {
  it("builds a deterministic cell.audio.attach with a frontier-audio:// url", () => {
    const opts = { projectId: "p", fileId: "f", fallbackAuthor: "x", fallbackTs: 1 }
    const a = { legacyAudioId: "a1", aquillaAudioId: "a1.webm", diskRelPath: "x/a1.webm", slot: "recording" as const, createdBy: "wendilord", createdAt: 50, durationMs: 8280 }
    const ev = audioAttachEvent("cue1", a, opts)
    expect(ev.id).toBe(audioAttachEventId("p", "f", "cue1", "a1.webm"))
    expect(ev.author).toBe("wendilord")
    expect(ev.clientTs).toBe(50)
    expect(ev.payload).toMatchObject({ audioId: "a1.webm", url: "frontier-audio://a1.webm", slot: "recording", durationMs: 8280 })
  })
})
