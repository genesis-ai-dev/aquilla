import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import * as Y from "yjs"
import { createFileDoc, destroyFileDoc, loadFileDoc } from "@/lib/store/file-doc"
import { appendEntry, getEditsArray } from "@/lib/codex-editor/edits/yjs-helpers"
import { useSectionProgress } from "./useSectionProgress"

describe("useSectionProgress", () => {
  beforeEach(() => {
    // Fresh IDB per test so file IDs don't collide across runs
    // eslint-disable-next-line no-global-assign
    ;(globalThis as any).indexedDB = new IDBFactory()
  })

  it("returns null while loading and sections once synced", async () => {
    const handle = createFileDoc("test-file-1", "file.usfm", "usfm", "en", "fr", [
      { id: "c1", original: "Hello", translated: "Bonjour", context: "", group: "g", section: "Chapter 1", type: "text" },
      { id: "c2", original: "World", translated: "",        context: "", group: "g", section: "Chapter 1", type: "text" },
      { id: "c3", original: "!",     translated: "!",       context: "", group: "g", section: "Chapter 2", type: "text" },
    ])
    await new Promise<void>((r) => handle.persistence.once("synced", () => r()))
    destroyFileDoc(handle)

    const { result } = renderHook(() => useSectionProgress("test-file-1", 1))

    await waitFor(() => {
      expect(result.current).not.toBeNull()
    }, { timeout: 2000 })

    const sections = result.current!
    expect(sections).toHaveLength(2)
    expect(sections[0].label).toBe("Chapter 1")
    expect(sections[0].textCompleted).toBe(50)  // 1/2
    expect(sections[1].label).toBe("Chapter 2")
    expect(sections[1].textCompleted).toBe(100) // 1/1
  })

  it("returns null when fileId is null", () => {
    const { result } = renderHook(() => useSectionProgress(null, 1))
    expect(result.current).toBeNull()
  })

  it("textValidated advances when validators are added to cell.edits after mount", async () => {
    // Regression test for the bug where the sidebar's "% validated" bar
    // stayed at 0 because `useSectionProgress` read validators from the
    // stale `__source.metadata.edits` snapshot instead of the live
    // `cell.edits` Y.Array. Mirrors the editor's validate-click path:
    // append a value-edit with a seeded validator, expect the bar to move.
    const fileId = "test-file-validated-live"
    const setup = createFileDoc(fileId, "file.usfm", "usfm", "en", "fr", [
      { id: "c1", original: "Hello", translated: "Bonjour", context: "", group: "g", section: "Chapter 1", type: "text" },
      { id: "c2", original: "World", translated: "Monde",   context: "", group: "g", section: "Chapter 1", type: "text" },
    ])
    await new Promise<void>((r) => setup.persistence.once("synced", () => r()))
    destroyFileDoc(setup)

    const { result } = renderHook(() => useSectionProgress(fileId, 1))
    await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 2000 })
    expect(result.current![0].textValidated).toBe(0)
    expect(result.current![0].textCompleted).toBe(100)

    // Validate c1 via the same Yjs mutation path the editor uses.
    const handle = loadFileDoc(fileId)
    try {
      const cell = handle.doc.getMap("cells").get("c1") as Y.Map<unknown>
      handle.doc.transact(() => {
        const arr = getEditsArray(cell)
        appendEntry(arr, {
          authors: ["alice"],
          timestamp: Date.now(),
          type: "user-edit",
          editMap: ["value"],
          value: "Bonjour",
          seedValidator: "alice",
        })
      })
      await waitFor(() => {
        expect(result.current![0].textValidated).toBe(50)  // 1 of 2 validated
      }, { timeout: 2000 })
    } finally {
      destroyFileDoc(handle)
    }
  })

  it("soft-deleted validators don't count toward textValidated", async () => {
    const fileId = "test-file-soft-deleted"
    const setup = createFileDoc(fileId, "file.usfm", "usfm", "en", "fr", [
      { id: "c1", original: "Hello", translated: "Bonjour", context: "", group: "g", section: "Chapter 1", type: "text" },
    ])
    await new Promise<void>((r) => setup.persistence.once("synced", () => r()))
    destroyFileDoc(setup)

    const handle = loadFileDoc(fileId)
    try {
      await new Promise<void>((r) => {
        if (handle.persistence.synced) r()
        else handle.persistence.once("synced", () => r())
      })
      const cell = handle.doc.getMap("cells").get("c1") as Y.Map<unknown>
      handle.doc.transact(() => {
        const arr = getEditsArray(cell)
        const entry = appendEntry(arr, {
          authors: ["alice"], timestamp: Date.now(),
          type: "user-edit", editMap: ["value"], value: "Bonjour",
          seedValidator: "alice",
        })
        // Immediately soft-delete the seed so the validator is recorded but inactive.
        const validators = entry.get("validatedBy") as Y.Map<Y.Map<unknown>>
        const v = validators.get("alice")!
        v.set("isDeleted", true)
      })

      const { result } = renderHook(() => useSectionProgress(fileId, 1))
      await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 2000 })
      expect(result.current![0].textValidated).toBe(0)
    } finally {
      destroyFileDoc(handle)
    }
  })
})
