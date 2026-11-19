/**
 * AQU-2678: the Source/Target divider. happy-dom has no layout, so the two
 * tracks' widths are stubbed (500px each, Source starting at x=100) and the
 * test reads what the divider writes: the two split variables on the table
 * root, its aria values, and the stored split.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { EditorSplitDivider } from "./EditorSplitDivider"
import { readEditorSplit, writeEditorSplit } from "@/lib/editor/editor-split"
import {
  resetClientLocalStorageOwnerForTests,
  setClientLocalStorageOwner,
} from "@/lib/frontier/client-local-storage"

let trackWidth = 500

function Harness({ dir }: { dir?: "rtl" | "ltr" }) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  return (
    <div dir={dir}>
      <div ref={rootRef} data-testid="root">
        <EditorSplitDivider rootRef={rootRef} gridCols="grid-cols-[48px_minmax(0,1fr)] md:grid-cols-[84px_minmax(0,var(--editor-src-fr,1fr))_minmax(0,var(--editor-tgt-fr,1fr))]" />
      </div>
    </div>
  )
}

function rootVar(name: string): string {
  return screen.getByTestId("root").style.getPropertyValue(name)
}

beforeEach(() => {
  trackWidth = 500
  setClientLocalStorageOwner("ana")
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const track = this.getAttribute("data-split-track")
    const rtl = this.closest("[dir]")?.getAttribute("dir") === "rtl"
    if (track === "source") {
      const left = rtl ? 1100 - trackWidth : 100
      return { left, right: left + trackWidth, width: trackWidth, top: 0, bottom: 10, height: 10, x: left, y: 0, toJSON: () => ({}) } as DOMRect
    }
    if (track === "target") return { left: 0, right: trackWidth, width: trackWidth, top: 0, bottom: 10, height: 10, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  localStorage.clear()
  resetClientLocalStorageOwnerForTests()
})

describe("EditorSplitDivider", () => {
  it("is a focusable vertical separator that starts on today's even split", () => {
    render(<Harness />)
    const handle = screen.getByRole("separator")
    expect(handle.getAttribute("aria-orientation")).toBe("vertical")
    expect(handle.tabIndex).toBe(0)
    expect(handle.getAttribute("aria-valuenow")).toBe("50")
    expect(handle.getAttribute("aria-valuemin")).toBe("24")
    expect(handle.getAttribute("aria-valuemax")).toBe("76")
    // Nothing saved: the variables stay unset, so the template's 1fr fallback is today's split.
    expect(rootVar("--editor-src-fr")).toBe("")
  })

  it("moves with the arrow keys (Shift for bigger steps), saving as it goes", () => {
    render(<Harness />)
    const handle = screen.getByRole("separator")
    fireEvent.keyDown(handle, { key: "ArrowRight" })
    expect(readEditorSplit()).toBeCloseTo(0.516)
    expect(rootVar("--editor-src-fr")).toBe("1.032fr")
    expect(rootVar("--editor-tgt-fr")).toBe("0.968fr")
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true })
    expect(readEditorSplit()).toBeCloseTo(0.452)
    expect(handle.getAttribute("aria-valuenow")).toBe("45")
  })

  it("mirrors the arrows in RTL, where Source is on the right", () => {
    render(<Harness dir="rtl" />)
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" })
    expect(readEditorSplit()).toBeCloseTo(0.516)
  })

  it("resets to today's split on Home, Escape and double-click", () => {
    for (const reset of [
      (h: HTMLElement) => fireEvent.keyDown(h, { key: "Home" }),
      (h: HTMLElement) => fireEvent.keyDown(h, { key: "Escape" }),
      (h: HTMLElement) => fireEvent.doubleClick(h),
    ]) {
      writeEditorSplit(0.3)
      render(<Harness />)
      const handle = screen.getByRole("separator")
      expect(rootVar("--editor-src-fr")).toBe("0.6fr")
      reset(handle)
      expect(readEditorSplit()).toBeNull()
      expect(rootVar("--editor-src-fr")).toBe("")
      expect(handle.getAttribute("aria-valuenow")).toBe("50")
      cleanup()
    }
  })

  it("drags with a pointer (mouse or touch) and saves on release, in RTL too", () => {
    render(<Harness dir="rtl" />)
    const handle = screen.getByRole("separator")
    // RTL: Source runs from x=1100 leftwards; pointer at 696 → Source 400px of 1000.
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 704, pointerType: "touch" })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 696, pointerType: "touch" })
    expect(rootVar("--editor-src-fr")).toBe("0.8fr")
    expect(readEditorSplit()).toBeNull()
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 696, pointerType: "touch" })
    expect(readEditorSplit()).toBeCloseTo(0.4)
  })

  it("clamps a saved split that no longer fits, and hides when both minimums cannot fit", () => {
    writeEditorSplit(0.1)
    trackWidth = 300 // 600px of text: Source at least 240px → 0.4
    const { unmount } = render(<Harness />)
    expect(rootVar("--editor-src-fr")).toBe("0.8fr")
    // The saved choice itself is kept for a wider screen.
    expect(readEditorSplit()).toBe(0.1)
    unmount()

    trackWidth = 200 // 400px: under two minimums → today's split, no handle
    render(<Harness />)
    expect(screen.queryByRole("separator")).toBeNull()
    expect(rootVar("--editor-src-fr")).toBe("")
  })
})
