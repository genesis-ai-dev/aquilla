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
    const { result } = renderHook(() => useFileMeta(doc, "en", "en"))
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(true))
    expect(result.current.sourceTextDirection).toBe("ltr")
    expect(result.current.targetTextDirection).toBe("ltr")
  })

  it("auto-seeds targetTextDirection to rtl when targetLanguage is Arabic", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en", "ar"))
    await waitFor(() => expect(result.current.targetTextDirection).toBe("rtl"))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("rtl")
  })

  it("auto-seeds sourceTextDirection to rtl when sourceLanguage is Hebrew", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "he", "en"))
    await waitFor(() => expect(result.current.sourceTextDirection).toBe("rtl"))
    // Target stays LTR since targetLanguage is English
    expect(result.current.targetTextDirection).toBe("ltr")
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.sourceTextDirection).toBe("rtl")
    expect(src.textDirection).toBe("ltr")
  })

  it("handles mixed directions — source rtl + target ltr", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "ar", "fr"))
    await waitFor(() => {
      expect(result.current.sourceTextDirection).toBe("rtl")
      expect(result.current.targetTextDirection).toBe("ltr")
    })
  })

  it("does not re-seed when textDirection is already set", async () => {
    const doc = buildDoc({ textDirection: "ltr", sourceTextDirection: "ltr" })
    const { result } = renderHook(() => useFileMeta(doc, "ar", "ar"))
    await waitFor(() => expect(result.current.targetTextDirection).toBe("ltr"))
    expect(result.current.sourceTextDirection).toBe("ltr")
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("ltr")
    expect(src.sourceTextDirection).toBe("ltr")
  })

  it("setLineNumbersEnabled writes to __source", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en", "en"))
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(true))
    act(() => { result.current.setLineNumbersEnabled(false) })
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(false))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.lineNumbersEnabled).toBe(false)
  })

  it("setTargetTextDirection writes to __source under textDirection (legacy key)", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en", "en"))
    await waitFor(() => expect(result.current.targetTextDirection).toBe("ltr"))
    act(() => { result.current.setTargetTextDirection("rtl") })
    await waitFor(() => expect(result.current.targetTextDirection).toBe("rtl"))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.textDirection).toBe("rtl")
  })

  it("setSourceTextDirection writes to __source", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "en", "en"))
    await waitFor(() => expect(result.current.sourceTextDirection).toBe("ltr"))
    act(() => { result.current.setSourceTextDirection("rtl") })
    await waitFor(() => expect(result.current.sourceTextDirection).toBe("rtl"))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.sourceTextDirection).toBe("rtl")
  })

  it("returns sane defaults for null doc", () => {
    const { result } = renderHook(() => useFileMeta(null, "en", "en"))
    expect(result.current.lineNumbersEnabled).toBe(true)
    expect(result.current.sourceTextDirection).toBe("ltr")
    expect(result.current.targetTextDirection).toBe("ltr")
    expect(result.current.rtlHintDismissed).toBe(false)
  })

  it("dismissRtlHint sets rtlHintDismissed on __source", async () => {
    const doc = buildDoc()
    const { result } = renderHook(() => useFileMeta(doc, "he", "en"))
    await waitFor(() => expect(result.current.sourceTextDirection).toBe("rtl"))
    expect(result.current.rtlHintDismissed).toBe(false)
    act(() => { result.current.dismissRtlHint() })
    await waitFor(() => expect(result.current.rtlHintDismissed).toBe(true))
    const src = doc.getMap("meta").get("__source") as Record<string, unknown>
    expect(src.rtlHintDismissed).toBe(true)
  })
})
