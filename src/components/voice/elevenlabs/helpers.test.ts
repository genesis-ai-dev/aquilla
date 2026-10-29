import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import { lineSnippet, linesWithTakes } from "./helpers"

const cell = (over: Partial<CellData>): CellData =>
  ({ id: "01a189d9-7f45-71d8", fileId: "f", original: "", translated: "", ...over }) as CellData

describe("clone take picker", () => {
  it("names a line by its text, never its id", () => {
    expect(lineSnippet(cell({ original: "The Levites: the children of Jeshua" }))).toBe("The Levites: the children of Jeshua")
    expect(lineSnippet(cell({ original: "x".repeat(80) }))).toHaveLength(57)
  })

  it("offers the speaker's recording, walking a Change voice result back to it", () => {
    const converted = cell({
      selectedAudioId: "vc-1234abcd-audio-c1-1",
      attachments: {
        "audio-c1-rec": { url: "frontier-audio://audio-c1-rec.wav", type: "audio/wav" },
        "vc-1234abcd-audio-c1-1": { url: "frontier-audio://vc.mp3", type: "audio/mpeg", referenceAudioId: "audio-c1-rec" },
      } as CellData["attachments"],
    })
    const generatedOnly = cell({
      selectedGeneratedVoiceAudioId: "audio-tts-1",
      attachments: { "audio-tts-1": { url: "frontier-audio://tts.mp3", type: "audio/mpeg" } } as CellData["attachments"],
    })
    expect(linesWithTakes([converted, generatedOnly]).map((t) => t.audioId)).toEqual(["audio-c1-rec"])
  })
})
