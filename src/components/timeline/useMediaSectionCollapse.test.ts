// AQU-1119. The React seam: per-file state, presence, and the drag signal.
//
// The panel handles are null here — happy-dom renders no panel group — so what
// this file covers is the state machine and the storage, which is exactly the
// half that would otherwise have no coverage anywhere (nothing in the suite
// renders ProjectWorkspace). Geometry is the browser pass's job.

import { beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useMediaSectionCollapse } from "./useMediaSectionCollapse"
import { MEDIA_RAIL_PX } from "./media-section-layout"

const KEY = (fileId: string) => `aquilla:mediaSectionsCollapsed:${fileId}`

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
    // section straight back — the rail looked like it did nothing.
    const { result } = setup()
    act(() => result.current.noteResize("video", MEDIA_RAIL_PX))
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
    expect(localStorage.getItem("aquilla:video-pane-width")).toBeNull()
    act(() => result.current.noteLayoutSettled({ isUserInteraction: true }))
    expect(localStorage.getItem("aquilla:video-pane-width")).toBe("240")
  })

  it("ignores a layout the library settled on its own", () => {
    const { result } = setup()
    act(() => result.current.noteResize("video", 300))
    act(() => result.current.noteLayoutSettled({ isUserInteraction: false }))
    expect(localStorage.getItem("aquilla:video-pane-width")).toBeNull()
  })

  it("does not remember a width measured while the table was railed", () => {
    // With the table pinned the picture measures the whole row; that is not a
    // width the reader chose.
    const { result } = setup()
    act(() => result.current.collapse("text"))
    act(() => result.current.noteResize("video", 1386))
    act(() => result.current.noteLayoutSettled({ isUserInteraction: true }))
    expect(localStorage.getItem("aquilla:video-pane-width")).toBeNull()
  })

  it("ignores zero, which is a hidden subtree rather than a size", () => {
    const { result } = setup()
    act(() => result.current.noteResize("video", 0))
    act(() => result.current.noteLayoutSettled({ isUserInteraction: true }))
    expect(localStorage.getItem("aquilla:video-pane-width")).toBeNull()
  })

  it("keeps the body populated: collapsing the second one gives the first back", () => {
    const { result } = setup()
    act(() => result.current.collapse("video"))
    act(() => result.current.collapse("text"))
    expect(result.current.isCollapsed("text")).toBe(true)
    expect(result.current.isCollapsed("video")).toBe(false)
  })

  it("blurs the editor before the text section closes over it", () => {
    // The rows stay mounted behind the rail, so focus would otherwise remain
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

  it("refuses to persist a size measured while its group holds a rail", () => {
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
})
