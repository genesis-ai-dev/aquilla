/**
 * AQU-1047 — the checked-in benchmark for the whole-Bible-in-one-file case.
 *
 *   VITE_AQU1047_BENCH=1 npx vitest run src/hooks/useActiveCellStore.largeFile.bench.test.ts
 *   VITE_AQU1047_BENCH=1 VITE_AQU1047_CELLS=34000 VITE_AQU1047_COMPARE=4000 \
 *     npx vitest run src/hooks/useActiveCellStore.largeFile.bench.test.ts
 *
 * The ticket asked for "a reproducible ~34,000-cell fixture and benchmark/
 * profile procedure checked in" (AC1) and for the dominant costs to be named
 * separately for entry, distant navigation, scrolling and cell interaction
 * (AC2). This is that procedure. It reports two kinds of number per phase:
 *
 *   ms          — wall clock. Informative, machine-dependent. Never assert on it.
 *   cellsWalked — cells visited by a file-proportional loop. Exact, machine-
 *                 independent, and the number that says whether a phase is
 *                 viewport-scoped or file-scoped.
 *
 * `VITE_AQU1047_COMPARE` runs the identical script at a second, smaller size. The
 * rightmost column is the point: post-entry, every ratio should be 1.00 with
 * both sides at zero. A phase whose `cellsWalked` tracks the file size is the
 * regression this ticket exists for.
 *
 * It is SKIPPED by default. A benchmark's wall-clock column is meaningless on
 * shared CI and its table is noise in a normal run; the assertions that must
 * hold every time live in `useActiveCellStore.largeFile.test.ts`, which is not
 * skipped. This file is the instrument you reach for when investigating, and
 * it deliberately shares that suite's fixture and counters so the two cannot
 * drift apart.
 *
 * Why the store and not a browser profile: the regression in this ticket was
 * never paint cost — it was derivations busting file-wide on a keystroke —
 * which reproduces headless, in a second, without a 34k-cell project or a
 * Chrome trace. For the in-browser half (paint, scroll jank),
 * `scripts/browser-verify/aqu-1068-bible-profile.mjs` drives a real project,
 * and `CellStore.getMemorySnapshot()` now reports these same counters live, so
 * a browser session can be read with the same instrument.
 */

import { describe, it } from "vitest"
import { CellStore } from "./useActiveCellStore"
import {
  buildWholeBibleFixture,
  WHOLE_BIBLE_CELL_COUNT,
  type WholeBibleFixture,
} from "@/lib/__fixtures__/whole-bible-fixture"

const VIEWPORT = 50

// Vitest strips bare process.env from the test environment; vite forwards only
// VITE_-prefixed vars, so that is the prefix the documented commands use.
const ENABLED = import.meta.env.VITE_AQU1047_BENCH === "1"
const CELLS = Number(import.meta.env.VITE_AQU1047_CELLS) || WHOLE_BIBLE_CELL_COUNT
const COMPARE = Number(import.meta.env.VITE_AQU1047_COMPARE) || 0

interface PhaseResult {
  phase: string
  ms: number
  cellsWalked: number
  cellViewsBuilt: number
}

function newStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: "bench",
    fileId: "whole-bible",
    username: "bench",
    requiredValidations: 2,
    auditStats: new Map(),
  })
  return store
}

/** Run one phase with the counters zeroed, and report both kinds of cost. */
function phase(store: CellStore, name: string, body: () => void): PhaseResult {
  store.resetWorkStats()
  const started = performance.now()
  body()
  const ms = performance.now() - started
  const work = store.getWorkStats()
  return { phase: name, ms, cellsWalked: work.cellsWalked, cellViewsBuilt: work.cellViewsBuilt }
}

function run(fixture: WholeBibleFixture): PhaseResult[] {
  const store = newStore()
  const results: PhaseResult[] = []

  results.push(phase(store, "import (hydrate rows)", () => {
    store.replaceRows(fixture.rows, { full: true, maxServerSeq: 1 })
  }))

  results.push(phase(store, "enter file (nav + progress)", () => {
    store.getNavigationIndex()
    store.getFileProgressSnapshot()
  }))

  results.push(phase(store, "first viewport", () => {
    store.getRange(0, VIEWPORT)
  }))

  results.push(phase(store, "4 distant chapter jumps", () => {
    for (const fraction of [0.1, 0.5, 0.92, 0.45]) {
      const label = fixture.chapterLabels[Math.floor(fixture.chapterLabels.length * fraction)]
      const cellId = store.findCellIdBySection(label)
      if (!cellId) continue
      const index = store.findIndexByCellId(cellId)
      store.getRange(index, index + VIEWPORT)
    }
  }))

  const scrollStart = Math.floor(fixture.cellIds.length * 0.5)
  results.push(phase(store, "scroll 20 viewports", () => {
    for (let i = 0; i < 20; i++) {
      const from = scrollStart + i * VIEWPORT
      store.getRange(from, from + VIEWPORT)
    }
  }))

  results.push(phase(store, "1 keystroke + commit reads", () => {
    store.applyOptimisticTargetEdit(fixture.cellIds[scrollStart + 5], { value: "a freshly typed draft" })
    store.getRange(scrollStart, scrollStart + VIEWPORT)
    store.getFileProgressSnapshot()
    store.getNavigationIndex()
  }))

  results.push(phase(store, "arrow through 50 rendered cells", () => {
    for (const cellId of fixture.cellIds.slice(scrollStart, scrollStart + VIEWPORT)) {
      store.getCellView(cellId)
    }
  }))

  return results
}

function report(label: string, fixture: WholeBibleFixture, results: PhaseResult[]): void {
  console.log(`\n${label} — ${fixture.stats.cells.toLocaleString()} cells ` +
    `(${fixture.stats.books} books, ${fixture.stats.chapters} chapters, ` +
    `${fixture.stats.translated.toLocaleString()} translated)`)
  console.table(results.map((r) => ({
    phase: r.phase,
    ms: +r.ms.toFixed(1),
    cellsWalked: r.cellsWalked,
    cellViewsBuilt: r.cellViewsBuilt,
  })))
}

describe.skipIf(!ENABLED)("AQU-1047 large-file benchmark", () => {
  it("profiles import, entry, navigation, scrolling and cell interaction", () => {
    const main = buildWholeBibleFixture({ targetCells: CELLS })
    const mainResults = run(main)
    report("MAIN", main, mainResults)

    if (COMPARE <= 0) return

    const other = buildWholeBibleFixture({ targetCells: COMPARE })
    const otherResults = run(other)
    report("COMPARE", other, otherResults)

    console.log(`\nScaling — cellsWalked at ${CELLS.toLocaleString()} vs ${COMPARE.toLocaleString()} cells.`)
    console.log("Post-entry, every ratio should be 1.00 with both sides at zero:\n")
    console.table(mainResults.map((r, i) => {
      const base = otherResults[i]
      return {
        phase: r.phase,
        [`walked@${CELLS}`]: r.cellsWalked,
        [`walked@${COMPARE}`]: base.cellsWalked,
        ratio: base.cellsWalked === 0
          ? (r.cellsWalked === 0 ? "1.00" : "∞ — REGRESSION")
          : (r.cellsWalked / base.cellsWalked).toFixed(2),
      }
    }))
  })
})
