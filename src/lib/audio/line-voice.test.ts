import { describe, expect, it } from "vitest"
import {
  cloneNameSuggestion,
  lineTake,
  lineTakeLabel,
  lineVoiceActionFor,
  lineVoicePending,
} from "./line-voice"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"

// The Audio view card's own cases (#1685, CellVoicePanel.chip.test), on the
// rules that outlived it.
const mary: Voice = { id: "v-mary", name: "Mary", color: "#111", provider: "gemini", voiceName: "Kore" }
const john: Voice = { id: "v-john", name: "John", color: "#333", provider: "gemini", voiceName: "Puck" }
// A character: an RVC library voice, so it can re-voice a take.
const hearth: Voice = { id: "v-hearth", name: "Hearth", color: "#222", libraryVoiceId: "narrator-hearth" }
const settings = (castAssignments: Record<string, string> = {}): ProjectTtsSettings =>
  ({ voices: [mary, john, hearth], defaultVoiceId: "v-mary", castAssignments }) as ProjectTtsSettings

const base = { id: "cell-1", fileId: "f1", translated: "Hello there", original: "Hola", type: "text" }
const recorded = {
  ...base,
  selectedAudioId: "r1",
  attachments: { r1: { url: "blob:r", type: "audio/wav" } },
} as unknown as CellData
const byAna = { ...recorded, attachments: { r1: { url: "blob:r", type: "audio/wav", recordedBy: "ana" } } } as unknown as CellData
const generated = {
  ...base,
  selectedGeneratedVoiceAudioId: "a1",
  attachments: { a1: { url: "blob:x", type: "audio/wav", voiceId: "v-mary" } },
} as unknown as CellData
const empty = { ...base } as unknown as CellData

const ready = { generateReady: true }

describe("the take a line plays", () => {
  it("prefers a recording over a generated voice, and knows a person's from a voice", () => {
    const both = { ...recorded, selectedGeneratedVoiceAudioId: "a1", attachments: { ...recorded.attachments, ...generated.attachments } } as unknown as CellData
    expect(lineTake(both)).toMatchObject({ audioId: "r1", human: true, isGenerated: false })
    expect(lineTake(generated)).toMatchObject({ audioId: "a1", human: false, isGenerated: true })
    expect(lineTake(empty).audioId).toBeUndefined()
  })
})

describe("picking a voice acts on the line", () => {
  it("re-voices a recording at once when the pick is a character", () => {
    expect(lineVoiceActionFor(recorded, hearth, ready)).toBe("change")
  })

  it("reads an empty line's text in the voice picked, once it can", () => {
    expect(lineVoiceActionFor(empty, john, ready)).toBe("generate")
    expect(lineVoiceActionFor(empty, john, { generateReady: false })).toBeNull()
  })

  it("regenerates a generated take in a stock voice, but never reads over a recording", () => {
    expect(lineVoiceActionFor(generated, john, ready)).toBe("generate")
    expect(lineVoiceActionFor(recorded, john, ready)).toBeNull()
  })

  it("does nothing when the take is already in that voice", () => {
    expect(lineVoiceActionFor(generated, mary, ready)).toBeNull()
  })

  it("never re-voices a take some voice was cloned from (AQU-2037)", () => {
    expect(lineVoiceActionFor(recorded, hearth, { ...ready, takeIsReference: true })).toBeNull()
  })
})

describe("the one-click when the line's voice and its take disagree", () => {
  const go = { ...ready, canEdit: true, busy: false }

  it("offers Change to … when the cast voice can re-voice the take", () => {
    expect(lineVoicePending(settings({ "cell-1": "v-hearth" }), recorded, go)).toMatchObject({ action: "change", voice: { id: "v-hearth" } })
  })

  it("offers Generate for a stock voice cast over a recording, and nothing once the take matches", () => {
    expect(lineVoicePending(settings({ "cell-1": "v-john" }), recorded, go)).toMatchObject({ action: "generate", voice: { id: "v-john" } })
    const byJohn = { ...generated, attachments: { a1: { url: "blob:x", type: "audio/wav", voiceId: "v-john" } } } as unknown as CellData
    expect(lineVoicePending(settings({ "cell-1": "v-john" }), byJohn, go)).toBeNull()
  })

  it("offers nothing when nobody chose the line's voice, while it is being voiced, or to a reader", () => {
    expect(lineVoicePending(settings(), recorded, go)).toBeNull()
    expect(lineVoicePending(settings({ "cell-1": "v-hearth" }), recorded, { ...go, busy: true })).toBeNull()
    expect(lineVoicePending(settings({ "cell-1": "v-hearth" }), recorded, { ...go, canEdit: false })).toBeNull()
  })

  it("offers nothing on a line with no take — the pick generates it instead", () => {
    expect(lineVoicePending(settings({ "cell-1": "v-john" }), empty, go)).toBeNull()
  })
})

describe("naming a person's recording", () => {
  it("says Your recording, Recorded by …, or Original audio instead of the default voice", () => {
    expect(lineTakeLabel(recorded, "dev")).toEqual({ key: "editor.voice.yourRecording" })
    expect(lineTakeLabel(byAna, "dev")).toEqual({ key: "editor.voice.recordedBy", name: "ana" })
    expect(lineTakeLabel(byAna, "ana")).toEqual({ key: "editor.voice.yourRecording" })
    const sourceClip = {
      ...base,
      medium: "media",
      startTime: 1,
      endTime: 3,
      selectedAudioId: "audio-f1-1-src.webm",
      attachments: { "audio-f1-1-src.webm": { url: "frontier-audio://audio-f1-1-src.webm", type: "audio" } },
    } as unknown as CellData
    expect(lineTakeLabel(sourceClip, "dev")).toEqual({ key: "editor.voice.originalAudio" })
  })

  it("names nothing for a generated voice or a line with no take", () => {
    expect(lineTakeLabel(generated, "dev")).toBeNull()
    expect(lineTakeLabel(empty, "dev")).toBeNull()
  })

  it("suggests who recorded the take as a clone's name", () => {
    expect(cloneNameSuggestion(byAna, "dev")).toBe("ana")
    expect(cloneNameSuggestion(recorded, "dev")).toBe("dev")
    expect(cloneNameSuggestion(generated, "dev")).toBe("")
  })
})
