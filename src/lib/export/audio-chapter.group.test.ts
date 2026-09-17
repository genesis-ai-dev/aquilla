import { describe, it, expect } from "vitest"
import {
  chapterFileName,
  groupAudioByChapter,
  previewAudioByChapter,
} from "./audio-chapter"
import type { CellData } from "@/hooks/useCells"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "verse", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const withTake = (id: string, ref: string, extra: Partial<CellData> = {}): CellData =>
  cell({
    id,
    group: ref,
    selectedAudioId: `a-${id}`,
    attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.wav`, type: "audio/wav" } },
    ...extra,
  })

describe("groupAudioByChapter", () => {
  it("buckets verses by chapter and sorts each chapter in verse order", () => {
    const groups = groupAudioByChapter([
      withTake("v3", "MAT 1:3"),
      withTake("v1", "MAT 1:1"),
      withTake("v2", "MAT 1:2"),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe("MAT 1")
    expect(groups[0]!.clips.map((c) => c.cellId)).toEqual(["v1", "v2", "v3"])
  })

  it("keeps chapters apart and orders them numerically", () => {
    const groups = groupAudioByChapter([
      withTake("c2v1", "JHN 2:1"),
      withTake("c1v2", "JHN 1:2"),
      withTake("c1v1", "JHN 1:1"),
    ])
    expect(groups.map((g) => g.key)).toEqual(["JHN 1", "JHN 2"])
    expect(groups[0]!.clips.map((c) => c.cellId)).toEqual(["c1v1", "c1v2"])
    expect(groups[1]!.clips.map((c) => c.cellId)).toEqual(["c2v1"])
  })

  it("skips verses with nothing recorded rather than inventing a gap", () => {
    const groups = groupAudioByChapter([
      withTake("v1", "MAT 1:1"),
      cell({ id: "v2", group: "MAT 1:2" }),
      withTake("v3", "MAT 1:3"),
    ])
    expect(groups[0]!.clips.map((c) => c.cellId)).toEqual(["v1", "v3"])
  })

  it("sorts a verse range with its first number (1-2 before 3)", () => {
    const groups = groupAudioByChapter([
      withTake("v3", "LUK 1:3"),
      withTake("v12", "LUK 1:1-2"),
    ])
    expect(groups[0]!.clips.map((c) => c.cellId)).toEqual(["v12", "v3"])
  })

  it("collects cells without a canonical ref into one file-shaped group", () => {
    const groups = groupAudioByChapter([
      withTake("a", "", { group: "", startTime: 20 }),
      withTake("b", "", { group: "", startTime: 5 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.key).toBe("__file__")
    // Document order, not startTime — this export is verse/document concat,
    // not a mix timeline. The two cells arrived as a then b.
    expect(groups[0]!.clips.map((c) => c.cellId)).toEqual(["a", "b"])
  })

  it("does not change by-character grouping of the same cells", () => {
    // Sanity that we only read the recording slot the other exports use, so a
    // cell with both a recording and a generated voice still prefers the take.
    const recorded = cell({
      id: "v1",
      group: "MAT 1:1",
      selectedAudioId: "take",
      selectedGeneratedVoiceAudioId: "gen",
      attachments: {
        take: { url: "frontier-audio://take.wav", type: "audio/wav" },
        gen: { url: "frontier-audio://gen.wav", type: "audio/wav" },
      },
    })
    expect(groupAudioByChapter([recorded])[0]!.clips[0]!.audioId).toBe("take")
  })
})

describe("previewAudioByChapter", () => {
  it("counts recorded verses and still-missing verses", () => {
    const preview = previewAudioByChapter([
      withTake("v1", "MAT 1:1"),
      cell({ id: "v2", group: "MAT 1:2" }),
      withTake("v3", "MAT 2:1"),
    ])
    expect(preview).toEqual({ chapterCount: 2, clipCount: 2, missingCount: 1 })
  })
})

describe("chapterFileName", () => {
  it("names a scripture chapter MAT_1.wav", () => {
    const [group] = groupAudioByChapter([withTake("v1", "MAT 1:1")])
    expect(chapterFileName(group!)).toBe("MAT_1.wav")
  })

  it("names a file with no refs stitched.wav", () => {
    const [group] = groupAudioByChapter([withTake("a", "")])
    expect(chapterFileName(group!)).toBe("stitched.wav")
  })
})
