// The React half of collapsing a media-lens section. (AQU-1119)
//
// Extracted from ProjectWorkspace so it can be tested at all: nothing in the
// suite renders that component (7,000 lines, a live sync stack behind it), and
// its two sibling layout modules say the same thing about their own gates. The
// pure rules live next door in media-section-layout.ts; what is here is the
// part that needs React and the panel handles — the per-file state, the frozen
// boxes, and the exact ORDER the library forces on us.
//
// THE ORDERING, which is the whole reason this is a hook and not three
// handlers inline:
//
// A Panel re-registers whenever its min/max/collapsible/collapsedSize change,
// and the group only picks up the new constraints on the render that follows.
// React flushes a passive effect from commit N BEFORE the re-render that
// commit N scheduled, so an effect that calls `resize()` after setting state
// runs against the OLD constraints — against a panel still pinned to 40px,
// where the resize is silently a no-op and the section never reopens. So the
// restore is driven with `flushSync` from the handler instead: the state and
// the constraints land, the group remounts with them, and only then does the
// panel get told what size to be.
//
// For the same reason collapsing needs no imperative call at all. Pinning the
// panel is enough — the library's own validation clamps it to the rail on the
// next commit and hands the freed space to its neighbour.

import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { usePanelRef } from "react-resizable-panels"
import {
  collapseSection,
  expandSection,
  isRailSized,
  isSeparatorDisabled,
  mediaPanelConstraints,
  presentSections,
  readStoredCollapsedSections,
  reconcilePresence,
  shouldPersistSize,
  writeStoredCollapsedSections,
  type CollapsedSections,
  type MediaSectionId,
} from "./media-section-layout"
import { readStoredTimelinePaneHeight } from "./timeline-pane-layout"
import { readStoredVideoPaneWidth } from "./video-pane-layout"

/** A section's last known real size, kept so the collapsed content can be
 *  frozen at it rather than re-laid-out at 40px. */
interface FrozenBox {
  width: number
  height: number
}

export interface UseMediaSectionCollapseInput {
  fileId: string | null
  timelineStacked: boolean
  hasVideo: boolean
  /**
   * Run just before the text section closes. The caller blurs whatever cell is
   * being edited: the rows stay mounted behind the rail, so focus would
   * otherwise remain live and invisible, and a focused row that later unmounts
   * never fires blur — which is what strands a collaboration lease.
   */
  onBeforeCollapseText?: () => void
}

export function useMediaSectionCollapse(input: UseMediaSectionCollapseInput) {
  const { fileId, timelineStacked, hasVideo, onBeforeCollapseText } = input

  const [collapsed, setCollapsed] = useState<CollapsedSections>(() =>
    timelineStacked ? readStoredCollapsedSections(fileId) : [],
  )
  const frozenRef = useRef<Partial<Record<MediaSectionId, FrozenBox>>>({})
  const contentRefs = useRef<Partial<Record<MediaSectionId, HTMLElement | null>>>({})

  const timelinePanelRef = usePanelRef()
  const videoPanelRef = usePanelRef()
  const tablePanelRef = usePanelRef()
  const panelRefs = {
    timeline: timelinePanelRef,
    video: videoPanelRef,
    text: tablePanelRef,
  } as const

  const present = presentSections({ timelineStacked, hasVideo })

  // Presence first, so nothing downstream ever sees a section collapsed that
  // is not on screen. The classic case: the video is collapsed AND the
  // timeline is collapsed, then the film is unlinked — leaving the table as
  // the only section, collapsed, and the workspace empty.
  const effective = reconcilePresence(collapsed, present)

  // Per-file, read on switch. `defaultSize` is read once at mount and these
  // panels never remount, so nothing else would re-apply it.
  useEffect(() => {
    if (!timelineStacked) return
    setCollapsed(readStoredCollapsedSections(fileId))
    frozenRef.current = {}
  }, [fileId, timelineStacked])

  // Written on change. Gated on the lens so a trip through the text lens can
  // never clear what the reader set up in the media lens.
  useEffect(() => {
    if (!timelineStacked) return
    writeStoredCollapsedSections(fileId, effective)
  }, [fileId, timelineStacked, effective])

  /** Freeze the section at the size it is now, before anything shrinks. */
  const freeze = useCallback((id: MediaSectionId) => {
    const el = contentRefs.current[id]
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Both axes: collapsing the timeline changes a panel's HEIGHT, and the
    // table's own height changes with it, so freezing width alone would still
    // let the row list re-measure.
    if (rect.width > 0 && rect.height > 0) {
      frozenRef.current[id] = { width: rect.width, height: rect.height }
    }
  }, [])

  const collapse = useCallback(
    (id: MediaSectionId) => {
      if (id === "text") onBeforeCollapseText?.()
      freeze(id)
      // No imperative call. Pinning is enough — the group's own validation
      // clamps the panel to the rail on the next commit and gives the space to
      // its neighbour, which is also what makes drag-collapse and
      // button-collapse converge on one code path.
      setCollapsed((prev) => collapseSection(prev, id, present))
    },
    [freeze, onBeforeCollapseText, present],
  )

  /**
   * Which panel to resize to put a section back, and to what.
   *
   * THE TABLE IS NEVER RESIZED. It has no remembered size of its own — it has
   * always been "whatever is left" — so reopening the text section means
   * putting the PICTURE back to its remembered width and letting the table
   * take the residual, exactly as it does when nothing is collapsed. Resizing
   * the table instead leaves the video holding the width it borrowed while the
   * table was railed: it grows to fill the row under the relaxed cap, and when
   * the cap comes back it merely clamps to 58% rather than returning to the
   * 288px the reader chose.
   */
  const restoreTargetFor = useCallback(
    (id: MediaSectionId): { panel: MediaSectionId; px: number } =>
      id === "timeline"
        ? { panel: "timeline", px: readStoredTimelinePaneHeight(fileId ?? "") }
        : { panel: "video", px: readStoredVideoPaneWidth() },
    [fileId],
  )

  /**
   * Resize a panel, tolerating the one moment it cannot be done.
   *
   * `resize()` THROWS ("Layout not found for Panel …") when the group has not
   * laid out yet — and because the throw happens inside a React effect it does
   * not merely fail, it unmounts the whole media lens. That state is reachable
   * on the first commit after the lens opens: the panels register in a layout
   * effect, but the group only builds its layout on the render that
   * registration schedules, which is after this parent's effects have run.
   *
   * Nothing is lost by skipping it there. On mount every panel already takes
   * its `defaultSize`, which is the same stored number this would apply.
   */
  const applySize = useCallback((id: MediaSectionId, px: number) => {
    if (px <= 0) return
    try {
      panelRefs[id].current?.resize(px)
    } catch {
      /* group not laid out yet — defaultSize already covers this commit */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panel refs are stable
  }, [])

  /** Re-apply a section's remembered size — used on a file switch. */
  const restoreStoredSize = useCallback(
    (id: MediaSectionId) => {
      if (effective.includes(id)) return
      const { panel, px } = restoreTargetFor(id)
      applySize(panel, px)
    },
    [applySize, effective, restoreTargetFor],
  )

  const expand = useCallback(
    (id: MediaSectionId) => {
      // flushSync, not an effect: the panel has to be re-registered with its
      // open constraints BEFORE it is told what size to be, and a passive
      // effect from this commit would run a render too early — resizing a
      // still-pinned panel, which does nothing at all.
      flushSync(() => setCollapsed((prev) => expandSection(prev, id)))
      delete frozenRef.current[id]
      const { panel, px } = restoreTargetFor(id)
      applySize(panel, px)
      // `resize`, never `expand()`. The library only remembers an expand-to
      // size after an IMPERATIVE collapse, and re-registration wipes it in any
      // case — so `expand()` would reopen the section at its bare minimum
      // rather than the size the reader left it at.
    },
    [applySize, restoreTargetFor],
  )

  /**
   * Fed from every panel's `onResize`. This is how a DRAG collapse is heard:
   * the library snaps the panel to its collapsed size, and the measurement is
   * the only signal we get.
   */
  const noteResize = useCallback(
    (id: MediaSectionId, px: number) => {
      if (!isRailSized(px)) return
      setCollapsed((prev) => collapseSection(prev, id, present))
    },
    [present],
  )

  return {
    collapsed: effective,
    constraints: mediaPanelConstraints({ collapsed: effective, timelineStacked, hasVideo }),
    isCollapsed: (id: MediaSectionId) => effective.includes(id),
    separatorDisabled: (between: "timeline-body" | "video-table") =>
      isSeparatorDisabled(effective, between),
    frozen: frozenRef.current,
    panelRefs,
    registerContent: (id: MediaSectionId) => (el: HTMLElement | null) => {
      contentRefs.current[id] = el
    },
    collapse,
    expand,
    noteResize,
    restoreStoredSize,
    /** Should this measurement be written back as the section's size? */
    canPersist: (id: MediaSectionId) => shouldPersistSize(effective, id),
  }
}
