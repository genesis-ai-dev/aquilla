// The React half of the docking layout (useMediaDock): the paths that need
// the hook's own state, ordering and keyboard, which the pure rules in
// media-dock-layout.test.ts cannot reach. (Review of AQU-2196, Oct 29.)
//
// The panel library draws nothing here, so each panel's handle is a recorder:
// what the dock asks of the sizes is what these tests read. Geometry itself
// is the browser pass's job.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useMemo, useState } from "react"
import { movePanel, startDockLayout, writeStoredDock } from "./media-dock-layout"
import { useMediaDock } from "./useMediaDock"
import { writeStoredVideoPaneWidth } from "./video-pane-layout"

type Handle = {
  resize: ReturnType<typeof vi.fn>
  expand: ReturnType<typeof vi.fn>
  collapse: ReturnType<typeof vi.fn>
  getSize: () => { asPercentage: number; inPixels: number }
  isCollapsed: () => boolean
}
const handles = vi.hoisted(() => ({}) as Record<"tl" | "body" | "ll" | "lr", Handle>)

vi.mock("react-resizable-panels", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-resizable-panels")>()
  const React = await import("react")
  // The order useMediaDock asks for them in.
  const ORDER = ["tl", "body", "ll", "lr"] as const
  let made = 0
  return {
    ...actual,
    usePanelRef: () =>
      React.useState(() => {
        const handle: Handle = {
          resize: vi.fn(),
          expand: vi.fn(),
          collapse: vi.fn(),
          // Every region laid out and open: nothing for the repairs to do.
          getSize: () => ({ asPercentage: 50, inPixels: 400 }),
          isCollapsed: () => false,
        }
        handles[ORDER[made++ % ORDER.length]] = handle
        return { current: handle }
      })[0],
  }
})

const START = { timelineHeight: 304, videoWidth: 288 }

type Props = { fileId: string }

/** The dock beside a left panel that really folds and reopens, open on Files. */
function useDockBesideLeftPanel({ fileId }: Props) {
  const [tab, setTab] = useState<string | null>("files")
  const left = useMemo(() => ({ tab, isRail: true, setTab }), [tab])
  const dock = useMediaDock({ fileId, timelineStacked: true, filmPresent: true, start: START, left })
  return { dock, leftTab: tab }
}

const setup = (fileId = "f1") =>
  renderHook((p: Props) => useDockBesideLeftPanel(p), { initialProps: { fileId } })

/** A key pressed with the focus outside every region. */
const press = (init: KeyboardEventInit) =>
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }))
  })
const FULL_SCREEN = { code: "KeyF", key: "F", metaKey: true, shiftKey: true }
const SHOW_TIMELINE = { code: "Digit1", key: "1", altKey: true }
const ESC = { code: "Escape", key: "Escape" }

const nextFrame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())))

describe("useMediaDock", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  describe("full screen keeps its way back", () => {
    // Review finding 2: the folded timeline unfolds through flushSync, whose
    // commit ran the "left panel opened by hand ends full screen" effect
    // while the left panel was still open, and the note was dropped.
    it("from a folded timeline with the left panel open (⌘⇧F, then Esc)", () => {
      writeStoredDock("f1", { ...startDockLayout(), folded: { tl: true, ll: false, lr: false } })
      const { result } = setup()
      press(FULL_SCREEN)
      expect(result.current.dock.fullRegion).toBe("tl")
      expect(result.current.leftTab).toBeNull()
      expect(result.current.dock.layout.fullUndo).toEqual(["ll", "lr", "left:files"])
      expect(result.current.dock.canRestore).toBe(true)

      press(ESC)
      expect(result.current.dock.view.openRegions).toEqual(["tl", "ll", "lr"])
      expect(result.current.leftTab).toBe("files")
      expect(result.current.dock.layout.fullUndo).toEqual([])
    })

    // Review finding 6: showing the timeline while it is the full-screen
    // region changed nothing on screen but dropped the note.
    it("through Alt+1 while the timeline is the full-screen region", () => {
      const { result } = setup()
      press(FULL_SCREEN)
      expect(result.current.dock.fullRegion).toBe("tl")

      press(SHOW_TIMELINE)
      expect(result.current.dock.fullRegion).toBe("tl")
      expect(result.current.dock.layout.fullUndo).toEqual(["ll", "lr", "left:files"])
      expect(result.current.dock.canRestore).toBe(true)

      press(ESC)
      expect(result.current.dock.view.openRegions).toEqual(["tl", "ll", "lr"])
      expect(result.current.leftTab).toBe("files")
    })
  })

  // Review finding 3: the sizes went on in the switch's first commit, which
  // still held the old file's arrangement.
  it("opens the next file's film at its own width, in its own area, and leaves its text alone", async () => {
    // f1: the film bottom right at 400 px. f2: as every file starts, the film
    // bottom left, with no width of its own (its kind's 288).
    writeStoredDock("f1", movePanel(movePanel(startDockLayout(), "film", "lr"), "text", "ll"))
    writeStoredVideoPaneWidth("f1", 400)
    const { result, rerender } = setup("f1")
    await nextFrame()
    expect(result.current.dock.view.areaOf("film")).toBe("lr")
    expect(handles.lr.resize).toHaveBeenCalledWith(400)
    for (const h of Object.values(handles)) h.resize.mockClear()
    const writes = vi.spyOn(window.localStorage, "setItem")

    try {
      rerender({ fileId: "f2" })
      await nextFrame()
      expect(result.current.dock.view.areaOf("film")).toBe("ll")
      expect(handles.ll.resize).toHaveBeenCalledWith(288)
      expect(handles.lr.resize).not.toHaveBeenCalled()
      // …and f1's arrangement was never written under f2, not even for a moment.
      const underF2 = writes.mock.calls.filter(([key]) => key === "aquilla:mediaDock:f2").map(([, raw]) => JSON.parse(raw).areas)
      expect(underF2.length).toBeGreaterThan(0)
      for (const areas of underF2) expect(areas).toEqual({ ll: ["film"], lr: ["text"] })
    } finally {
      writes.mockRestore()
    }
  })

  // Review finding 7, as Sources › Hide film already did.
  describe("hiding a panel", () => {
    it("one of two tabs: the other shows, and the area they share stays open", () => {
      writeStoredDock("f1", { ...startDockLayout(), areas: { ll: ["film", "text"], lr: [] }, active: { ll: "film", lr: null } })
      const { result } = setup()
      act(() => result.current.dock.hide("film"))
      expect(result.current.dock.view.isOpen("ll")).toBe(true)
      expect(result.current.dock.view.isShowing("text")).toBe(true)
      act(() => result.current.dock.hide("text"))
      expect(result.current.dock.view.isOpen("ll")).toBe(true)
      expect(result.current.dock.view.isShowing("film")).toBe(true)
    })

    it("alone in its area: the area folds", () => {
      const { result } = setup()
      act(() => result.current.dock.hide("film"))
      expect(result.current.dock.view.isOpen("ll")).toBe(false)
      expect(result.current.dock.view.isShowing("text")).toBe(true)
    })
  })
})
