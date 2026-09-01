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

const translated = { original: "In the beginning", translated: "Au commencement", status: "unvalidated" as const }
const empty = { original: "the earth", translated: "", status: "empty" as const }

const base = {
  enabled: true,
  fileId: "file-1",
  pageKey: "scripture:GEN:1",
  currentLabel: "Genesis 1",
  next: { key: "scripture:GEN:2", label: "Genesis 2" } as const,
  trigger: "allTranslated" as const,
}

describe("useChapterCompletionAdvance", () => {
  beforeEach(() => {
    vi.mocked(toast.add).mockImplementation((options) => (
      typeof options.id === "string" ? options.id : "toast"
    ))
    vi.mocked(toast.add).mockClear()
    vi.mocked(toast.close).mockClear()
  })

  it("does not prompt when the open page is already complete", () => {
    renderHook(() => useChapterCompletionAdvance({
      ...base,
      action: "prompt",
      cells: [translated],
      onAdvance: vi.fn(),
    }))

    expect(toast.add).not.toHaveBeenCalled()
  })

  it("prompts on the rising edge from incomplete to complete", () => {
    const onAdvance = vi.fn()
    const { rerender } = renderHook(
      ({ cells }) => useChapterCompletionAdvance({
        ...base,
        action: "prompt",
        cells,
        onAdvance,
      }),
      { initialProps: { cells: [empty] } },
    )

    expect(toast.add).not.toHaveBeenCalled()
    rerender({ cells: [translated] })
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
  })

  it("does not prompt again when navigating onto an already complete chapter", () => {
    const { rerender } = renderHook(
      ({ pageKey, currentLabel, next, cells }) => useChapterCompletionAdvance({
        ...base,
        pageKey,
        currentLabel,
        next,
        action: "prompt",
        cells,
        onAdvance: vi.fn(),
      }),
      {
        initialProps: {
          pageKey: "scripture:GEN:1",
          currentLabel: "Genesis 1",
          next: { key: "scripture:GEN:2", label: "Genesis 2" },
          cells: [empty],
        },
      },
    )

    rerender({
      pageKey: "scripture:GEN:1",
      currentLabel: "Genesis 1",
      next: { key: "scripture:GEN:2", label: "Genesis 2" },
      cells: [translated],
    })
    expect(toast.add).toHaveBeenCalledTimes(1)

    rerender({
      pageKey: "scripture:GEN:2",
      currentLabel: "Genesis 2",
      next: { key: "scripture:GEN:3", label: "Genesis 3" },
      cells: [translated],
    })
    expect(toast.add).toHaveBeenCalledTimes(1)
    expect(toast.close).toHaveBeenCalledWith(CHAPTER_COMPLETE_TOAST_ID)
  })

  it("dismisses the toast when leaving for an incomplete chapter", () => {
    const { rerender } = renderHook(
      ({ pageKey, currentLabel, next, cells }) => useChapterCompletionAdvance({
        ...base,
        pageKey,
        currentLabel,
        next,
        action: "prompt",
        cells,
        onAdvance: vi.fn(),
      }),
      {
        initialProps: {
          pageKey: "scripture:GEN:1",
          currentLabel: "Genesis 1",
          next: { key: "scripture:GEN:2", label: "Genesis 2" },
          cells: [empty],
        },
      },
    )

    rerender({
      pageKey: "scripture:GEN:1",
      currentLabel: "Genesis 1",
      next: { key: "scripture:GEN:2", label: "Genesis 2" },
      cells: [translated],
    })
    expect(toast.add).toHaveBeenCalledTimes(1)

    rerender({
      pageKey: "scripture:GEN:2",
      currentLabel: "Genesis 2",
      next: { key: "scripture:GEN:3", label: "Genesis 3" },
      cells: [empty],
    })
    expect(toast.close).toHaveBeenCalledWith(CHAPTER_COMPLETE_TOAST_ID)
  })

  it("does not auto-advance a chapter that was already complete on first look", () => {
    const onAdvance = vi.fn()
    renderHook(() => useChapterCompletionAdvance({
      ...base,
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
        ...base,
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
    const { rerender } = renderHook(
      ({ cells }) => useChapterCompletionAdvance({
        ...base,
        action: "stay",
        cells,
        onAdvance: vi.fn(),
      }),
      { initialProps: { cells: [empty] } },
    )
    rerender({ cells: [translated] })

    expect(toast.add).not.toHaveBeenCalled()
  })

  it("does not auto-advance when rows hydrate already complete", () => {
    const onAdvance = vi.fn()
    const { rerender } = renderHook(
      ({ cells }) => useChapterCompletionAdvance({
        ...base,
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
    const { rerender } = renderHook(
      ({ cells }) => useChapterCompletionAdvance({
        ...base,
        pageKey: "scripture:GEN:50",
        currentLabel: "Genesis 50",
        next: null,
        action: "prompt",
        cells,
        onAdvance: vi.fn(),
      }),
      { initialProps: { cells: [empty] } },
    )
    rerender({ cells: [translated] })

    expect(toast.add).not.toHaveBeenCalled()
  })
})
