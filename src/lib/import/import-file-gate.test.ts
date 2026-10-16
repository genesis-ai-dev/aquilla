// AQU-1365: the translation import's opening gate. WHY: the review matches
// against whatever lines it is handed when it mounts, so the dialog must not
// start it on the previous file's rows, on the first page of a long file, or
// never (an empty file, a cache paint that never sets isLoading).
import { describe, expect, it } from "vitest"
import {
  CLOSED_IMPORT_FILE_GATE,
  nextImportFileGate,
  type ImportFileGate,
  type ImportFileGateInput,
} from "./import-file-gate"

const base: ImportFileGateInput = {
  wantedFileId: "ruth",
  activeFileId: "ruth",
  cellsLoading: false,
  cellsError: false,
  cellCount: 0,
  firstCellFileId: undefined,
}

/** Feed a sequence of store states through the reducer; returns each state. */
function run(steps: Partial<ImportFileGateInput>[], start: ImportFileGate = CLOSED_IMPORT_FILE_GATE) {
  let gate = start
  return steps.map((step) => {
    const next = nextImportFileGate(gate, { ...base, ...step })
    gate = next.gate
    return next.state
  })
}

describe("nextImportFileGate", () => {
  it("waits while the editor is still on another file, even with rows in the store", () => {
    expect(run([{ activeFileId: "jonah", cellCount: 8, firstCellFileId: "jonah" }])).toEqual(["waiting"])
  })

  it("waits while the previous file's rows are still in the store after the switch", () => {
    expect(run([{ cellCount: 8, firstCellFileId: "jonah" }])).toEqual(["waiting"])
  })

  it("waits through a streamed load and opens when it finishes", () => {
    expect(run([
      { activeFileId: "jonah", cellCount: 8, firstCellFileId: "jonah" },
      { cellCount: 0 },
      { cellsLoading: true },
      { cellsLoading: true, cellCount: 2, firstCellFileId: "ruth" },
      { cellCount: 4, firstCellFileId: "ruth" },
    ])).toEqual(["waiting", "waiting", "waiting", "waiting", "ready"])
  })

  it("waits through a cache paint until it is brought up to date", () => {
    // A cache paint never sets isLoading, and its rows may be a week old: a
    // teammate's lines must show as conflicts, not as empty lines to fill.
    expect(run([
      { cellCount: 0 },
      { cellCount: 4, firstCellFileId: "ruth", cellsRefreshing: true },
      { cellCount: 4, firstCellFileId: "ruth" },
    ])).toEqual(["waiting", "waiting", "ready"])
  })

  it("opens on a whole file's rows from a host that reports no refresh", () => {
    expect(run([
      { cellCount: 0 },
      { cellCount: 4, firstCellFileId: "ruth" },
    ])).toEqual(["waiting", "ready"])
  })

  it("reports a failed refresh of cached rows instead of opening on them", () => {
    expect(run([
      { cellCount: 4, firstCellFileId: "ruth", cellsRefreshing: true },
      { cellCount: 4, firstCellFileId: "ruth", cellsError: true },
    ])).toEqual(["waiting", "failed"])
  })

  it("opens on a genuinely empty file once its load was seen to finish", () => {
    expect(run([{ cellCount: 0 }, { cellsLoading: true }, { cellCount: 0 }])).toEqual(["waiting", "waiting", "ready"])
  })

  it("does not treat 'not loading yet' as an empty file", () => {
    expect(run([{ cellCount: 0 }, { cellCount: 0 }])).toEqual(["waiting", "waiting"])
  })

  it("reports a failed load, and recovers on a retry", () => {
    expect(run([
      { cellsLoading: true },
      { cellsError: true },
      { cellsLoading: true },
      { cellCount: 4, firstCellFileId: "ruth" },
    ])).toEqual(["waiting", "failed", "waiting", "ready"])
  })

  it("forgets a load seen before a switch away and back", () => {
    expect(run([
      { cellsLoading: true },
      { activeFileId: "jonah" },
      { cellCount: 0 },
    ])).toEqual(["waiting", "waiting", "waiting"])
  })

  it("returns the same gate object when nothing changed, on every rule", () => {
    for (const step of [
      { cellsLoading: true },
      { cellCount: 4, firstCellFileId: "ruth", cellsRefreshing: true },
      { activeFileId: "jonah" },
      { cellCount: 8, firstCellFileId: "jonah" },
      { cellCount: 4, firstCellFileId: "ruth" },
    ]) {
      const first = nextImportFileGate(CLOSED_IMPORT_FILE_GATE, { ...base, ...step })
      const second = nextImportFileGate(first.gate, { ...base, ...step })
      expect(second.gate).toBe(first.gate)
      expect(second.state).toBe(first.state)
    }
  })
})
