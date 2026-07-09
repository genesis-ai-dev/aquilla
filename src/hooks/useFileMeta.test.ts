// Phase 2b tests for useFileMeta — moved off Y.Doc onto localStorage.

import "fake-indexeddb/auto"
import { beforeEach, describe, expect, it } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useFileMeta } from "./useFileMeta"

beforeEach(() => {
  window.localStorage.clear()
})

describe("useFileMeta (Phase 2b, localStorage-backed)", () => {
  it("returns defaults when localStorage has nothing set", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "en", "en"))
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(true))
    expect(result.current.sourceDirectionMode).toBe("auto")
    expect(result.current.targetDirectionMode).toBe("auto")
    expect(result.current.sourceTextDirection).toBe("ltr")
    expect(result.current.targetTextDirection).toBe("ltr")
    expect(result.current.rtlHintDismissed).toBe(true)
  })

  it("auto-detects targetTextDirection from targetLanguage", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "en", "ar"))
    await waitFor(() => expect(result.current.targetTextDirection).toBe("rtl"))
  })

  it("auto-detects sourceTextDirection from sourceLanguage", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "he", "en"))
    await waitFor(() => expect(result.current.sourceTextDirection).toBe("rtl"))
    expect(result.current.targetTextDirection).toBe("ltr")
  })

  it("handles mixed directions — source rtl + target ltr", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "ar", "fr"))
    await waitFor(() => {
      expect(result.current.sourceTextDirection).toBe("rtl")
      expect(result.current.targetTextDirection).toBe("ltr")
    })
  })

  it("setTargetTextDirection persists and reflects on rerender", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "en", "en"))
    act(() => { result.current.setTargetTextDirection("rtl") })
    await waitFor(() => expect(result.current.targetTextDirection).toBe("rtl"))
    expect(result.current.targetDirectionMode).toBe("rtl")
    // Re-mount: localStorage should preserve the value.
    const { result: result2 } = renderHook(() => useFileMeta("file-a", "en", "en"))
    await waitFor(() => expect(result2.current.targetTextDirection).toBe("rtl"))
    expect(result2.current.targetDirectionMode).toBe("rtl")
  })

  it("setTargetDirectionMode can return to auto after a manual override", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "en", "ar"))
    await waitFor(() => expect(result.current.targetTextDirection).toBe("rtl"))
    act(() => { result.current.setTargetDirectionMode("ltr") })
    await waitFor(() => expect(result.current.targetTextDirection).toBe("ltr"))
    act(() => { result.current.setTargetDirectionMode("auto") })
    await waitFor(() => expect(result.current.targetTextDirection).toBe("rtl"))
    expect(result.current.targetDirectionMode).toBe("auto")
  })

  it("migrates legacy direction localStorage as a manual override", async () => {
    window.localStorage.setItem("codex:file-meta:file-a:targetDir", "rtl")
    const { result } = renderHook(() => useFileMeta("file-a", "en", "en"))
    await waitFor(() => expect(result.current.targetDirectionMode).toBe("rtl"))
    expect(result.current.targetTextDirection).toBe("rtl")
  })

  it("setLineNumbersEnabled persists and reflects on rerender", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "en", "en"))
    act(() => { result.current.setLineNumbersEnabled(false) })
    await waitFor(() => expect(result.current.lineNumbersEnabled).toBe(false))
    const { result: result2 } = renderHook(() => useFileMeta("file-a", "en", "en"))
    await waitFor(() => expect(result2.current.lineNumbersEnabled).toBe(false))
  })

  it("dismissRtlHint sets rtlHintDismissed", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "he", "en"))
    await waitFor(() => expect(result.current.sourceTextDirection).toBe("rtl"))
    expect(result.current.rtlHintDismissed).toBe(false)
    act(() => { result.current.dismissRtlHint() })
    await waitFor(() => expect(result.current.rtlHintDismissed).toBe(true))
  })

  it("returns sane defaults for null fileId", () => {
    const { result } = renderHook(() => useFileMeta(null, "en", "en"))
    expect(result.current.lineNumbersEnabled).toBe(true)
    expect(result.current.sourceTextDirection).toBe("ltr")
    expect(result.current.targetTextDirection).toBe("ltr")
    expect(result.current.rtlHintDismissed).toBe(true)
  })

  it("uses file-level direction hints before language fallback", async () => {
    const { result } = renderHook(() => useFileMeta("file-a", "en", "en", { targetTextDirection: "rtl" }))
    await waitFor(() => expect(result.current.targetTextDirection).toBe("rtl"))
    expect(result.current.targetDirectionMode).toBe("auto")
  })

  it("scopes preferences by fileId — different files keep separate state", async () => {
    const { result: rA } = renderHook(() => useFileMeta("file-a", "en", "en"))
    act(() => { rA.current.setLineNumbersEnabled(false) })
    await waitFor(() => expect(rA.current.lineNumbersEnabled).toBe(false))
    const { result: rB } = renderHook(() => useFileMeta("file-b", "en", "en"))
    await waitFor(() => expect(rB.current.lineNumbersEnabled).toBe(true))
  })
})
