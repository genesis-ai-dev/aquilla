import { describe, it, expect, beforeEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"
import { createFileDoc, destroyFileDoc } from "@/lib/store/file-doc"
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
})
