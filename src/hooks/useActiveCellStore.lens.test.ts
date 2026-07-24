// AQU-646: getCellIdsForLens — the TEXT lens of a time-ordered file must show
// media sections (their transcript IS the translatable source text); an
// imported audio file's text view used to be empty. The media lens stays
// media-only, and non-time files are untouched.

import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "./useActiveCellStore"

function row(cellId: string, over: Partial<CellRow> = {}): CellRow {
  return {
    cellId,
    side: "source",
    value: "x",
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `source-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: 1,
    endorsementCount: 0,
    ...over,
  } as CellRow
}

function makeStore(rows: CellRow[]): CellStore {
  const store = new CellStore()
  store.reset("p", "f")
  store.setRuntime({
    projectId: "p",
    fileId: "f",
    username: "alice",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  store.replaceRows(rows, { full: true })
  return store
}

const mixedRows = [
  row("text1", { startMs: 0, endMs: 2_000 }),
  row("media1", { medium: "media", startMs: 2_000, endMs: 8_000 }),
  row("media2", { medium: "media", startMs: 8_000, endMs: 12_000 }),
]

describe("getCellIdsForLens (AQU-646)", () => {
  it("time-ordered TEXT lens includes media cells, time-sorted", () => {
    const store = makeStore(mixedRows)
    expect(store.getCellIdsForLens("time", false)).toEqual(["text1", "media1", "media2"])
  })

  it("time-ordered MEDIA lens stays media-only", () => {
    const store = makeStore(mixedRows)
    expect(store.getCellIdsForLens("time", true)).toEqual(["media1", "media2"])
  })

  it("non-time files return the raw order unfiltered", () => {
    const store = makeStore(mixedRows)
    expect(store.getCellIdsForLens("sequence", false)).toEqual(store.getCellIds())
  })

  it("a pure-audio file's text lens is non-empty (the imported-MP3 case)", () => {
    const store = makeStore([
      row("m1", { medium: "media", startMs: 0, endMs: 5_000 }),
      row("m2", { medium: "media", startMs: 5_000, endMs: 9_000 }),
    ])
    expect(store.getCellIdsForLens("time", false)).toEqual(["m1", "m2"])
  })
})
