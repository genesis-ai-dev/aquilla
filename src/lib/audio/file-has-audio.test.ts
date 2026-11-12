// AQU-1495: one answer to "does this file have audio?" for the selection bar
// and the editor gutter, and what the gutter's audio column shows while the
// answer is still being read.
import { beforeEach, describe, expect, it } from "vitest"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"
import type { LinkedTake } from "@/lib/audio/linked-takes"
import type { CellData } from "@/hooks/useCells"
import {
  __resetFileAudioMemoryForTests, audioColumnFor, fileHasAudio, fileLastSeenWithAudio, rememberFileAudio,
} from "./file-has-audio"

const take = (audioId: string, extra: Record<string, unknown> = {}) => ({
  audioId, url: `frontier-audio://${audioId}.webm`, slot: "recording", mimeType: "audio/webm", voiceId: null,
  referenceAudioId: null, durationMs: 1000, label: null, trimStartMs: null, trimEndMs: null,
  role: "dub" as const, validatorCount: 0, validators: [], recordedBy: "tester", ...extra,
})

function entry(takes: ReturnType<typeof take>[], selected: string | null = takes[0]?.audioId ?? null): CellAudioEntry {
  return {
    attachments: Object.fromEntries(takes.map((t) => [t.audioId, t])),
    selectedBySlot: selected ? { recording: selected } : {},
    selectedAudioId: selected,
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  } as unknown as CellAudioEntry
}

const heard = (hasTake: boolean): LinkedTake => ({
  cell: { id: "cue-1", fileId: "cue-file" } as CellData,
  sharedWith: 1, hasTake, performs: ["cell-1"], partOfSplit: false,
})

describe("fileHasAudio", () => {
  it("is false with nothing read", () => {
    expect(fileHasAudio(null, null)).toBe(false)
    expect(fileHasAudio(new Map(), new Map())).toBe(false)
  })

  it("is true for a selected take on one of the file's lines", () => {
    expect(fileHasAudio(new Map([["cell-1", entry([take("t1")])]]), null)).toBe(true)
  })

  it("is false for a line whose takes are all unselected", () => {
    expect(fileHasAudio(new Map([["cell-1", entry([take("t1")], null)]]), null)).toBe(false)
  })

  // The imported programme audio is not a recording anyone validates.
  it("does not count the imported source clip", () => {
    expect(fileHasAudio(new Map([["cell-1", entry([take("src", { role: "source" })])]]), null)).toBe(false)
  })

  it("counts a take on a heard line performing the file's lines", () => {
    expect(fileHasAudio(new Map(), new Map([["cell-1", [heard(true)]]]))).toBe(true)
  })

  it("does not count a heard line nobody has recorded", () => {
    expect(fileHasAudio(new Map(), new Map([["cell-1", [heard(false)]]]))).toBe(false)
  })
})

describe("audioColumnFor", () => {
  it("once everything is read, shows the column exactly when the file has audio", () => {
    expect(audioColumnFor({ hasAudio: true, checking: false, expectAudio: false })).toBe("on")
    expect(audioColumnFor({ hasAudio: false, checking: false, expectAudio: true })).toBe("off")
  })

  it("while reading, holds the placeholder where audio is seen or expected", () => {
    expect(audioColumnFor({ hasAudio: true, checking: true, expectAudio: false })).toBe("checking")
    expect(audioColumnFor({ hasAudio: false, checking: true, expectAudio: true })).toBe("checking")
  })

  it("while reading, draws nothing on a file not expected to have audio", () => {
    expect(audioColumnFor({ hasAudio: false, checking: true, expectAudio: false })).toBe("off")
  })
})

describe("the session memory of which files had audio", () => {
  beforeEach(() => __resetFileAudioMemoryForTests())

  it("expects audio only of a file last seen with some", () => {
    expect(fileLastSeenWithAudio("p/f")).toBe(false)
    rememberFileAudio("p/f", true)
    expect(fileLastSeenWithAudio("p/f")).toBe(true)
    expect(fileLastSeenWithAudio("p/other")).toBe(false)
    rememberFileAudio("p/f", false)
    expect(fileLastSeenWithAudio("p/f")).toBe(false)
  })
})
