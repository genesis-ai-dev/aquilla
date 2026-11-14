// takeStory (AQU-2577): how a take was made, read off the take itself.
//
// WHY: the clip inspector tells the user what they are listening to, and
// Regenerate re-runs exactly these steps. Calling a person's recording
// "spoken", or losing the reader under a voice change, would regenerate the
// wrong thing over their work.
import { describe, expect, it } from "vitest"
import { takeStory } from "./take-story"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

const settings: ProjectTtsSettings = {
  voices: [
    { id: "layla", name: "Layla", provider: "elevenlabs", elevenLabs: { voiceId: "el1" } },
    { id: "chip", name: "Chip", provider: "elevenlabs", elevenLabs: { voiceId: "el2" } },
  ],
}
const cell = (attachments: Record<string, object>) => ({ id: "c", attachments } as unknown as CellData)
const audio = (extra: object) => ({ url: "frontier-audio://x.mp3", type: "audio", ...extra })

describe("takeStory", () => {
  it("tells recorded, spoken and re-voiced takes apart, and keeps what is underneath a voice change", () => {
    const c = cell({
      "rec.webm": audio({ recordedBy: "joel" }),
      "tts.mp3": audio({ voiceId: "layla" }),
      "vc-1-tts.mp3": audio({ voiceId: "chip", referenceAudioId: "tts.mp3" }),
      "vc-2-rec.wav": audio({ voiceId: "chip", referenceAudioId: "rec.webm" }),
      "vc-3-gone.wav": audio({ voiceId: "deleted-voice", referenceAudioId: "missing.mp3" }),
    })
    const read = (id: string) => {
      const s = takeStory(c, id, settings)
      return s && [s.kind, s.reader?.name ?? null, s.character?.name ?? null, s.recordedBy]
    }
    expect(read("rec.webm")).toEqual(["recorded", null, null, "joel"])
    expect(read("tts.mp3")).toEqual(["spoken", "Layla", null, null])
    expect(read("vc-1-tts.mp3")).toEqual(["revoiced", "Layla", "Chip", null])
    expect(read("vc-2-rec.wav")).toEqual(["revoiced", null, "Chip", "joel"])
    // The source take and the character are both gone: still a voice change, with nothing invented.
    expect(read("vc-3-gone.wav")).toEqual(["revoiced", null, null, null])
    expect(read("nope")).toBeNull()
  })
})
