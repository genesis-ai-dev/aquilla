/**
 * AQU-1047 — regression guards for the whole-Bible-in-one-file case (~34k cells).
 *
 * The ticket's original scope (import, entry, navigation all melting on a 34k
 * file) was fixed across AQU-1104 / AQU-1146 / AQU-1147 / AQU-1160 / AQU-1016 /
 * AQU-557 / AQU-350. What it still owed was AC1, AC3 and AC9: a reproducible
 * fixture, evidence rather than assumption, and coverage that stops the fixes
 * from silently rotting.
 *
 * The problem with guarding performance is that the usual instruments are the
 * wrong ones. Wall-clock assertions flake on shared CI. Snapshot-identity
 * assertions (the idiom in `useActiveCellStore.progress.test.ts`) prove a
 * specific cache held, but say nothing about how much per-cell work happened
 * around it. And every existing store suite runs on a handful of cells, where
 * an O(1) path and an O(N) path are indistinguishable.
 *
 * So these guards count work instead of timing it, via `getWorkStats()`
 * (AQU-1047, see `CellStoreWorkStats`). Each counter is a CACHE MISS — work
 * actually performed — which makes the invariant exactly expressible:
 *
 *   ordinary interaction on a 34,000-cell file must cost the same as the same
 *   interaction on a 4,000-cell file.
 *
 * That equality is the O(N) guard. It cannot be satisfied by a path that walks
 * the file, it does not flake, and it fails loudly with the actual numbers when
 * a memo dependency starts busting file-wide again.
 *
 * `restores the full walk when the file really does change` is the negative
 * control: without it, deleting the derivations entirely would make every other
 * test in this file pass.
 */

import { describe, expect, it, beforeAll } from "vitest"
import { CellStore } from "./useActiveCellStore"
import {
  buildWholeBibleFixture,
  TOTAL_BOOKS,
  TOTAL_CHAPTERS,
  WHOLE_BIBLE_CELL_COUNT,
  type WholeBibleFixture,
} from "@/lib/__fixtures__/whole-bible-fixture"

/** A realistic rendered window — LegendList keeps a few screens of rows live. */
const VIEWPORT = 50

function hydrate(fixture: WholeBibleFixture): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: "bgp-whole-bible",
    fileId: "bible-single-file",
    username: "tester",
    requiredValidations: 2,
    auditStats: new Map(),
  })
  store.replaceRows(fixture.rows, { full: true, maxServerSeq: 1 })
  return store
}

/**
 * The scripted interaction both file sizes are measured against: open the file,
 * read the navigation index, jump to four distant chapters reading a viewport
 * at each, type into one cell, and re-read that viewport.
 *
 * Deliberately touches every path the ticket named — initial entry, distant
 * navigation, scrolling, cell interaction — because the regression it guards
 * against ("a memo invalidates all 34,000 cells when only the viewport, the
 * active cell, or one cell changed") could land in any of them.
 */
function scriptedSession(store: CellStore, fixture: WholeBibleFixture): void {
  store.getNavigationIndex()
  store.getFileProgressSnapshot()
  store.getRange(0, VIEWPORT)

  // Distant jumps: early → middle → late → back to the middle, by fraction of
  // the canon rather than fixed labels so the script is identical at both sizes.
  for (const fraction of [0.1, 0.5, 0.92, 0.45]) {
    const label = fixture.chapterLabels[Math.floor(fixture.chapterLabels.length * fraction)]
    const cellId = store.findCellIdBySection(label)
    expect(cellId).not.toBeNull()
    const index = store.findIndexByCellId(cellId as string)
    expect(index).toBeGreaterThanOrEqual(0)
    store.getRange(index, index + VIEWPORT)
    store.getCellView(cellId as string)
  }

  // One keystroke-sized edit, then everything a React commit re-reads after it:
  // the viewport, the progress bar, and the chapter navigator. Reading progress
  // and navigation here is what makes the edit's cost observable at all — a
  // busted incremental path only defers its whole-file walk to the next read,
  // so a script that stops at `getRange` would measure zero and prove nothing.
  const editIndex = Math.floor(fixture.cellIds.length * 0.45)
  const editedId = fixture.cellIds[editIndex]
  store.applyOptimisticTargetEdit(editedId, { value: "a freshly typed draft" })
  store.getRange(editIndex, editIndex + VIEWPORT)
  store.getFileProgressSnapshot()
  store.getNavigationIndex()
}

describe("CellStore — whole-Bible single file (AQU-1047)", () => {
  let bible: WholeBibleFixture
  let store: CellStore

  beforeAll(() => {
    bible = buildWholeBibleFixture()
    store = hydrate(bible)
  })

  it("builds a fixture at the scale the ticket describes", () => {
    expect(bible.stats.cells).toBe(WHOLE_BIBLE_CELL_COUNT)
    expect(bible.stats.books).toBe(TOTAL_BOOKS)
    expect(bible.stats.chapters).toBe(TOTAL_CHAPTERS)
    expect(TOTAL_CHAPTERS).toBe(1189)
    expect(bible.rows).toHaveLength(WHOLE_BIBLE_CELL_COUNT * 2)
    expect(store.getCellIds()).toHaveLength(WHOLE_BIBLE_CELL_COUNT)
  })

  it("hydrates the file without materialising a view for any cell", () => {
    // Loading 34k rows must not assemble 34k view models — the rows land in the
    // maps and views are built lazily, per cell, as the viewport asks for them.
    const fresh = hydrate(bible)
    expect(fresh.getWorkStats().cellViewsBuilt).toBe(0)
  })

  it("builds views only for the rendered viewport when the file is opened", () => {
    const fresh = hydrate(bible)
    fresh.resetWorkStats()
    fresh.getRange(0, VIEWPORT)
    expect(fresh.getWorkStats().cellViewsBuilt).toBe(VIEWPORT)
  })

  it("walks the file at most once for the derived indexes, however many reads follow", () => {
    const fresh = hydrate(bible)
    fresh.resetWorkStats()
    fresh.getNavigationIndex()
    fresh.getFileProgressSnapshot()
    fresh.getNavigationIndex()
    fresh.getSectionLabelForCellId(bible.cellIds[20_000])
    fresh.findIndexBySection(bible.chapterLabels[600])

    const work = fresh.getWorkStats()
    expect(work.derivedIndexRebuilds).toBe(1)
    expect(work.navigationStructureRebuilds).toBe(1)
    expect(work.navigationIndexRebuilds).toBe(1)
  })

  it("jumps to a distant chapter without rebuilding the file's indexes", () => {
    const fresh = hydrate(bible)
    fresh.getNavigationIndex() // pay for entry once
    fresh.resetWorkStats()

    for (const label of [bible.chapterLabels[5], bible.chapterLabels[700], bible.chapterLabels[1_150]]) {
      const cellId = fresh.findCellIdBySection(label)
      expect(cellId).not.toBeNull()
      const index = fresh.findIndexByCellId(cellId as string)
      fresh.getRange(index, index + VIEWPORT)
    }

    const work = fresh.getWorkStats()
    expect(work.derivedIndexRebuilds).toBe(0)
    expect(work.navigationStructureRebuilds).toBe(0)
    expect(work.navigationIndexRebuilds).toBe(0)
    // Three viewports' worth of cells, and nothing else in the file.
    expect(work.cellViewsBuilt).toBe(3 * VIEWPORT)
    expect(work.cellsWalked).toBe(0)
  })

  it("re-reading the active cell costs nothing after it has been rendered once", () => {
    const fresh = hydrate(bible)
    const window = bible.cellIds.slice(10_000, 10_000 + VIEWPORT)
    fresh.getCellsByIds(window)
    fresh.resetWorkStats()

    // Arrow-keying through an already-rendered window: pure cache hits.
    for (const cellId of window) fresh.getCellView(cellId)
    expect(fresh.getWorkStats().cellViewsBuilt).toBe(0)
  })

  it("rebuilds exactly one cell when one cell is edited", () => {
    const fresh = hydrate(bible)
    const start = 15_000
    fresh.getRange(start, start + VIEWPORT)
    fresh.getNavigationIndex()
    fresh.resetWorkStats()

    fresh.applyOptimisticTargetEdit(bible.cellIds[start + 10], { value: "typed" })
    fresh.getRange(start, start + VIEWPORT)
    // The reads a commit triggers: progress bar and chapter navigator. They are
    // where a busted incremental path would cash in its deferred whole-file walk.
    fresh.getFileProgressSnapshot()

    const work = fresh.getWorkStats()
    expect(work.cellViewsBuilt).toBe(1)
    // A text-only target edit takes the incremental progress path (AQU-1104):
    // no full walk, even though file and section progress both changed.
    expect(work.derivedIndexRebuilds).toBe(0)
    expect(work.cellsWalked).toBe(0)
    expect(fresh.getCellView(bible.cellIds[start + 10])?.translated).toBe("typed")
  })

  /**
   * The AC9 assertion. Everything above fixes numbers for one file size; this
   * fixes the RELATIONSHIP between sizes, which is the property that actually
   * fails when a path goes O(N). 34,000 cells against 4,000 — 8.5× the file —
   * running the identical scripted session.
   */
  it("costs the same on a 34,000-cell file as on a 4,000-cell one", () => {
    const small = buildWholeBibleFixture({ targetCells: 4_000 })
    const large = buildWholeBibleFixture({ targetCells: 34_000 })
    expect(large.stats.cells / small.stats.cells).toBeGreaterThan(8)

    const smallStore = hydrate(small)
    const largeStore = hydrate(large)
    // Opening a file legitimately costs one pass — you cannot draw a chapter
    // navigator without looking at the chapters. Pay it, then zero the counters:
    // what must not scale is everything AFTER entry.
    for (const store of [smallStore, largeStore]) {
      store.getNavigationIndex()
      store.getFileProgressSnapshot()
      store.resetWorkStats()
    }

    scriptedSession(smallStore, small)
    scriptedSession(largeStore, large)

    expect(largeStore.getWorkStats()).toEqual(smallStore.getWorkStats())
    expect(largeStore.getWorkStats().cellsWalked).toBe(0)
  })

  it("enters the file in a bounded number of passes, not one per derivation", () => {
    // The one O(N) cost that IS legitimate — but it must stay a small constant
    // number of passes. Pre-AQU-1104 a single commit paid four to six full
    // walks; this pins entry so that cannot creep back.
    const fresh = hydrate(bible)
    fresh.resetWorkStats()
    fresh.getNavigationIndex()
    fresh.getFileProgressSnapshot()

    const walked = fresh.getWorkStats().cellsWalked
    expect(walked).toBeGreaterThan(0)
    expect(walked).toBeLessThanOrEqual(3 * WHOLE_BIBLE_CELL_COUNT)
  })

  it("restores the full walk when the file really does change", () => {
    // Negative control: the guards above must not be passing because the
    // derivations were removed. A structural change (new source text, so new
    // word counts and a new navigation seed) still pays for a full rebuild.
    const fresh = hydrate(bible)
    fresh.getNavigationIndex()
    fresh.resetWorkStats()

    const cellId = bible.cellIds[9_000]
    fresh.replaceRowsForCell(cellId, [
      {
        cellId, side: "source", value: "A materially different source line", valueHtml: null,
        type: null, canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "source:rewritten",
        sourceEventId: null, lastEditor: "tester", lastEditAt: 2, validated: false, wordCount: 6,
      },
      {
        cellId, side: "target", value: "", valueHtml: null, type: null,
        canonicalRef: "GEN 1:1", anchorCellId: null, eventId: "target:rewritten",
        sourceEventId: null, lastEditor: null, lastEditAt: 0, validated: false, wordCount: 0,
      },
    ])
    fresh.getNavigationIndex()

    expect(fresh.getWorkStats().derivedIndexRebuilds).toBe(1)
  })

  it("reports the work counters in the memory snapshot for in-browser profiling", () => {
    // AC2/AC3: the same numbers these guards assert are readable from the
    // console on a real project, so a profile is evidence rather than a hunch.
    const fresh = hydrate(bible)
    fresh.getRange(0, VIEWPORT)
    const snapshot = fresh.getMemorySnapshot()
    expect(snapshot.cells).toBe(WHOLE_BIBLE_CELL_COUNT)
    expect(snapshot.cellViewsBuilt).toBe(VIEWPORT)
    expect(snapshot.derivedIndexRebuilds).toBe(1)
  })
})
