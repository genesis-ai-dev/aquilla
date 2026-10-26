// AQU-1119 and the media redesign's layout. The React seam: per-file state,
// presence, the timeline's full screen and Reset layout.
//
// The panel handles are null here — happy-dom renders no panel group — so what
// this file covers is the state machine and the storage, which is exactly the
// half that would otherwise have no coverage anywhere (nothing in the suite
// renders ProjectWorkspace). Geometry is the browser pass's job.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useMediaSectionCollapse } from "./useMediaSectionCollapse"

const KEY = (fileId: string) => `aquilla:mediaSectionsCollapsed:${fileId}`
const FULL = (fileId: string) => `aquilla:mediaSectionFullscreen:${fileId}`
const BODY = (fileId: string) => `aquilla:mediaBodyFolded:${fileId}`
const WIDTH = (fileId: string) => `aquilla:video-pane-width:${fileId}`

const setup = (over: Partial<Parameters<typeof useMediaSectionCollapse>[0]> = {}) =>
  renderHook((props: Parameters<typeof useMediaSectionCollapse>[0]) => useMediaSectionCollapse(props), {
    initialProps: { fileId: "f1", timelineStacked: true, hasVideo: true, ...over },
  })

describe("useMediaSectionCollapse", () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it("keeps every path that shuts a section on the same handler", () => {
    // The button collapses; the drag is heard at pointer-up and collapses the
    // same way. Both must freeze and both must blur, so there is one function.
    const onBeforeCollapseText = vi.fn()
    const { result } = setup({ onBeforeCollapseText })
    act(() => result.current.collapse("text"))
    expect(result.current.isCollapsed("text")).toBe(true)
    expect(onBeforeCollapseText).toHaveBeenCalledTimes(1)
  })

  it("starts from what this file was left in", () => {
    localStorage.setItem(KEY("f1"), "video")
    const { result } = setup()
    expect(result.current.collapsed).toEqual(["video"])
    expect(result.current.isCollapsed("video")).toBe(true)
  })

  it("remembers per file, and does not bleed across a switch", () => {
    localStorage.setItem(KEY("f1"), "timeline")
    const { result, rerender } = setup()
    expect(result.current.collapsed).toEqual(["timeline"])

    rerender({ fileId: "f2", timelineStacked: true, hasVideo: true })
    expect(result.current.collapsed).toEqual([])

    rerender({ fileId: "f1", timelineStacked: true, hasVideo: true })
    expect(result.current.collapsed).toEqual(["timeline"])
  })

  it("writes what is collapsed, and removes the key when nothing is", () => {
    const { result } = setup()
    act(() => result.current.collapse("timeline"))
    expect(localStorage.getItem(KEY("f1"))).toBe("timeline")

    act(() => result.current.expand("timeline"))
    expect(localStorage.getItem(KEY("f1"))).toBeNull()
  })

  it("neither reads nor writes outside the media lens", () => {
    // A trip through the text lens must not clear what the reader set up in
    // the media lens — the same subtree renders there as a bare table.
    localStorage.setItem(KEY("f1"), "video")
    const { result } = setup({ timelineStacked: false })
    expect(result.current.collapsed).toEqual([])
    expect(localStorage.getItem(KEY("f1"))).toBe("video")
  })

  it("never collapses from a resize measurement alone", () => {
    // Two browser-found reasons. onResize fires MID-gesture, and committing
    // the pin under a live drag leaves the library holding a stale layout
    // entry the rail's resize then lands on. And it fires with the OLD size
    // right after React reopens a section, so reading 40px there shut the
    // section straight back.
    const { result } = setup()
    act(() => result.current.noteResize("video", 0))
    expect(result.current.isCollapsed("video")).toBe(false)
  })

  it("remembers the size a gesture ENDED at, not the ones it passed through", () => {
    // A drag from 288 to the rail passes 220 on its way past the floor. It
    // used to write 220 there, so the rail reopened the picture at its bare
    // minimum. Now nothing is written until pointer-up, and only if the
    // section is still open then.
    const { result } = setup()
    act(() => result.current.noteResize("video", 300))
    act(() => result.current.noteResize("video", 240))
    expect(localStorage.getItem(WIDTH("f1"))).toBeNull()
    act(() => result.current.noteLayoutSettled({ isUserInteraction: true }))
    // Per file since the media redesign's layout.
    expect(localStorage.getItem(WIDTH("f1"))).toBe("240")
    expect(localStorage.getItem("aquilla:video-pane-width")).toBeNull()
  })

  it("ignores a layout the library settled on its own", () => {
    const { result } = setup()
    act(() => result.current.noteResize("video", 300))
    act(() => result.current.noteLayoutSettled({ isUserInteraction: false }))
    expect(localStorage.getItem(WIDTH("f1"))).toBeNull()
  })

  it("does not remember a width measured while the table was folded", () => {
    // With the table pinned the picture measures the whole row; that is not a
    // width the reader chose.
    const { result } = setup()
    act(() => result.current.collapse("text"))
    act(() => result.current.noteResize("video", 1386))
    act(() => result.current.noteLayoutSettled({ isUserInteraction: true }))
    expect(localStorage.getItem(WIDTH("f1"))).toBeNull()
  })

  it("ignores zero, which is a hidden subtree rather than a size", () => {
    const { result } = setup()
    act(() => result.current.noteResize("video", 0))
    act(() => result.current.noteLayoutSettled({ isUserInteraction: true }))
    expect(localStorage.getItem(WIDTH("f1"))).toBeNull()
  })

  it("keeps the body populated: collapsing the second one gives the first back", () => {
    const { result } = setup()
    act(() => result.current.collapse("video"))
    act(() => result.current.collapse("text"))
    expect(result.current.isCollapsed("text")).toBe(true)
    expect(result.current.isCollapsed("video")).toBe(false)
  })

  it("blurs the editor before the text section closes over it", () => {
    // The rows stay mounted, folded, so focus would otherwise remain
    // live and invisible — and a focused row that later unmounts never fires
    // blur, which is what strands a collaboration lease.
    const onBeforeCollapseText = vi.fn()
    const { result } = setup({ onBeforeCollapseText })
    act(() => result.current.collapse("text"))
    expect(onBeforeCollapseText).toHaveBeenCalledTimes(1)
  })

  it("does not blur for the other sections", () => {
    const onBeforeCollapseText = vi.fn()
    const { result } = setup({ onBeforeCollapseText })
    act(() => result.current.collapse("timeline"))
    expect(onBeforeCollapseText).not.toHaveBeenCalled()
  })

  it("gives the body a section back when the video disappears under it", () => {
    localStorage.setItem(KEY("f1"), "timeline,text")
    const { result, rerender } = setup()
    expect(result.current.collapsed).toEqual(["timeline", "text"])

    // The film is unlinked, or the file switches to Free timing. Without
    // reconciliation the table would be the only section left, and collapsed.
    rerender({ fileId: "f1", timelineStacked: true, hasVideo: false })
    expect(result.current.isCollapsed("text")).toBe(false)
    expect(result.current.isCollapsed("timeline")).toBe(true)
  })

  it("refuses to persist a size measured while its group holds a fold", () => {
    const { result } = setup()
    expect(result.current.canPersist("video")).toBe(true)
    act(() => result.current.collapse("text"))
    // The video now measures the whole row, which clears its own floor and
    // would overwrite the width the reader chose.
    expect(result.current.canPersist("video")).toBe(false)
  })

  it("disables a separator that cannot move", () => {
    const { result } = setup()
    expect(result.current.separatorDisabled("video-table")).toBe(false)
    act(() => result.current.collapse("video"))
    expect(result.current.separatorDisabled("video-table")).toBe(true)
    expect(result.current.separatorDisabled("timeline-body")).toBe(false)
  })

  describe("full screen", () => {
    it("folds everything else, and is only full screen once they are down", () => {
      const { result } = setup()
      expect(result.current.isFullscreen("video")).toBe(false)
      act(() => result.current.enterFullscreen("video"))
      expect(result.current.collapsed).toEqual(["timeline", "text"])
      expect(result.current.isFullscreen("video")).toBe(true)
      expect(result.current.isFullscreen("text")).toBe(false)
    })

    it("puts back exactly what was there before it was pressed", () => {
      // The timeline was already folded, so it stays folded — only the text,
      // which this gesture took away, comes back.
      const { result } = setup()
      act(() => result.current.collapse("timeline"))
      act(() => result.current.enterFullscreen("video"))
      expect(result.current.collapsed).toEqual(["timeline", "text"])
      act(() => result.current.exitFullscreen("video"))
      expect(result.current.collapsed).toEqual(["timeline"])
    })

    it("opens everything when nobody recorded a press", () => {
      // Two chevrons leave the video genuinely full screen, so its button
      // offers to undo that. With no memory the honest answer is everything.
      const { result } = setup()
      act(() => result.current.collapse("timeline"))
      act(() => result.current.collapse("text"))
      expect(result.current.isFullscreen("video")).toBe(true)
      act(() => result.current.exitFullscreen("video"))
      expect(result.current.collapsed).toEqual([])
    })

    it("forgets the arrangement as soon as anything else opens a section", () => {
      const { result } = setup()
      act(() => result.current.collapse("timeline"))
      act(() => result.current.enterFullscreen("video"))
      // A rail click on the text: full screen is over, and pressing the
      // button again must capture what is on screen NOW, not what was.
      act(() => result.current.expand("text"))
      expect(result.current.isFullscreen("video")).toBe(false)
      act(() => result.current.exitFullscreen("video"))
      expect(result.current.collapsed).toEqual([])
    })

    it("forgets it when a chevron folds something instead", () => {
      const { result } = setup()
      act(() => result.current.enterFullscreen("video"))
      act(() => result.current.collapse("video"))
      // The swap rule handed the body back to the text; nothing is full
      // screen, and the memory went with the gesture that ended it.
      expect(result.current.isFullscreen("video")).toBe(false)
      expect(localStorage.getItem(FULL("f1"))).toBeNull()
    })

    it("lets the timeline take the lens by folding the body row, untouched inside", () => {
      const { result } = setup()
      act(() => result.current.collapse("video"))
      expect(result.current.canFullscreen("timeline")).toBe(true)
      act(() => result.current.enterFullscreen("timeline"))
      expect(result.current.bodyFolded).toBe(true)
      expect(result.current.isFullscreen("timeline")).toBe(true)
      // The row's own arrangement is kept, not folded section by section.
      expect(result.current.collapsed).toEqual(["video"])
      expect(result.current.isVisible("text")).toBe(false)
      expect(result.current.isFrozen("text")).toBe(true)
      expect(result.current.separatorDisabled("timeline-body")).toBe(true)
      expect(localStorage.getItem(BODY("f1"))).toBe("1")
      act(() => result.current.exitFullscreen("timeline"))
      expect(result.current.bodyFolded).toBe(false)
      expect(result.current.collapsed).toEqual(["video"])
      expect(result.current.isVisible("text")).toBe(true)
      expect(localStorage.getItem(BODY("f1"))).toBeNull()
    })

    it("ends the timeline's full screen when the Panels menu shows the text", () => {
      const { result } = setup()
      act(() => result.current.enterFullscreen("timeline"))
      act(() => result.current.expand("text"))
      expect(result.current.bodyFolded).toBe(false)
      expect(result.current.isFullscreen("timeline")).toBe(false)
    })

    it("brings the body back when the timeline that had the lens is hidden", () => {
      // Folding the timeline over a folded body would leave nothing on screen.
      const { result } = setup()
      act(() => result.current.enterFullscreen("timeline"))
      act(() => result.current.collapse("timeline"))
      expect(result.current.bodyFolded).toBe(false)
      expect(result.current.isCollapsed("timeline")).toBe(true)
      expect(result.current.isVisible("text")).toBe(true)
    })

    it("does not remember the height of a timeline that fills the lens", () => {
      const { result } = setup()
      act(() => result.current.enterFullscreen("timeline"))
      act(() => result.current.noteResize("timeline", 780))
      act(() => result.current.noteLayoutSettled({ isUserInteraction: true }))
      expect(localStorage.getItem("aquilla:timelinePaneHeight:f1")).toBeNull()
    })

    it("survives a reload, and still knows what to put back", () => {
      localStorage.setItem(KEY("f1"), "timeline,text")
      localStorage.setItem(FULL("f1"), "video|timeline")
      const { result } = setup()
      expect(result.current.isFullscreen("video")).toBe(true)
      act(() => result.current.exitFullscreen("video"))
      expect(result.current.collapsed).toEqual(["timeline"])
    })

    it("remembers per file, and does not bleed across a switch", () => {
      const { result, rerender } = setup()
      act(() => result.current.enterFullscreen("video"))
      expect(localStorage.getItem(FULL("f1"))).toBe("video|")
      rerender({ fileId: "f2", timelineStacked: true, hasVideo: true })
      expect(result.current.collapsed).toEqual([])
      expect(result.current.isFullscreen("video")).toBe(false)
      expect(localStorage.getItem(FULL("f2"))).toBeNull()
    })

    it("ignores a memory whose section has gone", () => {
      // A full-screen video, then the film is unlinked. The body is handed
      // back to the text and nothing acts on a memory naming the picture.
      localStorage.setItem(KEY("f1"), "timeline,text")
      localStorage.setItem(FULL("f1"), "video|")
      const { result } = setup({ hasVideo: false })
      expect(result.current.collapsed).toEqual(["timeline"])
      expect(result.current.isFullscreen("video")).toBe(false)
    })
  })

  describe("Panels menu and Reset layout", () => {
    it("knows what is on screen, and what may be hidden", () => {
      const { result } = setup({ hasVideo: false })
      expect(result.current.present).toEqual(["timeline", "text"])
      expect(result.current.isVisible("text")).toBe(true)
      // With no film the table is the only thing below the timeline.
      expect(result.current.canCollapse("text")).toBe(false)
      expect(result.current.canCollapse("timeline")).toBe(true)
    })

    it("forgets this file's arrangement and goes back to how it starts", () => {
      localStorage.setItem("aquilla:timelinePaneHeight:f1", "420")
      localStorage.setItem(WIDTH("f1"), "600")
      localStorage.setItem("aquilla:timelinePaneHeight:f2", "333")
      const { result } = setup({ start: { timelineHeight: 304, videoWidth: 480 } })
      act(() => result.current.collapse("video"))
      act(() => result.current.enterFullscreen("timeline"))
      act(() => result.current.resetLayout())
      expect(result.current.collapsed).toEqual([])
      expect(result.current.bodyFolded).toBe(false)
      expect(result.current.isFullscreen("timeline")).toBe(false)
      expect(localStorage.getItem("aquilla:timelinePaneHeight:f1")).toBeNull()
      expect(localStorage.getItem(WIDTH("f1"))).toBeNull()
      expect(localStorage.getItem(KEY("f1"))).toBeNull()
      expect(localStorage.getItem(BODY("f1"))).toBeNull()
      // Other files keep theirs.
      expect(localStorage.getItem("aquilla:timelinePaneHeight:f2")).toBe("333")
    })
  })
})
