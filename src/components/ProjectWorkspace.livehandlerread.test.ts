/**
 * AQU-1147 — handler bodies read the cell store LIVE, not at a version.
 *
 * `ProjectWorkspace` subscribes to the all-cells version once
 * (`useCellStoreVersion`) and ~20 derivations hang off it, so every cell
 * commit re-renders the 11.5k-line shell. Six async handlers were part of that
 * churn for no reason: they wrapped their store reads in
 * `readAtVersion(cellStoreVersion, …)` and carried `cellStoreVersion` in their
 * dependency arrays, so each one got a NEW IDENTITY on every commit and
 * re-rendered the drawers and dialogs holding it —
 *
 *   handleResolveCharacter, handleResetResolutions, handleClearCharacters,
 *   handleImportAudioVtt, handleReconcileAudioCues, handleRepairAllCueLinks
 *
 * `readAtVersion` is a pure passthrough whose only job is to make the version
 * an operand the React Compiler must track *inside a memoized computation*
 * (see its doc comment in `useActiveCellStore.ts`). A handler body is not a
 * memoized computation: it runs at invocation time and reads whatever the
 * store holds then. So the version bought nothing there and cost an identity.
 *
 * That correctness argument rests on ONE property of the store, which is what
 * these tests pin: an unversioned read taken inside a closure created BEFORE a
 * mutation still sees the data written AFTER it. If `getAllCellViews` /
 * `getAllSummaries` ever started returning a snapshot frozen at closure-
 * creation time, those six handlers would silently act on stale cells — a
 * character resolve would re-write an old name, a cue re-link would pair
 * against text that has since changed. This file fails first if that happens.
 */
import { describe, expect, it } from "vitest"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { CellStore } from "@/hooks/useActiveCellStore"

function row(
  cellId: string,
  side: "source" | "target",
  value: string,
  over: Partial<CellRow> = {},
): CellRow {
  return {
    cellId,
    side,
    value,
    valueHtml: null,
    type: null,
    canonicalRef: null,
    anchorCellId: null,
    eventId: `${side}-${cellId}`,
    sourceEventId: null,
    lastEditor: "alice",
    lastEditAt: 1,
    validated: false,
    wordCount: value ? 1 : 0,
    endorsementCount: 0,
    ...over,
  }
}

function newStore(): CellStore {
  const store = new CellStore()
  store.setRuntime({
    projectId: "p1",
    fileId: "f1",
    username: "alice",
    requiredValidations: 1,
    auditStats: new Map(),
  })
  return store
}

describe("AQU-1147: unversioned handler reads stay live", () => {
  it("getAllCellViews() inside a pre-existing closure sees rows added later", () => {
    const store = newStore()
    store.replaceRows([row("a", "source", "hello")])

    // The closure stands in for a handler captured into a child's props at
    // render N; it references the store only, never a version counter.
    const handler = () => store.getAllCellViews()
    expect(handler().map((c) => c.id)).toEqual(["a"])

    // …a commit lands at render N+1, and the SAME closure must see it.
    store.replaceRows([row("a", "source", "hello"), row("b", "source", "world")])
    expect(handler().map((c) => c.id)).toEqual(["a", "b"])
  })

  it("getAllCellViews() inside a pre-existing closure sees an edit to a cell it already read", () => {
    const store = newStore()
    store.replaceRows([row("a", "source", "hello")])
    const handler = () => store.getAllCellViews()
    expect(handler()[0]?.translated).toBe("")

    store.applyOptimisticTargetEdit("a", { value: "hola" })
    expect(handler()[0]?.translated).toBe("hola")
  })

  it("getAllCellViews() inside a pre-existing closure sees metadata written later", () => {
    // The character handlers read `metadata.cast_name` off the VIEWS (the
    // summaries do not carry metadata) — the axis they must never act on
    // stale.
    const store = newStore()
    store.replaceRows([row("a", "source", "hello")])
    const handler = () => store.getAllCellViews()
    expect(handler()[0]?.metadata?.cast_name).toBeUndefined()

    store.replaceRowsForCell("a", [
      row("a", "source", "hello", { metadata: { cast_name: "QUINTUS" } }),
    ])
    expect(handler()[0]?.metadata?.cast_name).toBe("QUINTUS")
  })

  it("getAllSummaries() inside a pre-existing closure sees rows added later", () => {
    // The cue-link handlers plan against summaries, which are served from a
    // derived cache — so this pins that the cache invalidates on write rather
    // than handing the closure its stale build.
    const store = newStore()
    store.replaceRows([row("a", "source", "hello")])
    const handler = () => store.getAllSummaries()
    expect(handler().map((c) => c.id)).toEqual(["a"])

    store.replaceRows([row("a", "source", "hello"), row("b", "source", "world")])
    expect(handler().map((c) => c.id)).toEqual(["a", "b"])
  })

  it("getAllSummaries() inside a pre-existing closure sees an edit to a cell it already read", () => {
    const store = newStore()
    store.replaceRows([row("a", "source", "hello")])
    const handler = () => store.getAllSummaries()
    expect(handler()[0]?.translated).toBe("")

    store.applyOptimisticTargetEdit("a", { value: "hola" })
    expect(handler()[0]?.translated).toBe("hola")
  })
})
