/**
 * AQU-2118 — which pushed file-progress frame may move a sidebar rollup row.
 *
 * The rollup is read for the lane the switcher shows (`?lane=` on
 * GET /files), so a `file.progress.pushed` frame lands in it only when it is
 * that lane's. Before this the row took the '' lane's frames whatever lane
 * was open — the bar then reported the bridge while the chapters under it
 * reported the open lane.
 *
 * Extract-the-logic pattern, same as runReconnectResync: pinned here rather
 * than by rendering the shell's socket effect.
 */
import { describe, it, expect } from "vitest"
import { pushedRollupProgress } from "./project-workspace-helpers"

const counts = (filledCount: number) => ({ totalCount: 10, filledCount, validatedCount: 1 })

describe("pushedRollupProgress (AQU-2118)", () => {
  it("lands only a frame for the lane the rollup was read for, and only when it changes something", () => {
    const current = new Map([["gen", { translated: 3, validated: 1, total: 10 }]])
    const cases = [
      { name: "the open lane's frame moves the row", lane: "fr", active: "fr", filled: 5, moved: true },
      { name: "another lane's frame leaves the row alone", lane: "", active: "fr", filled: 5, moved: false },
      { name: "a named lane's frame while the default lane is open", lane: "fr", active: "", filled: 5, moved: false },
      { name: "the default lane's frame while it is the open one", lane: "", active: "", filled: 5, moved: true },
      { name: "a frame that changes nothing returns the same map", lane: "fr", active: "fr", filled: 3, moved: false },
    ]
    for (const c of cases) {
      const next = pushedRollupProgress(current, { file: "gen", lane: c.lane, counts: counts(c.filled) }, c.active)
      expect(next === current, c.name).toBe(!c.moved)
      if (c.moved) expect(next.get("gen"), c.name).toEqual({ translated: c.filled, validated: 1, total: 10 })
    }
    // A file the rollup has not seen yet is added, never dropped.
    const added = pushedRollupProgress(new Map(), { file: "exo", lane: "fr", counts: counts(2) }, "fr")
    expect(added.get("exo")).toEqual({ translated: 2, validated: 1, total: 10 })
  })
})
