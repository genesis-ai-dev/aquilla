import { describe, it, expect } from "vitest"
import { fileSummariesToProgress, mergeFileProgress } from "./file-summary-progress"
import type { FileSummary } from "@/lib/sync/cells-read-types"

function makeSummary(overrides: Partial<FileSummary> = {}): FileSummary {
  return {
    fileId: "file-1",
    projectId: "project-1",
    name: "Genesis",
    fileType: "usfm",
    sourceLanguage: "en",
    targetLanguage: "fr",
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

  it("adds live-only entries (e.g. a brand-new file not yet in the server snapshot)", () => {
    const base = new Map([["gen", { translated: 7, validated: 3, total: 10 }]])
    const live = new Map([["new-file", { translated: 1, validated: 0, total: 5 }]])
    const merged = mergeFileProgress(base, live)
    expect(merged.size).toBe(2)
    expect(merged.get("new-file")).toEqual({ translated: 1, validated: 0, total: 5 })
  })
})
