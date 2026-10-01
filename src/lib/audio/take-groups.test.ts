import { describe, expect, it } from "vitest"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { groupSelection, groupTakesByTrack, playingTakeId } from "./take-groups"

const att = (audioId: string, slot: string, over: Partial<AudioAttachmentOut> = {}): AudioAttachmentOut => ({
  audioId, url: `frontier-audio://${audioId}`, slot, mimeType: null, voiceId: null, referenceAudioId: null,
  durationMs: 1000, trimStartMs: null, trimEndMs: null, ...over,
} as AudioAttachmentOut)

const tracks = [{ id: "target-audio", name: "Target audio" }, { id: "trk-2", name: "Track 2" }]

describe("groupTakesByTrack", () => {
  it("keeps recordings and generated voices together on the default track, added tracks apart", () => {
    const groups = groupTakesByTrack({
      "audio-c1-b.wav": att("audio-c1-b.wav", "generatedVoice", { voiceId: "v1" }),
      "audio-c1-a.wav": att("audio-c1-a.wav", "recording"),
      "audio-c1-c.wav": att("audio-c1-c.wav", "trk-2"),
    }, "f1", tracks)
    expect(groups.map((g) => [g.trackId, g.name, g.takes.map((t) => t.audioId)])).toEqual([
      ["target-audio", "Target audio", ["audio-c1-a.wav", "audio-c1-b.wav"]],
      ["trk-2", "Track 2", ["audio-c1-c.wav"]],
    ])
  })

  it("leaves out the imported source clip and removed takes, and keeps a track it cannot name", () => {
    const groups = groupTakesByTrack({
      "audio-f1-src.wav": att("audio-f1-src.wav", "recording"),
      "audio-c1-gone.wav": { ...att("audio-c1-gone.wav", "recording"), isDeleted: true } as AudioAttachmentOut,
      "audio-c1-x.wav": att("audio-c1-x.wav", "trk-new"),
    }, "f1", tracks)
    expect(groups).toEqual([{ trackId: "trk-new", name: "", takes: [att("audio-c1-x.wav", "trk-new")] }])
  })
})

describe("which take plays", () => {
  const group = groupTakesByTrack({
    "audio-c1-rec.wav": att("audio-c1-rec.wav", "recording"),
    "audio-c1-gen.wav": att("audio-c1-gen.wav", "generatedVoice", { voiceId: "v1" }),
  }, "f1", tracks)[0]

  it("is the recording while one holds the recording slot", () => {
    const entry = { selectedAudioId: "audio-c1-rec.wav", selectedGeneratedVoiceAudioId: "audio-c1-gen.wav" }
    expect(playingTakeId(group, entry)).toBe("audio-c1-rec.wav")
  })

  it("is the generated voice when the recording slot is empty or holds the source clip", () => {
    expect(playingTakeId(group, { selectedAudioId: null, selectedGeneratedVoiceAudioId: "audio-c1-gen.wav" })).toBe("audio-c1-gen.wav")
    expect(playingTakeId(group, { selectedAudioId: "audio-f1-src.wav", selectedGeneratedVoiceAudioId: "audio-c1-gen.wav" })).toBe("audio-c1-gen.wav")
  })

  it("is nothing when nothing of the group is selected", () => {
    expect(playingTakeId(group, { selectedAudioId: "audio-f1-src.wav", selectedGeneratedVoiceAudioId: null })).toBeNull()
  })

  it("reads an added track's own slot", () => {
    const entry = { selectedBySlot: { "trk-2": "audio-c1-t2.wav" }, selectedAudioId: null, selectedGeneratedVoiceAudioId: null }
    expect(groupSelection(entry, "trk-2")).toBe("audio-c1-t2.wav")
    const g2 = { trackId: "trk-2", name: "Track 2", takes: [att("audio-c1-t2.wav", "trk-2")] }
    expect(playingTakeId(g2, entry)).toBe("audio-c1-t2.wav")
  })
})
