import { describe, it, expect } from "vitest"
import {
  fileProgressView,
  fileSummariesToProgress,
  hasAudioProgress,
  isAudioOnlyProgress,
  mergeFileProgress,
  withAudioProgress,
} from "./file-summary-progress"
import type { FileSummary } from "@/lib/sync/cells-read-types"

function makeSummary(overrides: Partial<FileSummary> = {}): FileSummary {
  return {
    fileId: "file-1",
    projectId: "project-1",
    name: "Genesis",
    fileType: "usfm",
    declaredSourceLanguage: "en",
    declaredTargetLanguage: "fr",
    cellCount: 10,
    approvedCount: 3,
    filledCount: 7,
    wordCount: 100,
    lastEditAt: null,
    ...overrides,
  }
}

describe("fileSummariesToProgress", () => {
  // WHY: the sidebar bars (FileRow) read translated/validated/total off this
  // map. If the field mapping drifts from the server's naming (filledCount →
  // translated, approvedCount → validated), every closed file in the sidebar
  // would silently show the wrong bar lengths — a regression a naive
  // "map exists" test wouldn't catch.
  it("maps filledCount/approvedCount/cellCount to translated/validated/total", () => {
    const summaries = [
      makeSummary({ fileId: "gen", cellCount: 10, filledCount: 7, approvedCount: 3 }),
      makeSummary({ fileId: "exo", cellCount: 20, filledCount: 20, approvedCount: 0 }),
    ]
    const map = fileSummariesToProgress(summaries)
    expect(map.get("gen")).toEqual({ translated: 7, validated: 3, total: 10 })
    expect(map.get("exo")).toEqual({ translated: 20, validated: 0, total: 20 })
    expect(map.size).toBe(2)
  })

  it("returns an empty map for no files", () => {
    expect(fileSummariesToProgress([]).size).toBe(0)
  })

  // WHY (AQU-2111): an audio-only file reads 0 filled / 0 approved forever —
  // its work lives entirely on the audio pair. If that pair is not carried
  // across, every such file's sidebar row reads 0% however much is recorded
  // and validated.
  it("carries the audio pair through as recorded/audioValidated", () => {
    const map = fileSummariesToProgress([
      makeSummary({ fileId: "gen", cellCount: 20, filledCount: 0, approvedCount: 0, audioCount: 10, audioValidatedCount: 9 }),
    ])
    expect(map.get("gen")).toEqual({
      translated: 0, validated: 0, total: 20, recorded: 10, audioValidated: 9,
    })
    expect(isAudioOnlyProgress(map.get("gen"))).toBe(true)
  })

  // WHY: a sync-worker from before AQU-2111 sends neither field, and an absent
  // pair must read as "unknown" rather than "nothing recorded" — a fabricated
  // 0 would make every row claim "0% recorded" on a project with no audio at
  // all, and would be indistinguishable from a real zero.
  it("leaves the audio pair absent when the server did not send it", () => {
    const stats = fileSummariesToProgress([makeSummary({ fileId: "gen" })]).get("gen")!
    expect("recorded" in stats).toBe(false)
    expect("audioValidated" in stats).toBe(false)
    expect(hasAudioProgress(stats)).toBe(false)
    expect(isAudioOnlyProgress(stats)).toBe(false)
  })

  // WHY: a text-only project must look exactly as it did — no audio bar, and
  // no "0% recorded" beside it.
  it("treats a real zero as no audio to draw", () => {
    const stats = fileSummariesToProgress([
      makeSummary({ fileId: "gen", audioCount: 0, audioValidatedCount: 0 }),
    ]).get("gen")!
    expect(stats.recorded).toBe(0)
    expect(hasAudioProgress(stats)).toBe(false)
    expect(isAudioOnlyProgress(stats)).toBe(false)
  })

  // WHY: a file with both media keeps its text figures and gains the audio
  // ones — the display rule AQU-2110 settled.
  it("reports a file with text and takes as not audio-only", () => {
    const stats = fileSummariesToProgress([
      makeSummary({ fileId: "gen", filledCount: 7, audioCount: 5, audioValidatedCount: 2 }),
    ]).get("gen")!
    expect(hasAudioProgress(stats)).toBe(true)
    expect(isAudioOnlyProgress(stats)).toBe(false)
  })
})

describe("mergeFileProgress", () => {
  // WHY: this is the crux of AQU-516's fix — the sidebar must show EVERY
  // file (server snapshot) without regressing the open file's live,
  // per-keystroke accuracy (useHealth's decay-derived stats). If live lost
  // to the snapshot, editing a cell would no longer move the open file's
  // bars until the next server round-trip.
  it("keeps every base entry not present in live", () => {
    const base = new Map([
      ["gen", { translated: 7, validated: 3, total: 10 }],
      ["exo", { translated: 20, validated: 0, total: 20 }],
    ])
    const live = new Map<string, { translated: number; validated: number; total: number }>()
    const merged = mergeFileProgress(base, live)
    expect(merged.get("gen")).toEqual({ translated: 7, validated: 3, total: 10 })
    expect(merged.get("exo")).toEqual({ translated: 20, validated: 0, total: 20 })
    expect(merged.size).toBe(2)
  })

  it("prefers the live entry over the base (server snapshot) entry for the same file", () => {
    const base = new Map([["gen", { translated: 7, validated: 3, total: 10 }]])
    // Simulates the open file having just been edited client-side, ahead of
    // the next server snapshot fetch.
    const live = new Map([["gen", { translated: 9, validated: 3, total: 10 }]])
    const merged = mergeFileProgress(base, live)
    expect(merged.get("gen")).toEqual({ translated: 9, validated: 3, total: 10 })
  })

  // WHY (AQU-2111): the live entry is derived from cells, and the attachment
  // map it would need for audio is fetched separately and lands after them.
  // A blanket overwrite blanked an audio-only file's bar the moment it was
  // opened — the server snapshot is the only thing that knows those figures
  // until the map arrives.
  it("keeps the snapshot's audio pair when the live entry has none yet", () => {
    const base = new Map([["gen", { translated: 0, validated: 0, total: 20, recorded: 10, audioValidated: 9 }]])
    const live = new Map([["gen", { translated: 0, validated: 0, total: 20 }]])
    expect(mergeFileProgress(base, live).get("gen")).toEqual({
      translated: 0, validated: 0, total: 20, recorded: 10, audioValidated: 9,
    })
  })

  it("prefers the live audio pair once it has one", () => {
    const base = new Map([["gen", { translated: 0, validated: 0, total: 20, recorded: 10, audioValidated: 9 }]])
    const live = new Map([["gen", { translated: 0, validated: 0, total: 20, recorded: 11, audioValidated: 10 }]])
    expect(mergeFileProgress(base, live).get("gen")).toEqual({
      translated: 0, validated: 0, total: 20, recorded: 11, audioValidated: 10,
    })
  })

  it("adds live-only entries (e.g. a brand-new file not yet in the server snapshot)", () => {
    const base = new Map([["gen", { translated: 7, validated: 3, total: 10 }]])
    const live = new Map([["new-file", { translated: 1, validated: 0, total: 5 }]])
    const merged = mergeFileProgress(base, live)
    expect(merged.size).toBe(2)
    expect(merged.get("new-file")).toEqual({ translated: 1, validated: 0, total: 5 })
  })
})

// AQU-2132: the footer reported an audio-only file as `9 cells · 0 translated`
// on most page loads while the sidebar row for the SAME file read
// `67% recorded, 67% audio validated`. Both draw the open file; only the row
// honoured `mergeFileProgress`'s rule that the server's figures stand until
// the attachment map lands. This is that rule, in one place, for both.
describe("withAudioProgress", () => {
  const TEXT = { translated: 0, validated: 0, total: 9 }

  it("draws the server's pair while the live attachment map has not landed", () => {
    // What `mergeFileProgress` leaves for the open file in that window: the
    // live text half, the server's audio half.
    expect(withAudioProgress(TEXT, { translated: 0, validated: 0, total: 9, recorded: 6, audioValidated: 6 }))
      .toEqual({ translated: 0, validated: 0, total: 9, recorded: 6, audioValidated: 6 })
  })

  it("prefers the live pair once it is on the merged entry", () => {
    expect(withAudioProgress(TEXT, { translated: 0, validated: 0, total: 9, recorded: 9, audioValidated: 7 }))
      .toEqual({ translated: 0, validated: 0, total: 9, recorded: 9, audioValidated: 7 })
  })

  it("leaves the text figures alone when no audio figures exist anywhere", () => {
    // A file the server described before it sent the pair at all. Fabricating
    // `recorded: 0` here is the regression — it reads as "nothing recorded"
    // and hides the audio half for a file that may be fully recorded.
    expect(withAudioProgress(TEXT, { translated: 0, validated: 0, total: 9 })).toBe(TEXT)
    expect(withAudioProgress(TEXT, undefined)).toBe(TEXT)
  })

  it("keeps a genuine zero, which is an answer", () => {
    expect(withAudioProgress(TEXT, { translated: 0, validated: 0, total: 9, recorded: 0 }))
      .toEqual({ translated: 0, validated: 0, total: 9, recorded: 0, audioValidated: 0 })
  })
})

describe("fileProgressView (media redesign)", () => {
  it("follows the file's evidence when nobody has chosen", () => {
    expect(fileProgressView({ total: 10, translated: 4, validated: 1 })).toBe("text")
    expect(fileProgressView({ total: 10, translated: 0, validated: 0, recorded: 6 })).toBe("audio")
    expect(fileProgressView({ total: 10, translated: 4, validated: 1, recorded: 6 })).toBe("both")
  })

  it("what the language delivers wins where someone has chosen", () => {
    expect(fileProgressView({ total: 10, translated: 4, validated: 1, recorded: 6, delivers: "text" })).toBe("text")
    expect(fileProgressView({ total: 10, translated: 4, validated: 1, delivers: "audio" })).toBe("audio")
    expect(fileProgressView({ total: 10, translated: 0, validated: 0, recorded: 6, delivers: "text_and_audio" })).toBe("both")
  })
})
