// AQU-1758: a take's voice, when it is not the line's — what its clip names.
import { describe, expect, it } from "vitest"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { takeVoiceNote } from "./take-voice"

const SETTINGS: ProjectTtsSettings = {
  provider: "gemini",
  defaultVoiceId: "v-narrator",
  voices: [
    { id: "v-narrator", name: "Narrator", color: "#475569", provider: "gemini", voiceName: "Charon" },
    { id: "v-naomi", name: "Naomi", color: "#0d9488", provider: "gemini", voiceName: "Kore" },
  ],
  castAssignments: { "c-naomi": "v-naomi" },
} as ProjectTtsSettings

const GEN = "audio-c-1700000900-gen.wav"
const REC = "audio-c-1700000000-take.wav"
const line = (id: string, voiceId?: string): CellData =>
  ({
    id, fileId: "f1", original: "", translated: "",
    attachments: {
      [GEN]: { type: "audio", url: "frontier-audio://gen", slot: "generatedVoice", ...(voiceId ? { voiceId } : {}) },
      [REC]: { type: "audio", url: "frontier-audio://rec", slot: "recording" },
    },
  }) as unknown as CellData

describe("what a take's clip says about its voice", () => {
  it("names the take's voice when the line is cast to another", () => {
    expect(takeVoiceNote(line("c-naomi", "v-narrator"), GEN, SETTINGS)).toEqual({
      takeVoiceName: "Narrator", lineVoiceName: "Naomi",
    })
  })

  it("says nothing when the take is in the line's own voice", () => {
    expect(takeVoiceNote(line("c-naomi", "v-naomi"), GEN, SETTINGS)).toBeNull()
    // An uncast line speaks with the default voice.
    expect(takeVoiceNote(line("c-plain", "v-narrator"), GEN, SETTINGS)).toBeNull()
  })

  it("says the take's voice is gone when it was removed from the project", () => {
    expect(takeVoiceNote(line("c-naomi", "v-deleted"), GEN, SETTINGS)).toEqual({
      takeVoiceName: null, lineVoiceName: "Naomi",
    })
  })

  it("says nothing for a recording, or a take from before takes carried their voice", () => {
    expect(takeVoiceNote(line("c-naomi", "v-narrator"), REC, SETTINGS)).toBeNull()
    expect(takeVoiceNote(line("c-naomi"), GEN, SETTINGS)).toBeNull()
  })
})
