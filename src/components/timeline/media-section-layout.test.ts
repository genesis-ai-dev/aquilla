// AQU-1119, and the media redesign's layout (zero-space folds, the timeline's
// full screen). Everything the media lens's collapse rules decide, tested where
// a unit test can actually reach it.
//
// This file carries more weight than usual: NOTHING in the suite renders
// ProjectWorkspace, so the panel group these constraints feed is only ever
// exercised by a browser pass. Its sibling video-pane-layout.test.ts says the
// same thing about its own gate, and for the same reason.

import { beforeEach, describe, expect, it } from "vitest"
import {
  MEDIA_FOLDED_PX,
  canCollapseSection,
  clearStoredMediaSections,
  collapseSection,
  expandSection,
  isFoldSized,
  isSeparatorDisabled,
  mediaPanelConstraints,
  canFullscreen,
  isSectionFullscreen,
  presentSections,
  readStoredBodyFolded,
  readStoredFullscreen,
  sectionsToFoldForFullscreen,
  writeStoredFullscreen,
  readStoredCollapsedSections,
  reconcilePresence,
  shouldPersistSize,
  writeStoredBodyFolded,
  writeStoredCollapsedSections,
  type CollapsedSections,
} from "./media-section-layout"
import { VIDEO_PANE_MIN_WIDTH, VIDEO_PANE_TABLE_MIN_WIDTH } from "./video-pane-layout"
import { MEDIA_BODY_MIN_HEIGHT, TIMELINE_PANE_MIN_HEIGHT } from "./timeline-pane-layout"

const ALL = ["timeline", "video", "text"] as const
const NO_VIDEO = ["timeline", "text"] as const

describe("presentSections", () => {
  it("has nothing to collapse outside the media lens", () => {
    expect(presentSections({ timelineStacked: false, hasVideo: true })).toEqual([])
  })

  it("drops the video when the pane is gated off", () => {
    expect(presentSections({ timelineStacked: true, hasVideo: false })).toEqual(["timeline", "text"])
  })
})

describe("the body always keeps one section open", () => {
  it("swaps the partner back rather than emptying the body", () => {
    // Video collapsed, then text: the body would have nothing left, so the
    // video returns. This is Sam's "collapsing the third uncollapses a
    // different one", and the one it picks is the one you collapsed last.
    const after = collapseSection(["video"], "text", [...ALL])
    expect(after).toEqual(["text"])
  })

  it("swaps in the other direction too", () => {
    expect(collapseSection(["text"], "video", [...ALL])).toEqual(["video"])
  })

  it("never leaves all three collapsed", () => {
    const after = collapseSection(["video", "timeline"], "text", [...ALL])
    expect(after).toEqual(["timeline", "text"])
    expect(after).not.toContain("video")
  })

  it("refuses to collapse the text when there is no video to hand the row to", () => {
    // A file with no linked film has a one-panel body. Railing it would leave
    // the horizontal group with nothing to fill it, so the control is simply
    // not offered.
    expect(canCollapseSection([], "text", [...NO_VIDEO])).toBe(false)
    expect(collapseSection([], "text", [...NO_VIDEO])).toEqual([])
  })

  it("still lets the timeline collapse on a file with no video", () => {
    expect(canCollapseSection([], "timeline", [...NO_VIDEO])).toBe(true)
    expect(collapseSection([], "timeline", [...NO_VIDEO])).toEqual(["timeline"])
  })
})

describe("reducers are idempotent by reference", () => {
  // Load-bearing: every constraint change re-registers the panels and fires
  // onResize again, so a reducer that allocated a fresh array each time would
  // drive a render loop through the resize seam.
  it("returns the same array when collapsing what is already collapsed", () => {
    const state: CollapsedSections = ["video"]
    expect(collapseSection(state, "video", [...ALL])).toBe(state)
  })

  it("returns the same array when expanding what is already open", () => {
    const state: CollapsedSections = ["video"]
    expect(expandSection(state, "timeline")).toBe(state)
  })

  it("returns the same array when presence has not changed", () => {
    const state: CollapsedSections = ["timeline"]
    expect(reconcilePresence(state, [...ALL])).toBe(state)
  })
})

describe("reconcilePresence", () => {
  it("drops a section that no longer exists", () => {
    expect(reconcilePresence(["video", "timeline"], [...NO_VIDEO])).toEqual(["timeline"])
  })

  it("gives the body back a section when losing the video would empty it", () => {
    // Timeline and text collapsed, video visible — then the film is unlinked
    // or the file switches to Free timing. Without this the only section left
    // would be the collapsed table: an empty workspace.
    expect(reconcilePresence(["timeline", "text"], [...NO_VIDEO])).toEqual(["timeline"])
  })
})

describe("isFoldSized", () => {
  it("is a folded panel: zero, and a couple of pixels of rounding", () => {
    expect(MEDIA_FOLDED_PX).toBe(0)
    expect(isFoldSized(0)).toBe(true)
    expect(isFoldSized(2)).toBe(true)
  })

  it("rejects every real expanded size", () => {
    expect(isFoldSized(3)).toBe(false)
    // The smallest floor in the lens, so nothing legitimate comes near.
    expect(isFoldSized(TIMELINE_PANE_MIN_HEIGHT)).toBe(false)
  })
})

describe("full screen", () => {
  type Id = "timeline" | "video" | "text"
  const full = (collapsed: CollapsedSections, id: Id, present: readonly Id[] = ALL, bodyFolded = false) =>
    isSectionFullscreen(collapsed, id, [...present], bodyFolded)
  const can = (collapsed: CollapsedSections, id: Id, present: readonly Id[] = ALL, bodyFolded = false) =>
    canFullscreen(collapsed, id, [...present], bodyFolded)

  it("is full screen only when everything else on screen is folded", () => {
    expect(full(["timeline", "text"], "video")).toBe(true)
    expect(full(["timeline"], "video")).toBe(false)
    expect(full([], "video")).toBe(false)
  })

  it("is never full screen while it is itself folded", () => {
    // Its neighbours are down and so is it — the lens is showing the partner
    // the swap rule handed back, not this section.
    expect(full(["video", "timeline"], "video")).toBe(false)
  })

  it("counts only the sections that exist", () => {
    // No film: folding the timeline is all it takes for the text to have the
    // lens, and the button should say so.
    expect(full(["timeline"], "text", NO_VIDEO)).toBe(true)
  })

  it("reads true for an arrangement nobody asked for", () => {
    // Fold the timeline and the text by hand and the video IS full screen.
    // The glyph is derived, so it tells the truth rather than tracking presses.
    expect(full(["text", "timeline"], "video")).toBe(true)
  })

  it("lets the timeline take the lens by folding the body row as one unit", () => {
    // Media redesign, layout: full screen for every panel. The timeline never
    // folds the two body sections (a flex row has to be filled by something);
    // it folds the row they sit in.
    expect(can([], "timeline")).toBe(true)
    expect(can([], "video")).toBe(true)
    expect(can([], "text")).toBe(true)
    expect(can(["timeline"], "timeline")).toBe(false)
  })

  it("is the timeline that has the lens while the body row is folded", () => {
    expect(full([], "timeline", ALL, true)).toBe(true)
    // The film and the text sit inside the folded row, untouched but unseen.
    expect(full([], "video", ALL, true)).toBe(false)
    expect(full(["timeline"], "text", ALL, false)).toBe(false)
    // The body row is open, so the timeline is sharing the lens.
    expect(full([], "timeline")).toBe(false)
  })

  it("offers nothing more while the body row is folded", () => {
    // The only move from there is back.
    expect(can([], "timeline", ALL, true)).toBe(false)
    expect(can([], "video", ALL, true)).toBe(false)
  })

  it("refuses a folded section, and one with nothing to fold", () => {
    expect(can(["video"], "video")).toBe(false)
    // A lens with one section in it has nothing to hand the space to.
    expect(can([], "text", ["text"])).toBe(false)
  })

  it("folds only what is still open, in the canonical order", () => {
    expect(sectionsToFoldForFullscreen([], "video", [...ALL])).toEqual(["timeline", "text"])
    expect(sectionsToFoldForFullscreen(["timeline"], "video", [...ALL])).toEqual(["text"])
    expect(sectionsToFoldForFullscreen([], "text", [...NO_VIDEO])).toEqual(["timeline"])
  })

  it("folds no section for the timeline, which folds the row instead", () => {
    expect(sectionsToFoldForFullscreen([], "timeline", [...ALL])).toEqual([])
  })
})

describe("the remembered arrangement", () => {
  beforeEach(() => {
    localStorage.removeItem("aquilla:mediaSectionFullscreen:f1")
    localStorage.removeItem("aquilla:mediaSectionFullscreen:f2")
  })

  it("round-trips the section and what was folded before it", () => {
    writeStoredFullscreen("f1", { section: "video", restore: ["timeline"] })
    expect(readStoredFullscreen("f1", [...ALL])).toEqual({ section: "video", restore: ["timeline"] })
  })

  it("round-trips an empty restore, which means everything was open", () => {
    writeStoredFullscreen("f1", { section: "text", restore: [] })
    expect(readStoredFullscreen("f1", [...ALL])).toEqual({ section: "text", restore: [] })
  })

  it("removes the key rather than storing the default", () => {
    writeStoredFullscreen("f1", { section: "video", restore: [] })
    writeStoredFullscreen("f1", null)
    expect(localStorage.getItem("aquilla:mediaSectionFullscreen:f1")).toBeNull()
  })

  it("keeps files apart", () => {
    writeStoredFullscreen("f1", { section: "video", restore: [] })
    expect(readStoredFullscreen("f2", [...ALL])).toBeNull()
  })

  it("ignores a memory for a section that is not on screen", () => {
    // The film was unlinked since. Storage is left alone — re-linking it
    // should bring the arrangement back — but nothing acts on it meanwhile.
    writeStoredFullscreen("f1", { section: "video", restore: [] })
    expect(readStoredFullscreen("f1", [...NO_VIDEO])).toBeNull()
  })

  it("reads nothing from anything malformed", () => {
    for (const raw of ["", "video", "nonsense|timeline", "|timeline", "video timeline"]) {
      localStorage.setItem("aquilla:mediaSectionFullscreen:f1", raw)
      expect(readStoredFullscreen("f1", [...ALL])).toBeNull()
    }
  })

  it("drops members it does not recognise from the remembered set", () => {
    localStorage.setItem("aquilla:mediaSectionFullscreen:f1", "video|timeline,gutter")
    expect(readStoredFullscreen("f1", [...ALL])).toEqual({ section: "video", restore: ["timeline"] })
  })

  it("does not invent a key with no file", () => {
    writeStoredFullscreen(null, { section: "video", restore: [] })
    expect(readStoredFullscreen(null, [...ALL])).toBeNull()
    expect(Object.keys(localStorage).filter((k) => k.includes("Fullscreen"))).toEqual([])
  })
})

describe("shouldPersistSize", () => {
  it("lets a section remember its size when its group is fully open", () => {
    expect(shouldPersistSize([], "video")).toBe(true)
    expect(shouldPersistSize([], "timeline")).toBe(true)
    expect(shouldPersistSize(["timeline"], "video")).toBe(true)
  })

  it("refuses the video's width while the table is folded", () => {
    // With the table pinned the video measures the whole row, which clears its
    // 220px floor and would overwrite the width the reader chose.
    expect(shouldPersistSize(["text"], "video")).toBe(false)
  })

  it("refuses a folded section's own size", () => {
    expect(shouldPersistSize(["video"], "video")).toBe(false)
    expect(shouldPersistSize(["timeline"], "timeline")).toBe(false)
  })

  it("refuses the height of a timeline that fills the lens", () => {
    // Full screen is not a height anyone chose; coming back must return the
    // timeline to the one they had.
    expect(shouldPersistSize([], "timeline", true)).toBe(false)
    expect(shouldPersistSize([], "video", true)).toBe(false)
  })
})

describe("mediaPanelConstraints", () => {
  const constraints = (collapsed: CollapsedSections, hasVideo = true, bodyFolded = false) =>
    mediaPanelConstraints({ collapsed, timelineStacked: true, hasVideo, bodyFolded })

  it("leaves every panel unconstrained outside the media lens", () => {
    const c = mediaPanelConstraints({ collapsed: [], timelineStacked: false, hasVideo: true })
    expect(c).toEqual({ timeline: {}, body: {}, video: {}, table: {} })
  })

  it("keeps every floor when nothing is collapsed", () => {
    const c = constraints([])
    expect(c.timeline.minSize).toBe(TIMELINE_PANE_MIN_HEIGHT)
    expect(c.body.minSize).toBe(MEDIA_BODY_MIN_HEIGHT)
    expect(c.video.minSize).toBe(VIDEO_PANE_MIN_WIDTH)
    expect(c.table.minSize).toBe(VIDEO_PANE_TABLE_MIN_WIDTH)
  })

  it("gives the video no ceiling in any state", () => {
    // The old 58% cap was what made the table impossible to fold by drag: the
    // shared divider ran out of road ~230px before the table's snap point.
    // Folding is the route to a bigger picture now; the table's own floor is
    // the stop.
    for (const collapsed of [[], ["timeline"], ["text"], ["timeline", "text"]] as CollapsedSections[]) {
      expect(constraints(collapsed).video.maxSize).toBe("100%")
    }
  })

  it("pins a collapsed section folded — no room at all — instead of leaving it collapsible", () => {
    // min === max is the whole mechanism once a section is shut: it gives the
    // solver one fixed point, so drag, Enter, Home/End, arrow keys,
    // double-click and a window resize all become inert and cannot move the
    // layout behind React's back.
    for (const section of ALL) {
      const key = section === "text" ? "table" : section
      const c = constraints([section])
      expect(c[key]).toEqual({ minSize: 0, maxSize: 0 })
      expect(c[key].collapsible).toBeUndefined()
    }
  })

  it("leaves every open section collapsible, folding to nothing", () => {
    // Dragging a divider shut is how you fold a section, so while open each
    // keeps the flag and a zero collapsedSize for the library to snap to. The
    // table included: it holds at its floor and folds once the pointer is past
    // the midpoint, exactly like the other two.
    for (const section of ["timeline", "video", "table"] as const) {
      const c = constraints([])[section]
      expect(c.collapsible).toBe(true)
      expect(c.collapsedSize).toBe(0)
    }
  })

  it("pins a folded video shut, ceiling and all", () => {
    expect(constraints(["video"]).video.maxSize).toBe(0)
  })

  it("folds the body row for a full-screen timeline, and lifts the timeline's cap", () => {
    const c = constraints([], true, true)
    expect(c.body).toEqual({ minSize: 0, maxSize: 0 })
    expect(c.timeline.maxSize).toBe("100%")
    // The film and the text inside the row keep their own constraints, so
    // coming back needs nothing but the unfold.
    expect(c.video.minSize).toBe(VIDEO_PANE_MIN_WIDTH)
    expect(c.table.minSize).toBe(VIDEO_PANE_TABLE_MIN_WIDTH)
  })

  it("never folds the body under a folded timeline, which would empty the lens", () => {
    const c = constraints(["timeline"], true, true)
    expect(c.body.minSize).toBe(MEDIA_BODY_MIN_HEIGHT)
  })

  it("leaves the table free to take the residual when the video is folded", () => {
    const c = constraints(["video"])
    expect(c.table.minSize).toBe(VIDEO_PANE_TABLE_MIN_WIDTH)
    expect(c.table.maxSize).toBeUndefined()
  })
})

describe("isSeparatorDisabled", () => {
  it("disables a handle that cannot move", () => {
    expect(isSeparatorDisabled(["timeline"], "timeline-body")).toBe(true)
    expect(isSeparatorDisabled(["video"], "video-table")).toBe(true)
    expect(isSeparatorDisabled(["text"], "video-table")).toBe(true)
  })

  it("leaves a live handle alone", () => {
    expect(isSeparatorDisabled(["timeline"], "video-table")).toBe(false)
    expect(isSeparatorDisabled([], "timeline-body")).toBe(false)
  })

  it("disables the timeline's handle while it fills the lens", () => {
    expect(isSeparatorDisabled([], "timeline-body", true)).toBe(true)
  })
})

describe("per-file persistence", () => {
  beforeEach(() => {
    localStorage.removeItem("aquilla:mediaSectionsCollapsed:f1")
    localStorage.removeItem("aquilla:mediaSectionsCollapsed:f2")
  })

  it("round-trips a set, order and all", () => {
    writeStoredCollapsedSections("f1", ["video", "timeline"])
    expect(readStoredCollapsedSections("f1")).toEqual(["video", "timeline"])
  })

  it("keeps files apart", () => {
    writeStoredCollapsedSections("f1", ["video"])
    expect(readStoredCollapsedSections("f2")).toEqual([])
  })

  it("removes the key rather than storing the default", () => {
    writeStoredCollapsedSections("f1", ["video"])
    writeStoredCollapsedSections("f1", [])
    expect(localStorage.getItem("aquilla:mediaSectionsCollapsed:f1")).toBeNull()
  })

  it("reads nothing collapsed from anything malformed", () => {
    for (const junk of ["", "not-a-section", "video,nonsense", "[]"]) {
      localStorage.setItem("aquilla:mediaSectionsCollapsed:f1", junk)
      const read = readStoredCollapsedSections("f1")
      expect(read.every((id) => ALL.includes(id))).toBe(true)
    }
  })

  it("de-duplicates, because the order is what carries recency", () => {
    localStorage.setItem("aquilla:mediaSectionsCollapsed:f1", "video,video,timeline")
    expect(readStoredCollapsedSections("f1")).toEqual(["video", "timeline"])
  })

  it("does not invent a key with no file", () => {
    writeStoredCollapsedSections(null, ["video"])
    expect(localStorage.getItem("aquilla:mediaSectionsCollapsed:null")).toBeNull()
    expect(readStoredCollapsedSections(undefined)).toEqual([])
  })
})

describe("the folded body row, and Reset layout", () => {
  beforeEach(() => localStorage.clear())

  it("round-trips per file and removes the key when unfolded", () => {
    writeStoredBodyFolded("f1", true)
    expect(readStoredBodyFolded("f1")).toBe(true)
    expect(readStoredBodyFolded("f2")).toBe(false)
    writeStoredBodyFolded("f1", false)
    expect(localStorage.getItem("aquilla:mediaBodyFolded:f1")).toBeNull()
  })

  it("forgets a file's whole arrangement and leaves other files alone", () => {
    writeStoredCollapsedSections("f1", ["video"])
    writeStoredFullscreen("f1", { section: "text", restore: [] })
    writeStoredBodyFolded("f1", true)
    writeStoredCollapsedSections("f2", ["timeline"])
    clearStoredMediaSections("f1")
    expect(readStoredCollapsedSections("f1")).toEqual([])
    expect(readStoredFullscreen("f1", [...ALL])).toBeNull()
    expect(readStoredBodyFolded("f1")).toBe(false)
    expect(readStoredCollapsedSections("f2")).toEqual(["timeline"])
  })
})
