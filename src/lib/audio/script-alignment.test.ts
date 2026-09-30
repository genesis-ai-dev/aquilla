import { describe, expect, it } from "vitest"
import { alignScriptParagraphs, scriptAlignmentCues } from "./script-alignment"
import { collectSourceAlignmentWords } from "./source-alignment"
import { alignChunks } from "./timings"
import type { CellData } from "@/hooks/useCells"

describe("alignScriptParagraphs", () => {
  it("keeps acoustic confidence distinct from word-match coverage", () => {
    const cues = scriptAlignmentCues({ method: "ctc-forced-alignment",
      segments: [{ text: "Known words.", start: 1, end: 2,
        confidence: 0.8, matchedWords: 2, totalWords: 2,
        needsReview: true, status: "partial" }],
    })
    expect(cues[0].metadata).toMatchObject({
      alignmentMethod: "ctc-forced-alignment",
      alignmentConfidenceBasis: "acoustic-score", alignmentConfidence: 0.8,
    })
  })
  it("reuses source word timings with trim offsets even when a dub is selected", () => {
    const sourceId = "audio-file-9-1700000000-src1.mp3"
    const takeId = "audio-sec-1-1700000001-tk1.webm"
    const url = "frontier-audio://source.mp3"
    const timings = alignChunks([
      { text: "Hello", start: 0.1, end: 0.5 },
      { text: "world", start: 0.6, end: 1 },
    ], "Hello world.")
    const cell = {
      id: "sec-1", fileId: "file-9", medium: "media", startTime: 100,
      original: "Hello world.", translated: "", context: "", group: "",
      type: "text", status: "unvalidated", validationStatus: "none",
      activeValidators: [], validationHistory: [], history: [], threads: [],
      selectedAudioId: takeId,
      attachments: {
        [sourceId]: { type: "audio", url, trimStartMs: 5000, trimEndMs: 7000 },
        [takeId]: { type: "audio", url: "frontier-audio://dub.webm" },
      },
      audioTimings: { [sourceId]: timings, [takeId]: [
        { word: "Wrong", start: 0, end: 5, t0: 0, t1: 1 },
      ] },
    } as CellData
    const words = collectSourceAlignmentWords([cell, cell], url)
    expect(words).toEqual([
      { text: "Hello", start: 5.1, end: 5.5 },
      { text: "world.", start: 5.6, end: 6 },
    ])
    expect(alignScriptParagraphs("Hello world.", words).segments[0])
      .toMatchObject({ start: 5.1, end: 6, confidence: 1 })
    expect(collectSourceAlignmentWords([cell], "frontier-audio://other.mp3"))
      .toEqual([])
  })
  it("retains supplied text, timing and confidence through import normalization", async () => {
    const { buildBulkCellsWithSpeakers } = await import("../import")
    const cues = scriptAlignmentCues(alignScriptParagraphs("Hello world.", [
      { text: "Hello", start: 1.123, end: 1.4 },
      { text: "world", start: 1.5, end: 2.456 },
    ]))
    const { cells } = buildBulkCellsWithSpeakers(cues, {
      fileName: "script.txt", fileType: "vtt",
      profileId: "builtin:script-alignment", profileVersion: "1",
    })
    expect(cells).toHaveLength(1)
    expect(cells[0]).toMatchObject({
      cellId: cues[0].id, value: "Hello world.",
      startMs: 1123, endMs: 2456,
      metadata: { alignmentConfidence: 1, alignmentStatus: "matched",
        alignmentMethod: "whisper-word-match" },
    })
  })
  it("prepares cue preview values without inventing unmatched timings", () => {
    const result = alignScriptParagraphs("Hello missing world.\n\nUnspoken.", [
      { text: "Hello", start: 1, end: 1.4 },
      { text: "world", start: 1.5, end: 2 },
    ])
    const cues = scriptAlignmentCues(result)
    expect(cues).toMatchObject([
      { original: "Hello missing world.", type: "cue", start: 1, end: 2,
        metadata: { alignmentConfidence: 2 / 3, alignmentStatus: "partial",
          alignmentNeedsReview: true, alignmentMethod: "whisper-word-match" } },
      { original: "Unspoken.", type: "cue",
        metadata: { alignmentConfidence: 0, alignmentStatus: "unmatched",
          alignmentNeedsReview: true } },
    ])
    expect(cues[1].start).toBeUndefined()
    expect(cues[1].end).toBeUndefined()
    expect(new Set(cues.map(cue => cue.id)).size).toBe(2)
  })
  it("preserves paragraph wording while matching punctuation and Unicode", () => {
    const result = alignScriptParagraphs("Don’t STOP!\r\nstill here.\r\n\r\nÉlan.", [
      { text: "don't", start: 0, end: 0.5 },
      { text: "stop", start: 0.6, end: 1 },
      { text: "still", start: 1.1, end: 1.5 },
      { text: "here", start: 1.6, end: 2 },
      { text: "E\u0301lan", start: 3, end: 4 },
    ])
    expect(result.segments).toMatchObject([
      { text: "Don’t STOP!\r\nstill here.", start: 0, end: 2,
        confidence: 1, needsReview: false },
      { text: "Élan.", start: 3, end: 4, confidence: 1, needsReview: false },
    ])
    expect(alignScriptParagraphs(" \n\n ", []).segments).toEqual([])
  })
  it("bounds matching work before allocating the alignment matrix", () => {
    const script = "word ".repeat(2000)
    const chunks = Array.from({ length: 2000 }, (_, i) => ({
      text: "word", start: i, end: i + 0.5,
    }))
    expect(() => alignScriptParagraphs(script, chunks))
      .toThrow("acoustic alignment or shorter sections")
  })
  it("rejects invalid or unordered word timings before alignment", () => {
    for (const chunks of [
      [{ text: "Hello", start: -1, end: 1 }],
      [{ text: "Hello", start: 1, end: 1 }],
      [{ text: "Hello", start: 1, end: NaN }],
      [{ text: "Hello", start: 2, end: 3 },
        { text: "world", start: 1, end: 2 }],
    ]) {
      expect(() => alignScriptParagraphs("Hello world.", chunks))
        .toThrow("Invalid word timings")
    }
  })
  it("requires review when repeated speech permits several timing matches", () => {
    const result = alignScriptParagraphs("Go home.", [
      { text: "Go", start: 0, end: 0.4 },
      { text: "home", start: 0.5, end: 1 },
      { text: "Go", start: 4, end: 4.4 },
      { text: "home", start: 4.5, end: 5 },
    ])
    expect(result.segments[0]).toMatchObject({
      text: "Go home.", start: 0, end: 1, confidence: 1,
      needsReview: true, status: "ambiguous",
    })
  })
  it("keeps unmatched paragraphs untimed and skips extra speech", () => {
    const result = alignScriptParagraphs(
      "Hello missing world.\n\nUnspoken script.\n\nNext paragraph.",
      [
        { text: "um", start: 0, end: 0.4 },
        { text: "Hello", start: 1, end: 1.3 },
        { text: "world", start: 1.4, end: 2 },
        { text: "Next", start: 4, end: 4.5 },
        { text: "paragraph", start: 4.6, end: 5 },
      ],
    )
    expect(result.segments).toMatchObject([
      { text: "Hello missing world.", start: 1, end: 2,
        confidence: 2 / 3, matchedWords: 2, needsReview: true, status: "partial" },
      { text: "Unspoken script.", start: null, end: null,
        confidence: 0, matchedWords: 0, needsReview: true, status: "unmatched" },
      { text: "Next paragraph.", start: 4, end: 5,
        confidence: 1, matchedWords: 2, needsReview: false, status: "matched" },
    ])
  })
  it("aligns whisper chunks to script paragraphs", () => {
    const script = "Hello world.\n\nNext paragraph."
    const chunks = [
      { text: "Hello", start: 1, end: 1.3 },
      { text: "world", start: 1.4, end: 2 },
      { text: "Next", start: 4, end: 4.5 },
      { text: "paragraph", start: 4.6, end: 5 },
    ]
    const result = alignScriptParagraphs(script, chunks)
    expect(result.segments).toHaveLength(2)
    expect(result.segments[0]).toMatchObject({
      text: "Hello world.",
      start: 1,
      end: 2,
      confidence: 1,
      matchedWords: 2,
      totalWords: 2,
      needsReview: false,
    })
    expect(result.segments[1]).toMatchObject({
      text: "Next paragraph.",
      start: 4,
      end: 5,
      confidence: 1,
      matchedWords: 2,
      totalWords: 2,
      needsReview: false,
    })
  })
})
