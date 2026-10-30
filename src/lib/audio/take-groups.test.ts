import { describe, expect, it } from "vitest"
import type { AudioAttachmentOut } from "@/lib/sync/cell-audio-read-types"
import { groupSelection, groupTakesByTrack, listedTakeCount, originalRecordingId, pieceNames, piecesOf, playingTakeId, takeBaseLabel, takeRows } from "./take-groups"

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

// AQU-1767 (Sam, 2026-10-14): a split take is one take made of pieces.
describe("takeRows / piecesOf", () => {
  const takes = [
    att("t2", "recording", { label: "Take 2" }),
    att("p1b", "recording", { pieceOf: "t1", trimStartMs: 1500, label: "Take 1 · 2" }),
    att("t1", "recording", { trimEndMs: 1500, label: "Take 1 · 1" }),
    { ...att("p1c", "recording", { pieceOf: "t1", trimStartMs: 3000 }), isDeleted: true } as AudioAttachmentOut,
  ]

  it("lists each split take once, its live pieces in clip order", () => {
    expect(takeRows(takes).map((r) => [r.group, r.pieces.map((p) => p.audioId)])).toEqual([
      ["t2", ["t2"]],
      ["t1", ["t1", "p1b"]],
    ])
  })

  it("answers any piece with its whole take, and a take never split with itself", () => {
    expect(piecesOf(takes, "p1b").map((p) => p.audioId)).toEqual(["t1", "p1b"])
    expect(piecesOf(takes, "t1").map((p) => p.audioId)).toEqual(["t1", "p1b"])
    expect(piecesOf(takes, "t2").map((p) => p.audioId)).toEqual(["t2"])
    expect(piecesOf(takes, "nope")).toEqual([])
  })

  it("names a split take by its pieces' shared name", () => {
    expect(takeBaseLabel("Take 1 · 2")).toBe("Take 1")
    expect(takeBaseLabel("Hero line")).toBe("Hero line")
    expect(takeBaseLabel(null)).toBeNull()
  })
})

// AQU-1767 (Sam, 2026-10-15): piece numbers are worked out, not stored.
describe("pieceNames", () => {
  const att = (audioId: string, over: Record<string, unknown>) => ({ audioId, url: "", slot: "recording", ...over }) as unknown as AudioAttachmentOut
  it("numbers a split take's pieces by where they sit, whatever each stored", () => {
    const names = pieceNames([
      att("a", { label: "Take 2 · 9" }),
      att("c", { label: "Take 2 · 2", pieceOf: "a", trimStartMs: 3000 }),
      att("b", { label: "Take 2 · 3", pieceOf: "a", trimStartMs: 2000 }),
      att("x", { label: "Take 1" }),
    ])
    expect(names.get("a")).toBe("Take 2 · 1")
    expect(names.get("b")).toBe("Take 2 · 2")
    expect(names.get("c")).toBe("Take 2 · 3")
    expect(names.get("x")).toBe("Take 1")
  })
  it("renumbers at once when a piece goes", () => {
    const names = pieceNames([
      att("a", { label: "Take 2 · 1" }),
      att("b", { label: "Take 2 · 2", pieceOf: "a", trimStartMs: 2000, isDeleted: true }),
      att("c", { label: "Take 2 · 3", pieceOf: "a", trimStartMs: 3000 }),
    ])
    expect(names.get("c")).toBe("Take 2 · 2")
  })
})

describe("originalRecordingId", () => {
  it("traces a piece to the take it was cut from, and a cleaned copy to what it was cleaned from", () => {
    const takes = {
      "audio-c1-1.wav": {},
      "audio-c1-2.wav": { pieceOf: "audio-c1-1.wav" },
      "dn-audio-c1-1.wav": { referenceAudioId: "audio-c1-1.wav" },
      "dn-audio-c1-9.wav": { pieceOf: "dn-audio-c1-1.wav", referenceAudioId: "audio-c1-2.wav" },
    }
    expect(originalRecordingId(takes, "audio-c1-2.wav")).toBe("audio-c1-1.wav")
    expect(originalRecordingId(takes, "dn-audio-c1-9.wav")).toBe("audio-c1-1.wav")
    expect(originalRecordingId(takes, "dn-audio-c1-1.wav")).toBe("audio-c1-1.wav")
  })
  it("stops at a cleaned copy whose original is gone", () => {
    expect(originalRecordingId({ "dn-audio-c1-1.wav": { referenceAudioId: "audio-c1-1.wav" } }, "dn-audio-c1-1.wav")).toBe("dn-audio-c1-1.wav")
  })
})

// AQU-981 (Sam, Oct 29): a take split into pieces is one take. The recorder's
// "Takes 5" counted a split take once per piece, while its list showed 4.
describe("listedTakeCount", () => {
  it("counts takes as the list shows them: a split take once, on every track", () => {
    const groups = groupTakesByTrack({
      "audio-c1-1.wav": att("audio-c1-1.wav", "recording", { label: "Take 1" }),
      "audio-c1-2.wav": att("audio-c1-2.wav", "recording", { label: "Take 2 · 1", trimEndMs: 400 }),
      "audio-c1-3.wav": att("audio-c1-3.wav", "recording", { label: "Take 2 · 2", trimStartMs: 400, pieceOf: "audio-c1-2.wav" }),
      "audio-c1-4.wav": att("audio-c1-4.wav", "recording", { label: "Take 3" }),
      "audio-c1-5.wav": att("audio-c1-5.wav", "trk-2", { label: "Take 1" }),
    }, "f1", tracks)
    expect(listedTakeCount(groups)).toBe(4)
  })
})
