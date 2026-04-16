import "fake-indexeddb/auto"
import { describe, it, expect } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import * as Y from "yjs"
import { useFileMeta } from "./useFileMeta"

function buildDoc(initialMeta: Record<string, unknown> = {}): Y.Doc {
  const doc = new Y.Doc()
  doc.getMap("meta").set("__source", { id: "f", originalName: "f", ...initialMeta })
  return doc
}

describe("useFileMeta", () => {
  it("returns defaults when meta has nothing set", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en"))
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(true))
    expect(result.current.textDirection).toBe("ltr")
  })

  it("auto-seeds textDirection to rtl when targetLanguage is Arabic", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "ar"))
    await waitFor(() => expect(result.current.textDirection).toBe("rtl"))
    // The seed is persisted to __source so future reads / serializers see it
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("rtl")
  })

  it("does not re-seed when textDirection is already set", async () => {
    const doc = buildDoc({ textDirection: "ltr" })
    const { result } = renderHook(() => useFileMeta(doc, "ar"))
    await waitFor(() => expect(result.current.textDirection).toBe("ltr"))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("ltr")
  })

  it("setLineNumbersEnabled writes to __source", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en"))
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(true))
    act(() => { result.current.setLineNumbersEnabled(false) })
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(false))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.lineNumbersEnabled).toBe(false)
  })

  it("setTextDirection writes to __source", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en"))
    await waitFor(() => expect(result.current.textDirection).toBe("ltr"))
    act(() => { result.current.setTextDirection("rtl") })
    await waitFor(() => expect(result.current.textDirection).toBe("rtl"))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("rtl")
  })

  it("returns sane defaults for null doc", () => {
    const { result } = renderHook(() => useFileMeta(null, "en"))
    expect(result.current.lineNumbersEnabled).toBe(true)
    expect(result.current.textDirection).toBe("ltr")
  })
})
