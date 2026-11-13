/**
 * The book page renders each unit in a controlled textarea. If the hook
 * updates React state only after the IndexedDB write resolves, React paints
 * one frame with the previous value between the keystroke and the write, and
 * the browser moves the caret to the end of the field on every change.
 * So: the edited text must be in state as soon as setEditText returns to the
 * event loop, before the store write has completed.
 */

import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { IDBFactory } from "fake-indexeddb"
import { resetBridgeStoreForTests, bridgeStore } from "./store"
import type { BridgeProject } from "./use-paratext-discovery"
import { bridgeStateId, type ParatextSettings } from "./project"

const USFM = "\\id MAT\n\\c 1\n\\v 1 In the beginning.\n\\v 2 Second verse.\n"

vi.mock("./tauri", () => ({
  paratextTauri: {
    readFile: async () => new TextEncoder().encode(USFM),
    watch: async () => {},
    unwatch: async () => {},
  },
  onParatextFileChanged: async () => () => {},
}))

import { useParatextBook } from "./use-paratext-book"

const project: BridgeProject = {
  path: "/pt/TPP1", folderName: "TPP1", guid: "guid-1", stateId: bridgeStateId("guid-1", "/pt/TPP1"), utf8: true, access: null,
  settings: {} as ParatextSettings, books: [{ code: "MAT", fileName: "41MATTPP1.SFM" }],
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetBridgeStoreForTests()
})

describe("useParatextBook setEditText", () => {
  it("puts the typed text in state before the store write resolves", async () => {
    const { result } = renderHook(() => useParatextBook(project, "41MATTPP1.SFM", "ryder"))
    await waitFor(() => expect(result.current[0].units).not.toBeNull())
    const unit = result.current[0].units!.units.find((u) => u.id === "MAT 1:1")!

    // Stall the persistence so the only way the state can update is synchronously.
    const gate = new Promise<void>(() => {})
    const put = vi.spyOn(bridgeStore, "putPendingEdit").mockReturnValue(gate)

    act(() => { void result.current[1].setEditText(unit, "In the beginnin") })
    expect(result.current[0].edits.get("MAT 1:1")?.text).toBe("In the beginnin")
    expect(put).toHaveBeenCalledTimes(1)
  })
})
