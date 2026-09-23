/**
 * AQU-1326: the gate that holds the workspace's secondary per-file reads
 * (validation stats, comments, audio attachments, the sidebar progress rollup)
 * until the editor's first cell page has painted.
 *
 * `nextPaintGate` is the pure reducer behind it, tested directly — the same
 * extract-the-guard pattern as `shouldApplyCheckResult`, since rendering the
 * whole ProjectWorkspace proves nothing extra about the rule.
 *
 * The regression this pins: the cell store's `isLoading` starts FALSE and only
 * flips true once its fetch gets past an async cache read. A first cut gated on
 * `!cellsLoading`, which is true at mount — so the gate opened on the very
 * first commit, before the cell stream had even been requested, and the whole
 * fan-out went out exactly as before. QA caught it in the deployed preview's
 * HAR (audit-stats and file-progress ahead of any cells request).
 */
import { describe, it, expect } from "vitest"
import { nextPaintGate } from "./project-workspace-helpers"
import type { PaintGate } from "./project-workspace-helpers"

const CLOSED: PaintGate = { file: null, sawLoad: false, open: false }

describe("nextPaintGate (AQU-1326 deferral gate)", () => {
  it("stays SHUT at mount, before the cell fetch has flipped isLoading", () => {
    // The exact regression: a file is open, nothing has loaded yet, and
    // `cellsLoading` is still its initial false.
    const gate = nextPaintGate(CLOSED, {
      fileId: "fileA",
      cellCount: 0,
      cellsError: false,
      cellsLoading: false,
    })
    expect(gate.open).toBe(false)
  })

  it("stays shut while the cell stream is in flight", () => {
    let gate = nextPaintGate(CLOSED, { fileId: "fileA", cellCount: 0, cellsError: false, cellsLoading: false })
    gate = nextPaintGate(gate, { fileId: "fileA", cellCount: 0, cellsError: false, cellsLoading: true })
    expect(gate.open).toBe(false)
    expect(gate.sawLoad).toBe(true)
  })

  it("opens on the first cell page, while the rest of the stream is still loading", () => {
    let gate = nextPaintGate(CLOSED, { fileId: "fileA", cellCount: 0, cellsError: false, cellsLoading: false })
    gate = nextPaintGate(gate, { fileId: "fileA", cellCount: 0, cellsError: false, cellsLoading: true })
    gate = nextPaintGate(gate, { fileId: "fileA", cellCount: 500, cellsError: false, cellsLoading: true })
    expect(gate.open).toBe(true)
  })

  it("opens for a file that finished loading with no cells at all", () => {
    // An empty file yields no first paint — these hooks must not be stranded.
    let gate = nextPaintGate(CLOSED, { fileId: "empty", cellCount: 0, cellsError: false, cellsLoading: false })
    gate = nextPaintGate(gate, { fileId: "empty", cellCount: 0, cellsError: false, cellsLoading: true })
    gate = nextPaintGate(gate, { fileId: "empty", cellCount: 0, cellsError: false, cellsLoading: false })
    expect(gate.open).toBe(true)
  })

  it("opens when the cell load failed", () => {
    const gate = nextPaintGate(CLOSED, {
      fileId: "fileA",
      cellCount: 0,
      cellsError: true,
      cellsLoading: false,
    })
    expect(gate.open).toBe(true)
  })

  it("opens when no file is open — there is nothing to defer behind", () => {
    const gate = nextPaintGate(CLOSED, { fileId: null, cellCount: 0, cellsError: false, cellsLoading: false })
    expect(gate.open).toBe(true)
  })

  it("does not trust a stale cell count from the previous file on a switch", () => {
    // The store can still hold the previous file's rows for a render after
    // activeFileId changes; that count must not open the new file's gate.
    let gate = nextPaintGate(CLOSED, { fileId: "fileA", cellCount: 0, cellsError: false, cellsLoading: true })
    gate = nextPaintGate(gate, { fileId: "fileA", cellCount: 500, cellsError: false, cellsLoading: false })
    expect(gate.open).toBe(true)
    gate = nextPaintGate(gate, { fileId: "fileB", cellCount: 500, cellsError: false, cellsLoading: false })
    expect(gate.open).toBe(false)
  })

  it("re-closes on a file switch instead of inheriting the last file's gate", () => {
    let gate = nextPaintGate(CLOSED, { fileId: "fileA", cellCount: 0, cellsError: false, cellsLoading: true })
    gate = nextPaintGate(gate, { fileId: "fileA", cellCount: 500, cellsError: false, cellsLoading: false })
    expect(gate.open).toBe(true)

    // Switching files must put the new file's cell stream first too.
    gate = nextPaintGate(gate, { fileId: "fileB", cellCount: 0, cellsError: false, cellsLoading: false })
    expect(gate.open).toBe(false)
    expect(gate.sawLoad).toBe(false)
    expect(gate.file).toBe("fileB")
  })

  it("returns the SAME object when nothing changed, so the effect cannot loop", () => {
    const settled = nextPaintGate(CLOSED, { fileId: "fileA", cellCount: 0, cellsError: false, cellsLoading: false })
    const again = nextPaintGate(settled, { fileId: "fileA", cellCount: 0, cellsError: false, cellsLoading: false })
    expect(again).toBe(settled)
  })
})
