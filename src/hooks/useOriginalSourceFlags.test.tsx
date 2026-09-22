import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { FileReference } from "@/lib/parsers/types"
import type { FileSummary } from "@/lib/sync/cells-read-types"
import { fetchProjectFiles } from "@/lib/sync/cells-read"
import { __resetOriginalSourceFlagsCache, useOriginalSourceFlags } from "./useOriginalSourceFlags"

vi.mock("@/lib/sync/cells-read", () => ({
  fetchProjectFiles: vi.fn(),
}))

const listFiles = vi.mocked(fetchProjectFiles)

function summary(fileId: string, hasOriginalSource: boolean): FileSummary {
  return {
    fileId,
    projectId: "p1",
    name: fileId,
    fileType: "codex",
    sourceLanguage: "en",
    targetLanguage: "fr",
    cellCount: 10,
    approvedCount: 0,
    filledCount: 0,
    wordCount: 0,
    lastEditAt: null,
    hasOriginalSource,
  }
}

function reference(id: string): FileReference {
  return { id, name: id } as FileReference
}

const files = [reference("GEN"), reference("EXO")]
const getToken = async () => "jwt"

describe("useOriginalSourceFlags (AQU-350)", () => {
  beforeEach(() => {
    __resetOriginalSourceFlagsCache()
    listFiles.mockReset()
    listFiles.mockResolvedValue([summary("GEN", true), summary("EXO", false)])
  })
  afterEach(() => {
    __resetOriginalSourceFlagsCache()
  })

  it("lists the project corpus once, then serves a remount from cache", async () => {
    const first = renderHook(() => useOriginalSourceFlags("p1", files, getToken))
    await waitFor(() => expect(first.result.current.has("GEN")).toBe(true))
    expect(listFiles).toHaveBeenCalledTimes(1)

    // A dock-tab switch unmounts the Files panel and mounts it again.
    first.unmount()
    const second = renderHook(() => useOriginalSourceFlags("p1", files, getToken))

    expect(listFiles).toHaveBeenCalledTimes(1)
    // Cached flags are on screen immediately — no loading gap on the remount.
    expect(second.result.current.has("GEN")).toBe(true)
    expect(second.result.current.has("EXO")).toBe(false)
  })

  it("coalesces concurrent instances of the hook into one request", async () => {
    const a = renderHook(() => useOriginalSourceFlags("p1", files, getToken))
    const b = renderHook(() => useOriginalSourceFlags("p1", files, getToken))

    await waitFor(() => expect(a.result.current.has("GEN")).toBe(true))
    await waitFor(() => expect(b.result.current.has("GEN")).toBe(true))
    expect(listFiles).toHaveBeenCalledTimes(1)
  })

  it("re-lists when the project's file set changes", async () => {
    const { result, rerender } = renderHook(
      ({ list }: { list: FileReference[] }) => useOriginalSourceFlags("p1", list, getToken),
      { initialProps: { list: files } },
    )
    await waitFor(() => expect(result.current.has("GEN")).toBe(true))
    expect(listFiles).toHaveBeenCalledTimes(1)

    listFiles.mockResolvedValue([
      summary("GEN", true), summary("EXO", false), summary("LEV", true),
    ])
    rerender({ list: [...files, reference("LEV")] })

    await waitFor(() => expect(result.current.has("LEV")).toBe(true))
    expect(listFiles).toHaveBeenCalledTimes(2)
  })

  it("still merges optimistic flags from just-imported files", async () => {
    const justImported = { ...reference("NUM"), hasOriginalSource: true } as FileReference
    const { result } = renderHook(
      () => useOriginalSourceFlags("p1", [...files, justImported], getToken),
    )
    expect(result.current.has("NUM")).toBe(true)
    await waitFor(() => expect(result.current.has("GEN")).toBe(true))
    expect(result.current.has("NUM")).toBe(true)
  })

  it("does not cache a failed listing", async () => {
    listFiles.mockRejectedValueOnce(new Error("offline"))
    const first = renderHook(() => useOriginalSourceFlags("p1", files, getToken))
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1))
    first.unmount()

    const second = renderHook(() => useOriginalSourceFlags("p1", files, getToken))
    await waitFor(() => expect(second.result.current.has("GEN")).toBe(true))
    expect(listFiles).toHaveBeenCalledTimes(2)
  })
})
