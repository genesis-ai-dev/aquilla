import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { I18nProvider, useI18n } from "@/lib/i18n/I18nProvider"
import { AgentContextPane } from "./AgentContextPane"
import { AgentDocumentContext, type AgentDocumentContextProps } from "./AgentDocumentContext"

function workspace(): AgentDocumentContextProps["workspace"] {
  return {
    fileName: "Mark.md",
    sourceLanguage: "English",
    targetLanguage: "Italian",
    cells: [
      { cellId: "c1", fileId: "f1", ref: "MRK 1:1", source: "The beginning", sourceHtml: "<p>The <strong>beginning</strong></p>", target: "L'inizio", targetHtml: "<p>L'<em>inizio</em></p>" },
      { cellId: "c2", fileId: "f1", ref: "MRK 1:2", source: "A much longer passage.\n".repeat(12), target: "Una frase." },
      { cellId: "c3", fileId: "f1", ref: "MRK 1:3", source: "Short source.", target: "Una traduzione più lunga.\n".repeat(20) },
    ],
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function mockGeometry() {
  const bounds = new Map([["c1", [0, 100]], ["c2", [100, 400]], ["c3", [400, 650]]])
  const viewport = { height: 150 }
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === "document-context-scroll") {
      return { top: 0, bottom: viewport.height, height: viewport.height, width: 800 } as DOMRect
    }
    const [top, bottom] = bounds.get(this.dataset.cellId ?? "") ?? [0, 0]
    const offset = this.closest('[data-testid="document-context-scroll"]')?.scrollTop ?? 0
    return { top: top - offset, bottom: bottom - offset, height: bottom - top, width: 800 } as DOMRect
  })
  let resize = () => {}
  const observe = vi.fn()
  const disconnect = vi.fn()
  const observer = vi.fn(function (callback: () => void) {
    resize = callback
    return { observe, disconnect, unobserve: vi.fn() }
  })
  vi.stubGlobal("ResizeObserver", observer)
  return { bounds, viewport, observe, disconnect, observer, resize: () => act(() => resize()) }
}

describe("AgentDocumentContext paired document", () => {
  it("gives each variable-length source/target pair one grid row in a shared scroll owner", () => {
    const view = render(<AgentDocumentContext workspace={workspace()} />)
    const root = screen.getByTestId("agent-document-context")
    const scroll = screen.getByTestId("document-context-scroll")
    const pairs = within(scroll).getAllByRole("article")
    expect(root).toHaveClass("@container")
    expect(scroll).toHaveClass("overflow-y-auto")
    expect(pairs).toHaveLength(3)
    expect(root.querySelectorAll('[class*="overflow-y-auto"]')).toHaveLength(1)
    expect(screen.queryByTestId("source-context-scroll")).not.toBeInTheDocument()
    expect(screen.queryByTestId("target-context-scroll")).not.toBeInTheDocument()
    for (const [index, pair] of pairs.entries()) {
      expect(pair).toHaveAttribute("data-cell-id", `c${index + 1}`)
      expect(pair).toHaveClass("grid", "grid-cols-1", "@min-[36rem]:grid-cols-2", "items-stretch")
      expect(pair.children).toHaveLength(2)
      expect(pair.children[0]).toHaveAttribute("data-editor-cell-surface", "source")
      expect(pair.children[1]).toHaveAttribute("data-editor-cell-surface", "target-column")
    }
    expect(pairs[0].querySelector("strong")).toHaveTextContent("beginning")
    expect(pairs[0].querySelector("em")).toHaveTextContent("inizio")
    expect(pairs[1]).toHaveTextContent("A much longer passage.")
    expect(pairs[2]).toHaveTextContent("Una traduzione più lunga.")
    expect(view.container.querySelector(".ProseMirror")).not.toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Mark.md" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Source · English" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Target · Italian" })).toBeInTheDocument()
    expect(screen.getByText("3 cells")).toBeInTheDocument()
  })

  it("reuses pane content without reserving action or absent validation gutters in the text lane", () => {
    const data = workspace()
    const view = render(<AgentDocumentContext workspace={{ ...data, onOpenHistory: vi.fn() }} />)
    const pairedReadHtml = screen.getAllByRole("textbox")[0].innerHTML
    const target = view.container.querySelector('[data-editor-cell-surface="target-column"]')!
    expect(target).not.toHaveClass("pr-9")
    expect(target).toHaveClass("px-2")
    expect(screen.queryByTestId("validation-gutter")).not.toBeInTheDocument()
    const rail = target.querySelector('[data-slot="cell-action-rail"]')!
    expect(rail.closest('[data-testid="target-header-lane"]')).not.toBeNull()
    expect(rail.parentElement).toHaveClass("[&_button]:min-h-6", "[&_button]:min-w-6")
    view.unmount()
    render(<AgentContextPane kind="target" {...data} />)
    expect(screen.getAllByRole("textbox")[0].innerHTML).toBe(pairedReadHtml)
    expect(screen.getByTestId("target-context-scroll")).toHaveClass("overflow-y-auto")
  })

  it("reports intersecting paired rows once, without callback-churn or streaming empty scopes", () => {
    const geometry = mockGeometry()
    const callback = vi.fn()
    const data = { ...workspace(), onVisibleCellIdsChange: callback }
    const view = render(<AgentDocumentContext workspace={data} />)
    expect(callback).toHaveBeenCalledExactlyOnceWith(["c1", "c2"])
    expect(geometry.observer).toHaveBeenCalledTimes(1)
    expect(geometry.observe).toHaveBeenCalledTimes(2)
    const scroll = screen.getByTestId("document-context-scroll")
    fireEvent.scroll(scroll)
    geometry.resize()
    expect(callback).toHaveBeenCalledTimes(1)

    view.rerender(<AgentDocumentContext workspace={{ ...data, cells: data.cells.map((cell) => ({ ...cell, target: `${cell.target} More` })) }} />)
    expect(callback).toHaveBeenCalledTimes(1)
    const nextCallback = vi.fn()
    view.rerender(<AgentDocumentContext workspace={{ ...data, onVisibleCellIdsChange: nextCallback }} />)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(nextCallback).toHaveBeenCalledExactlyOnceWith(["c1", "c2"])
    scroll.scrollTop = 100
    fireEvent.scroll(scroll)
    expect(nextCallback).toHaveBeenLastCalledWith(["c2"])
    geometry.bounds.set("c2", [100, 120])
    geometry.bounds.set("c3", [120, 400])
    geometry.resize()
    expect(nextCallback).toHaveBeenLastCalledWith(["c2", "c3"])
    const reportCount = nextCallback.mock.calls.length
    view.unmount()
    expect(nextCallback).toHaveBeenCalledTimes(reportCount)
    expect(nextCallback.mock.calls.every(([ids]) => ids.length > 0)).toBe(true)
    expect(geometry.disconnect).toHaveBeenCalledOnce()
  })

  it("does not interpret an unmeasured document as empty and navigates once geometry is available", () => {
    const geometry = mockGeometry()
    geometry.viewport.height = 0
    const callback = vi.fn()
    render(<AgentDocumentContext workspace={{ ...workspace(), focusedCellId: "c3", onVisibleCellIdsChange: callback }} />)
    expect(callback).not.toHaveBeenCalled()
    geometry.viewport.height = 150
    geometry.resize()
    expect(screen.getByTestId("document-context-scroll").scrollTop).toBe(400)
    expect(callback).toHaveBeenCalledExactlyOnceWith(["c3"])
  })

  it("scrolls to initial/changed requested cells but does not reset user scrolling on live updates", () => {
    mockGeometry()
    const callback = vi.fn()
    const data = { ...workspace(), focusedCellId: "c3", onVisibleCellIdsChange: callback }
    const view = render(<AgentDocumentContext workspace={data} />)
    const scroll = screen.getByTestId("document-context-scroll")
    expect(scroll.scrollTop).toBe(400)
    expect(callback).toHaveBeenLastCalledWith(["c3"])
    scroll.scrollTop = 0
    fireEvent.scroll(scroll)
    view.rerender(<AgentDocumentContext workspace={{ ...data, cells: [...data.cells] }} />)
    expect(scroll.scrollTop).toBe(0)
    view.rerender(<AgentDocumentContext workspace={{ ...data, focusedCellId: "c2" }} />)
    expect(scroll.scrollTop).toBe(100)
    expect(callback).toHaveBeenLastCalledWith(["c2"])
  })

  it("exposes row focus and preserves keyboard action access after the pointer leaves", () => {
    const onFocus = vi.fn()
    render(<AgentDocumentContext workspace={{ ...workspace(), onOpenHistory: vi.fn() }} onFocusedCellIdChange={onFocus} />)
    const row = screen.getByRole("article", { name: "MRK 1:2" })
    act(() => row.focus())
    expect(row).toHaveAttribute("data-focused", "true")
    expect(onFocus).toHaveBeenCalledExactlyOnceWith("c2")
    const button = within(row).getByRole("button", { name: "Edit history" })
    act(() => button.focus())
    fireEvent.mouseLeave(row)
    expect(row.querySelector('[data-slot="cell-action-rail"]')).toHaveAttribute("data-revealed", "true")
    expect(onFocus).toHaveBeenCalledTimes(1)
  })

  it("reports a genuinely empty file once and keeps loading/choose-file states useful", () => {
    mockGeometry()
    const callback = vi.fn()
    const onChooseFile = vi.fn()
    const data = { ...workspace(), onVisibleCellIdsChange: callback }
    const view = render(<AgentDocumentContext workspace={data} onChooseFile={onChooseFile} />)
    view.rerender(<AgentDocumentContext workspace={{ ...data, cells: [], loading: true }} onChooseFile={onChooseFile} />)
    expect(callback).toHaveBeenLastCalledWith([])
    expect(screen.getByTestId("agent-document-context")).toHaveAttribute("aria-busy", "true")
    expect(screen.queryByRole("button", { name: "Choose file" })).not.toBeInTheDocument()
    view.rerender(<AgentDocumentContext workspace={{ ...data, cells: [], scopeAvailable: false, fileName: null }} onChooseFile={onChooseFile} />)
    fireEvent.click(screen.getByRole("button", { name: "Choose file" }))
    expect(onChooseFile).toHaveBeenCalledOnce()
    view.unmount()
    expect(callback.mock.calls.filter(([ids]) => ids.length === 0)).toHaveLength(1)
  })

  it("localizes the count instead of appending an English plural", () => {
    function LocaleControl() {
      const { setLocale } = useI18n()
      return <button onClick={() => setLocale("zh-Hans")}>Chinese</button>
    }
    render(<I18nProvider><LocaleControl /><AgentDocumentContext workspace={workspace()} /></I18nProvider>)
    fireEvent.click(screen.getByRole("button", { name: "Chinese" }))
    expect(screen.getByText("3 个单元格")).toBeInTheDocument()
  })
})
