import { describe, expect, it, vi, beforeEach } from "vitest"

// WHY mock the emitter: this module's contract is the SHAPE of the events it
// appends to an existing file — one genesis source cell per timed cue, every
// one carrying the same track tag and its own timecode. Asserting on the emit
// payloads is the only way to see that a second VTT lands beside the first
// instead of over it.
type EmitInput = Record<string, unknown>
const emitSourceCellCreate = vi.fn(async (_input: EmitInput) => "evt")
vi.mock("@/lib/sync/events-emit", () => ({
  emitSourceCellCreate: (input: EmitInput) => emitSourceCellCreate(input),
}))
const emitted = (): EmitInput[] => emitSourceCellCreate.mock.calls.map(([input]) => input)

const { importTrackToTimeline, parseTrackCues } = await import("./import-vtt-track")
const { readTrackRef } = await import("./tracks")

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.500
<v Mary>He is risen.

00:00:04.000 --> 00:00:06.000
Truly he is.
`

const SRT = `1
00:00:02,000 --> 00:00:05,000
Peace be with you.
`

/** happy-dom's File has no usable text() in this setup — stub the one bit used. */
const fileOf = (name: string, content: string) =>
  ({ name, text: async () => content }) as unknown as File

beforeEach(() => emitSourceCellCreate.mockClear())

describe("parseTrackCues", () => {
  it("keeps timed cues with their timecodes in ms, voice tag stripped", () => {
    expect(parseTrackCues(VTT, "audio.vtt")).toEqual([
      { text: "He is risen.", startMs: 1000, endMs: 3500, speaker: "Mary" },
      { text: "Truly he is.", startMs: 4000, endMs: 6000 },
    ])
  })

  it("parses SRT by extension", () => {
    expect(parseTrackCues(SRT, "audio.srt")).toEqual([
      { text: "Peace be with you.", startMs: 2000, endMs: 5000 },
    ])
  })

  it("throws rather than importing an empty track when nothing is timed", () => {
    expect(() => parseTrackCues("WEBVTT\n\nNOTE just a comment\n", "empty.vtt")).toThrow(/no timed cues/)
  })
})

describe("importTrackToTimeline", () => {
  const ctx = { projectId: "p1", fileId: "f1", author: "tester" }

  it("appends one tagged, timed source cell per cue", async () => {
    const result = await importTrackToTimeline(fileOf("ep1-audio.vtt", VTT), ctx, { kind: "audio" })

    expect(result.cues).toBe(2)
    expect(result.track.kind).toBe("audio")
    expect(result.track.label).toBe("ep1-audio.vtt")
    expect(emitSourceCellCreate).toHaveBeenCalledTimes(2)

    const [first, second] = emitted()
    expect(first).toMatchObject({
      projectId: "p1",
      fileId: "f1",
      author: "tester",
      value: "He is risen.",
      type: "cue",
      startMs: 1000,
      endMs: 3500,
    })
    // Every cue carries the SAME track, so they derive as one lane.
    expect(readTrackRef(first as { metadata?: EmitInput })).toEqual(result.track)
    expect(readTrackRef(second as { metadata?: EmitInput })).toEqual(result.track)
    // The voice tag rides along on the cue it labelled.
    expect((first.metadata as EmitInput).speaker).toBe("Mary")
    expect((second.metadata as EmitInput).speaker).toBeUndefined()
  })

  it("never emits a medium — track cues are text cells, not media", async () => {
    await importTrackToTimeline(fileOf("a.vtt", VTT), ctx, { kind: "audio" })
    for (const input of emitted()) {
      expect(input.medium).toBeUndefined()
    }
  })

  it("chains the cues onto the file's existing tail and appends their sequence", async () => {
    await importTrackToTimeline(fileOf("a.vtt", VTT), { ...ctx, anchorCellId: "tail", maxSequenceIndex: 41 }, {
      kind: "subtitle",
    })
    const calls = emitted()
    expect(calls[0].anchorCellId).toBe("tail")
    expect(calls[1].anchorCellId).toBe(calls[0].cellId)
    expect(calls.map((c) => c.sequenceIndex)).toEqual([42, 43])
  })

  it("starts a fresh chain at sequence 0 when the file is empty", async () => {
    await importTrackToTimeline(fileOf("a.vtt", VTT), ctx, { kind: "subtitle" })
    const calls = emitted()
    expect(calls[0].anchorCellId).toBeNull()
    expect(calls.map((c) => c.sequenceIndex)).toEqual([1, 2])
  })

  it("mints a distinct track per import so two VTTs never merge", async () => {
    const a = await importTrackToTimeline(fileOf("subs.vtt", VTT), ctx, { kind: "subtitle" })
    const b = await importTrackToTimeline(fileOf("audio.vtt", VTT), ctx, { kind: "audio" })
    expect(a.track.id).not.toBe(b.track.id)
  })

  it("emits nothing when the file has no timed cues", async () => {
    await expect(
      importTrackToTimeline(fileOf("empty.vtt", "WEBVTT\n"), ctx, { kind: "audio" }),
    ).rejects.toThrow(/no timed cues/)
    expect(emitSourceCellCreate).not.toHaveBeenCalled()
  })

  it("uses an explicit label over the filename", async () => {
    const r = await importTrackToTimeline(fileOf("a.vtt", VTT), ctx, { kind: "audio", label: "Dub pass" })
    expect(r.track.label).toBe("Dub pass")
  })
})
