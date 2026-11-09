import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/audio/transcribe", () => ({ audioBytesToWhisperPcm: vi.fn(), readClipBytes: vi.fn(), transcribeAudio: vi.fn() }))

import type { CellData } from "@/hooks/useCells"
import { needsSplitNotice, sourceRecordingLine } from "./recording-line"

const clip = "audio-f1-1793000000000-abc.mp3"
const line = (att: Record<string, unknown>, extra: Partial<CellData> = {}): CellData => ({
  id: "c1", fileId: "f1", medium: "media", selectedAudioId: clip, startTime: 0, endTime: 3134,
  attachments: { [clip]: { type: "audio", url: "frontier-audio://p/f1/f1-clip.mp3", ...att } },
  ...extra,
} as unknown as CellData)

describe("sourceRecordingLine (AQU-2426)", () => {
  it("a whole 52-minute recording still one line gets the notice", () => {
    const l = sourceRecordingLine(line({ durationMs: 3_134_000 }))
    expect(l).toMatchObject({ lo: 0, hi: 3_134_000, whole: true, readable: true })
    expect(needsSplitNotice(l)).toBe(true)
  })

  it("under a minute there is no notice, but it is still a source line", () => {
    const l = sourceRecordingLine(line({ durationMs: 40_000 }, { endTime: 40 }))
    expect(l?.whole).toBe(true)
    expect(needsSplitNotice(l)).toBe(false)
  })

  it("a piece of a split recording is a source line, not whole", () => {
    const l = sourceRecordingLine(line({ durationMs: 3_134_000, trimStartMs: 60_000, trimEndMs: 190_000 }))
    expect(l).toMatchObject({ lo: 60_000, hi: 190_000, whole: false })
    expect(needsSplitNotice(l)).toBe(false)
  })

  it("a take is never a source line", () => {
    const take = "audio-c1-1793000000001-def"
    expect(sourceRecordingLine(line({}, { selectedAudioId: take, attachments: { [take]: { type: "audio", url: "frontier-audio://p/f1/c1-take.webm" } } as never }))).toBeNull()
  })

  it("a streamed recording can't be read, so it gets no notice", () => {
    const l = sourceRecordingLine(line({ url: "https://cdn.example.com/sermon.mp3", durationMs: 3_134_000 }))
    expect(l?.readable).toBe(false)
    expect(needsSplitNotice(l)).toBe(false)
  })
})
