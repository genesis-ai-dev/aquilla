/**
 * AQU-2678: the line before Target. happy-dom has no layout, so the overlay's
 * two measured areas are stubbed: Source (with any Bible columns) 500px and
 * Target 500px, side by side with the 8px gap, Target on the right in LTR and
 * on the left in RTL. The test reads what the divider writes: the split
 * variables on the table root, the handles' drag transform, aria values and
 * the stored split.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { EditorSplitDivider } from "./EditorSplitDivider"
import { editorSplitVars, readEditorSplit, writeEditorSplit } from "@/lib/editor/editor-split"
import {
  resetClientLocalStorageOwnerForTests,
  setClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"

function rect(left: number, width: number): DOMRect {
  return { left, right: left + width, width, top: 0, bottom: 10, height: 10, x: left, y: 0, toJSON: () => ({}) } as DOMRect
}

function Harness({ dir, bibleTracks = 0 }: { dir?: "rtl" | "ltr"; bibleTracks?: number }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const headerRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  return (
    <div dir={dir}>
      <div ref={rootRef} data-testid="root">
        <div ref={headerRef} data-testid="header" />
        <div ref={(el) => { scrollRef.current = el }} data-testid="scroller" />
        <EditorSplitDivider
          rootRef={rootRef}
          headerRef={headerRef}
          scrollRef={scrollRef}
          bibleTracks={bibleTracks}
          gridCols="md:grid-cols-[84px_minmax(0,var(--editor-rest-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]"
        />
      </div>
    </div>
  )
}

function rootVar(name: string): string {
  return screen.getByTestId("root").style.getPropertyValue(name)
}

const separator = () => screen.getByRole("separator")
const headerGrip = () => screen.getByTestId("editor-split-header-grip")

beforeEach(() => {
  setClientLocalStorageOwner("ana")
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const track = this.getAttribute("data-split-track")
    const rtl = this.closest("[dir]")?.getAttribute("dir") === "rtl"
    if (track === "rest") return rtl ? rect(608, 500) : rect(100, 500)
    if (track === "target") return rtl ? rect(100, 500) : rect(608, 500)
    return rect(0, 0)
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("EditorSplitDivider", () => {
  it("is a focusable vertical separator that starts on today's equal tracks", () => {
    render(<Harness />)
    const handle = separator()
    expect(handle.getAttribute("aria-orientation")).toBe("vertical")
    expect(handle.tabIndex).toBe(0)
    expect(handle.getAttribute("aria-valuenow")).toBe("50")
    expect(handle.getAttribute("aria-valuemin")).toBe("20")
    expect(handle.getAttribute("aria-valuemax")).toBe("80")
    expect(handle.getAttribute("aria-valuetext")).toBe("Source 50%, Target 50%")
    // Nothing saved: the variables stay unset, so the template's 1fr fallback is today's split.
    expect(rootVar("--editor-tgt-fr")).toBe("")
  })

  it("keeps the line visible on touch screens and the thin row handle scrollable", () => {
    render(<Harness />)
    const handle = separator()
    expect(handle.className).toContain("touch-pan-y")
    expect(handle.className).not.toContain("touch-none")
    expect(handle.querySelector("span")!.className).toContain("pointer-coarse:opacity-40")
    // The wide touch strip lives only in the column-header row.
    expect(handle.className).not.toMatch(/before:-inset/)
    expect(screen.getByTestId("header").contains(headerGrip())).toBe(true)
    expect(headerGrip().className).toContain("pointer-coarse:w-[26px]")
  })

  // Browser pass on 1fd9ed676: the line's layer is beside the list's
  // scroller, not inside it, so nothing scrolled under it.
  it("passes a wheel turn over the row line on to the list", () => {
    render(<Harness />)
    const scroller = screen.getByTestId("scroller")
    const scrollBy = vi.fn()
    scroller.scrollBy = scrollBy as never
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true })
    fireEvent.wheel(separator(), { deltaY: 120, deltaX: 0, deltaMode: 0 })
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 120, left: 0 })
    // Lines and pages are turned into pixels.
    fireEvent.wheel(separator(), { deltaY: 3, deltaMode: 1 })
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 48, left: 0 })
    fireEvent.wheel(separator(), { deltaY: 1, deltaMode: 2 })
    expect(scrollBy).toHaveBeenLastCalledWith({ top: 600, left: 0 })
  })

  it("leaves touches on the row line to the list (touch drags use the header grip)", () => {
    render(<Harness />)
    expect(separator().className).toContain("pointer-coarse:pointer-events-none")
    expect(headerGrip().className).not.toContain("pointer-events-none")
  })

  it("moves with the arrow keys (Shift for bigger steps), saving as it goes", () => {
    render(<Harness />)
    const handle = separator()
    fireEvent.keyDown(handle, { key: "ArrowLeft" })
    expect(readEditorSplit()).toBeCloseTo(0.516)
    expect(rootVar("--editor-tgt-fr")).toBe("1.032fr")
    expect(rootVar("--editor-rest-fr")).toBe("0.968fr")
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true })
    expect(readEditorSplit()).toBeCloseTo(0.452)
    expect(handle.getAttribute("aria-valuenow")).toBe("45")
    expect(handle.getAttribute("aria-valuetext")).toBe("Source 55%, Target 45%")
  })

  it("mirrors the arrows in RTL, where Target is on the left", () => {
    render(<Harness dir="rtl" />)
    fireEvent.keyDown(separator(), { key: "ArrowRight" })
    expect(readEditorSplit()).toBeCloseTo(0.516)
  })

  it("resets to today's split on Home, Escape, double-click and double tap", () => {
    for (const reset of [
      (h: HTMLElement) => fireEvent.keyDown(h, { key: "Home" }),
      (h: HTMLElement) => fireEvent.keyDown(h, { key: "Escape" }),
      (h: HTMLElement) => fireEvent.doubleClick(h),
      (h: HTMLElement) => {
        for (let i = 0; i < 2; i += 1) {
          fireEvent.pointerDown(h, { button: 0, pointerId: i + 1, clientX: 604, pointerType: "touch" })
          fireEvent.pointerUp(h, { pointerId: i + 1, clientX: 604, pointerType: "touch" })
        }
      },
    ]) {
      writeEditorSplit(0.7)
      render(<Harness />)
      const handle = separator()
      expect(rootVar("--editor-tgt-fr")).toBe("1.4fr")
      reset(handle)
      expect(readEditorSplit()).toBeNull()
      expect(rootVar("--editor-tgt-fr")).toBe("")
      expect(handle.getAttribute("aria-valuenow")).toBe("50")
      cleanup()
    }
  })

  it("moves only the line while dragging, and writes the columns once on release, in RTL too", () => {
    render(<Harness dir="rtl" />)
    const handle = separator()
    // RTL: Target ends at x=100, its start (and the line) at 604.
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 604, pointerType: "touch" })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 504, pointerType: "touch" })
    // No column change mid-drag: just the line, 100px to the left, in both rows and header.
    expect(rootVar("--editor-tgt-fr")).toBe("")
    expect(handle.style.transform).toBe("translateX(-100px)")
    expect(headerGrip().style.transform).toBe("translateX(-100px)")
    expect(handle.getAttribute("data-separator")).toBe("active")
    expect(readEditorSplit()).toBeNull()
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 504, pointerType: "touch" })
    expect(readEditorSplit()).toBeCloseTo(0.4)
    expect(rootVar("--editor-tgt-fr")).toBe("0.8fr")
    expect(handle.style.transform).toBe("")
    expect(handle.getAttribute("data-separator")).toBeNull()
  })

  it("drags from the header grip too", () => {
    render(<Harness />)
    fireEvent.pointerDown(headerGrip(), { button: 0, pointerId: 1, clientX: 604, pointerType: "mouse" })
    fireEvent.pointerMove(headerGrip(), { pointerId: 1, clientX: 404, pointerType: "mouse" })
    fireEvent.pointerUp(headerGrip(), { pointerId: 1, clientX: 404, pointerType: "mouse" })
    // LTR: Target ends at 1108; line at 404 → Target 700px of 1000, clamped to 0.7 (max 0.8).
    expect(readEditorSplit()).toBeCloseTo(0.7)
  })

  it("ends a drag whose pointer capture is lost", () => {
    render(<Harness />)
    const handle = separator()
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 604 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 504 })
    fireEvent(handle, new Event("lostpointercapture"))
    expect(handle.getAttribute("data-separator")).toBeNull()
    expect(handle.style.transform).toBe("")
    expect(readEditorSplit()).toBeCloseTo(0.6)
  })

  it("drops a drag cleanly when the minimums stop fitting mid-drag", () => {
    const { rerender } = render(<Harness />)
    fireEvent.pointerDown(separator(), { button: 0, pointerId: 1, clientX: 604 })
    fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 504 })
    // Four Bible columns: six tracks need 1200px, more than there is.
    rerender(<Harness bibleTracks={4} />)
    expect(screen.queryByRole("separator")).toBeNull()
    rerender(<Harness />)
    const handle = separator()
    expect(handle.getAttribute("data-separator")).toBeNull()
    expect(handle.style.transform).toBe("")
    expect(rootVar("--editor-tgt-fr")).toBe("")
    expect(readEditorSplit()).toBeNull()
  })

  it("splits what Target leaves equally across Source and the Bible columns", () => {
    render(<Harness bibleTracks={1} />)
    // 500px of Source + Bible (less one gap) + 500px Target = 992px, three tracks.
    const handle = separator()
    expect(handle.getAttribute("aria-valuenow")).toBe("33")
    expect(headerGrip().style.gridColumn).toBe("4")
    act(() => {
      fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true })
    })
    const share = readEditorSplit()!
    expect(share).toBeCloseTo(1 / 3 + 64 / 992)
    const vars = editorSplitVars(share, 3)!
    expect(rootVar("--editor-tgt-fr")).toBe(vars.target)
    expect(rootVar("--editor-rest-fr")).toBe(vars.rest)
    // Target 1/3 + 64/992 ≈ 0.398 → 1.19fr; Source and the Bible 0.90fr each: still 3fr in all.
    expect(parseFloat(vars.target) + 2 * parseFloat(vars.rest)).toBeCloseTo(3, 3)
  })

  it("clamps a saved split that no longer fits, and hides when the minimums cannot fit", () => {
    writeEditorSplit(0.95)
    const { unmount } = render(<Harness />)
    expect(rootVar("--editor-tgt-fr")).toBe("1.6fr") // clamped to 0.8
    expect(readEditorSplit()).toBe(0.95) // kept for a wider screen
    unmount()

    render(<Harness bibleTracks={4} />)
    expect(screen.queryByRole("separator")).toBeNull()
    expect(screen.queryByTestId("editor-split-header-grip")).toBeNull()
    expect(rootVar("--editor-tgt-fr")).toBe("")
  })
})
