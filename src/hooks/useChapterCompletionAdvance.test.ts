import { describe, expect, it, vi, beforeEach } from "vitest"
import { renderHook } from "@testing-library/react"
import { toast } from "@/components/ui/toast"
import {
  CHAPTER_COMPLETE_TOAST_ID,
  useChapterCompletionAdvance,
} from "./useChapterCompletionAdvance"

vi.mock("@/components/ui/toast", () => ({
  toast: {
    add: vi.fn(),
    close: vi.fn(),
  },
}))

type TestCell = { original: string; translated: string; status: string }
const translated: TestCell = { original: "In the beginning", translated: "Au commencement", status: "unvalidated" }
const empty: TestCell = { original: "the earth", translated: "", status: "empty" }

describe("useChapterCompletionAdvance", () => {
  beforeEach(() => {
    vi.mocked(toast.add).mockImplementation((options) => (
      typeof options.id === "string" ? options.id : "toast"
    ))
    vi.mocked(toast.add).mockClear()
    vi.mocked(toast.close).mockClear()
  })

  it("offers the next chapter when the open page is already complete", () => {
    const onAdvance = vi.fn()
    renderHook(() => useChapterCompletionAdvance({
      enabled: true,
      fileId: "file-1",
      pageKey: "scripture:GEN:1",
      currentLabel: "Genesis 1",
      next: { key: "scripture:GEN:2", label: "Genesis 2" },
      trigger: "allTranslated",
      action: "prompt",
      cells: [translated],
      onAdvance,
    }))

    expect(toast.add).toHaveBeenCalledTimes(1)
    const options = vi.mocked(toast.add).mock.calls[0]![0] as {
      id?: string
      title: string
      actionProps: { children: string; onClick: () => void }
    }
    expect(options.id).toBe(CHAPTER_COMPLETE_TOAST_ID)
    expect(options.title).toBe("Genesis 1 is complete")
    expect(options.actionProps.children).toBe("Next chapter")
    options.actionProps.onClick()
    expect(onAdvance).toHaveBeenCalledWith("scripture:GEN:2", undefined)
    expect(toast.close).not.toHaveBeenCalled()
  })

  it("retitles the same toast when the next chapter is also complete", () => {
    const { rerender } = renderHook(
      ({ pageKey, currentLabel, next }) => useChapterCompletionAdvance({
        enabled: true,
        fileId: "file-1",
        pageKey,
        currentLabel,
        next,
        trigger: "allTranslated",
        action: "prompt",
        cells: [translated],
        onAdvance: vi.fn(),
      }),
      {
        initialProps: {
          pageKey: "scripture:GEN:1",
          currentLabel: "Genesis 1",
          next: { key: "scripture:GEN:2", label: "Genesis 2" },
        },
      },
    )

    rerender({
      pageKey: "scripture:GEN:2",
      currentLabel: "Genesis 2",
      next: { key: "scripture:GEN:3", label: "Genesis 3" },
    })

    expect(toast.close).not.toHaveBeenCalled()
    expect(toast.add).toHaveBeenCalledTimes(2)
    expect(vi.mocked(toast.add).mock.calls[0]![0]).toMatchObject({
      id: CHAPTER_COMPLETE_TOAST_ID,
      title: "Genesis 1 is complete",
      data: { pulse: false },
    })
    expect(vi.mocked(toast.add).mock.calls[1]![0]).toMatchObject({
      id: CHAPTER_COMPLETE_TOAST_ID,
      title: "Genesis 2 is complete",
      data: { pulse: false },
    })
  })

  it("dismisses the toast when the next chapter is not complete", () => {
    const { rerender } = renderHook(
      ({ pageKey, currentLabel, next, cells }) => useChapterCompletionAdvance({
        enabled: true,
        fileId: "file-1",
        pageKey,
        currentLabel,
        next,
        trigger: "allTranslated",
        action: "prompt",
        cells,
        onAdvance: vi.fn(),
      }),
      {
        initialProps: {
          pageKey: "scripture:GEN:1",
          currentLabel: "Genesis 1",
          next: { key: "scripture:GEN:2", label: "Genesis 2" },
          cells: [translated],
        },
      },
    )

    rerender({
      pageKey: "scripture:GEN:2",
      currentLabel: "Genesis 2",
      next: { key: "scripture:GEN:3", label: "Genesis 3" },
      cells: [empty],
    })

    expect(toast.add).toHaveBeenCalledTimes(1)
    expect(toast.close).toHaveBeenCalledWith(CHAPTER_COMPLETE_TOAST_ID)
  })

  it("does not auto-advance a chapter that was already complete on first look", () => {
    const onAdvance = vi.fn()
    renderHook(() => useChapterCompletionAdvance({
      enabled: true,
      fileId: "file-1",
      pageKey: "scripture:GEN:1",
      currentLabel: "Genesis 1",
      next: { key: "scripture:GEN:2", label: "Genesis 2" },
      trigger: "allTranslated",
      action: "autoAdvance",
      cells: [translated],
      onAdvance,
    }))

    expect(onAdvance).not.toHaveBeenCalled()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("auto-advances on the rising edge from incomplete to complete", () => {
    const onAdvance = vi.fn()
    const { rerender } = renderHook(
      ({ cells }) => useChapterCompletionAdvance({
        enabled: true,
        fileId: "file-1",
        pageKey: "scripture:GEN:1",
        currentLabel: "Genesis 1",
        next: { key: "scripture:GEN:2", label: "Genesis 2" },
        trigger: "allTranslated",
        action: "autoAdvance",
        cells,
        onAdvance,
      }),
      { initialProps: { cells: [empty] } },
    )

    expect(onAdvance).not.toHaveBeenCalled()
    rerender({ cells: [translated] })
    expect(onAdvance).toHaveBeenCalledWith("scripture:GEN:2", undefined)
  })

  it("stays silent when the action is stay", () => {
    renderHook(() => useChapterCompletionAdvance({
      enabled: true,
      fileId: "file-1",
      pageKey: "scripture:GEN:1",
      currentLabel: "Genesis 1",
      next: { key: "scripture:GEN:2", label: "Genesis 2" },
      trigger: "allTranslated",
      action: "stay",
      cells: [translated],
      onAdvance: vi.fn(),
    }))

    expect(toast.add).not.toHaveBeenCalled()
  })

  it("does not auto-advance when rows hydrate already complete", () => {
    const onAdvance = vi.fn()
    const { rerender } = renderHook(
      ({ cells }) => useChapterCompletionAdvance({
        enabled: true,
        fileId: "file-1",
        pageKey: "scripture:GEN:1",
        currentLabel: "Genesis 1",
        next: { key: "scripture:GEN:2", label: "Genesis 2" },
        trigger: "allTranslated",
        action: "autoAdvance",
        cells,
        onAdvance,
      }),
      { initialProps: { cells: [] as typeof translated[] } },
    )

    expect(onAdvance).not.toHaveBeenCalled()
    rerender({ cells: [translated] })
    expect(onAdvance).not.toHaveBeenCalled()
    expect(toast.add).not.toHaveBeenCalled()
  })

  it("does not prompt on the last chapter", () => {
    renderHook(() => useChapterCompletionAdvance({
      enabled: true,
      fileId: "file-1",
      pageKey: "scripture:GEN:50",
      currentLabel: "Genesis 50",
      next: null,
      trigger: "allTranslated",
      action: "prompt",
      cells: [translated],
      onAdvance: vi.fn(),
    }))

    expect(toast.add).not.toHaveBeenCalled()
  })
})
