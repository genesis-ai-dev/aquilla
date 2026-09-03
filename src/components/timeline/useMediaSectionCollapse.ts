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
  MEDIA_RAIL_PX,
  mediaPanelConstraints,
  presentSections,
  railPreviewSections,
  readStoredCollapsedSections,
  reconcilePresence,
  shouldPersistSize,
  writeStoredCollapsedSections,
  type CollapsedSections,
  type MediaSectionId,
} from "./media-section-layout"
import { readStoredTimelinePaneHeight, writeStoredTimelinePaneHeight } from "./timeline-pane-layout"
import { readStoredVideoPaneWidth, writeStoredVideoPaneWidth } from "./video-pane-layout"

/** A section's last known real size, kept so the collapsed content can be
 *  frozen at it rather than re-laid-out at 40px. */
interface FrozenBox {
  width: number
  height: number
}

/** Nothing being previewed, as one shared reference so clearing is free. */
const NO_PREVIEW: CollapsedSections = []

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
  /**
   * Sections the pointer is holding at rail size but has not committed. Purely
   * what to paint; never read by any decision. See `railPreviewSections`.
   */
  const [previewRail, setPreviewRail] = useState<CollapsedSections>(NO_PREVIEW)
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

  /**
   * The last size each section measured while OPEN, kept from every resize
   * report. Two jobs: it is what gets written back as the remembered size once
   * a gesture ends, and it is the width to freeze at when a drag has already
   * snapped the panel to its rail before we hear about it.
   */
  const lastOpenRef = useRef<Partial<Record<MediaSectionId, number>>>({})

  /** Freeze the section at the size it is now, before anything shrinks. */
  const freeze = useCallback((id: MediaSectionId) => {
    const el = contentRefs.current[id]
    if (!el) return
    const rect = el.getBoundingClientRect()
    // A drag has already squeezed the panel to its rail by the time the
    // gesture ends, so along the collapsing axis the box is 40px — use the
    // last size it measured open instead. The other axis is still honest.
    const open = lastOpenRef.current[id] ?? 0
    const width = id === "timeline" ? rect.width : Math.max(rect.width, open)
    const height = id === "timeline" ? Math.max(rect.height, open) : rect.height
    // Both axes: collapsing the timeline changes a panel's HEIGHT, and the
    // table's own height changes with it, so freezing width alone would still
    // let the row list re-measure.
    if (width > 0 && height > 0) frozenRef.current[id] = { width, height }
  }, [])

  /**
   * Is this panel sitting at its collapsed size, as far as the library knows?
   *
   * `isCollapsed()` reads the group's layout exactly as `resize()` does, and
   * throws the same "Layout not found" when that group has not laid out yet.
   * That is reachable on first mount: the VERTICAL group's settled-layout
   * report fires before the HORIZONTAL group inside it has a layout, and a
   * callback that then asks about the video or the table takes the whole
   * lens down with it. A panel nobody has laid out yet is not collapsed.
   */
  const safeIsCollapsed = useCallback((id: MediaSectionId): boolean => {
    try {
      return panelRefs[id].current?.isCollapsed() ?? false
    } catch {
      return false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panel refs are stable
  }, [])

  /**
   * What this panel actually measures on screen, right now.
   *
   * `isCollapsed()` cannot answer this once a section is folded: it requires
   * the panel to still be `collapsible`, and a folded one is pinned instead
   * (min === max === 40), so it reports `false` for every rail we have made.
   * The pixel size is read live off the element and stays true either way.
   * Throws before the group has laid out, like every other panel method.
   */
  const safeSizePx = useCallback((id: MediaSectionId): number | null => {
    try {
      return panelRefs[id].current?.getSize().inPixels ?? null
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panel refs are stable
  }, [])

  /**
   * A layout report from a drag that is still in progress — this fires on
   * every pointer move, where `noteLayoutSettled` fires once at the release.
   *
   * All it does is decide what to paint. The fold itself still commits at
   * pointer-up and nowhere else, which is the round-2 rule and the reason
   * this is a separate handler rather than a second caller of the same one.
   */
  const pointerFrameRef = useRef<number | null>(null)

  const notePointerLayout = useCallback(() => {
    if (typeof window === "undefined") return
    // One read per frame, and on the NEXT frame rather than this one. The
    // library reports a layout from inside the pointermove handler, straight
    // after writing it to its own store — but the panel's width comes from a
    // style React has not rendered yet, so measuring here returns the size
    // from the move BEFORE this one. That lag is invisible in the middle of a
    // drag and fatal at the end of one: the move that snaps a panel to the
    // rail is usually the last, and its correction would never be read.
    if (pointerFrameRef.current !== null) return
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null
      const sizes: Partial<Record<MediaSectionId, number | null>> = {}
      for (const id of present) {
        if (effective.includes(id)) continue
        sizes[id] = safeSizePx(id)
      }
      setPreviewRail((prev) => railPreviewSections(sizes, effective, present, prev))
    })
  }, [effective, present, safeSizePx])

  useEffect(
    () => () => {
      if (pointerFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(pointerFrameRef.current)
      }
    },
    [],
  )

  const collapse = useCallback(
    (id: MediaSectionId) => {
      if (id === "text") onBeforeCollapseText?.()
      freeze(id)
      // No imperative call. Pinning is enough — the group's own validation
      // clamps the panel to the rail on the next commit and gives the space to
      // its neighbour, which is also what makes drag-collapse and
      // button-collapse converge on one code path.
      //
      // A partner the swap rule brings back is likewise NOT resized. With its
      // sibling pinned to the rail the group has exactly one fixed point — the
      // partner takes the whole residual — so any requested size would be
      // clamped to a no-op anyway. And the library validates the pin and the
      // partner's new size in the SAME commit, before paint, so there is no
      // frame in which the partner still measures 40px and could be misread
      // as folded. Verified against the library's solver, not assumed.
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
      // `resize()` reports the settled layout SYNCHRONOUSLY, so this is the
      // truth, not a guess. It can legitimately refuse: on a body row too
      // narrow to hold both floors the library returns the previous layout
      // untouched, the panel stays at its rail with `collapsible` set, and the
      // next window resize would read that as a fold and shut it anyway. Make
      // that explicit instead — a rail click that cannot fit the section
      // leaves it folded, rather than leaving a 40px sliver with no rail.
      if (safeIsCollapsed(id)) {
        setCollapsed((prev) => collapseSection(prev, id, present))
      }
      // `resize`, never `expand()`. The library only remembers an expand-to
      // size after an IMPERATIVE collapse, and re-registration wipes it in any
      // case — so `expand()` would reopen the section at its bare minimum
      // rather than the size the reader left it at.
    },
    [applySize, present, restoreTargetFor, safeIsCollapsed],
  )

  /**
   * Fed from every panel's `onResize`. It only RECORDS. It must not decide
   * anything, for two reasons that both showed up in a browser:
   *
   * - It fires mid-gesture. Committing the pin while the pointer is still down
   *   remounts the group under the drag, and pointer-up then re-inserts a
   *   layout entry keyed by the dead group — after which the rail's `resize()`
   *   lands on nothing and the panel stays at 40px.
   * - It fires with the OLD size right after React reopens a section, because
   *   the panel has not been resized yet on that frame. Reading that 40px as
   *   "the user collapsed it" shut the section straight back — which is what
   *   made the rail look like it did nothing.
   */
  const noteResize = useCallback((id: MediaSectionId, px: number) => {
    if (!isRailSized(px)) lastOpenRef.current[id] = px
  }, [])

  /**
   * Fed from BOTH panel groups' `onLayoutChanged`, which the library fires
   * once per settled layout — at pointer-up for a gesture, and after its own
   * re-validation otherwise. This is where a fold is heard, and where a size
   * that ended a gesture OPEN is remembered:
   *
   * - A panel the library reports collapsed while React still has it open
   *   was folded — by a drag, or by the library itself on a window too narrow
   *   to hold it. Both are committed as real collapses, so the rail appears
   *   and the fold reads as deliberate rather than as a 40px sliver; a fold
   *   is a better degradation than the crushed layout such a width gives
   *   otherwise. Committing here, after the layout settles, is what keeps the
   *   pin from landing on a group mid-gesture.
   * - A section that ends a USER gesture open remembers the size it ended at.
   *   One that ends collapsed remembers NOTHING — which is what "reopen to the
   *   size it was before" needs: a drag that goes 288 → 220 → rail used to
   *   write 220 on its way past the floor, so the rail reopened the picture at
   *   its bare minimum instead of where the reader had it. Layouts the library
   *   settled on its own are never remembered; they were not chosen.
   */
  const noteLayoutSettled = useCallback(
    (meta: { isUserInteraction: boolean }) => {
      const partnerOf = (id: MediaSectionId) =>
        id === "video" ? "text" : id === "text" ? "video" : null

      // Folds first, sizes second — as two passes, and the order is the whole
      // point. The gesture that folds the TEXT is a drag of the shared divider,
      // during which the video grows to fill the row; its last open
      // measurement is that full-row width. Persisting in the same pass, before
      // the fold has been seen, would remember 1386px as the width the reader
      // chose, and the rail would then reopen the picture to fill the row.
      // The gesture is over, so nothing is being previewed any more. Batched
      // with the commit below, so the real rail replaces the preview in one
      // paint rather than flashing the crushed content between them. Any frame
      // still owing is dropped: its measurement predates this commit.
      if (pointerFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(pointerFrameRef.current)
        pointerFrameRef.current = null
      }
      setPreviewRail((prev) => (prev.length === 0 ? prev : NO_PREVIEW))

      const foldedNow = new Set<MediaSectionId>()
      for (const id of ["timeline", "video", "text"] as const) {
        if (effective.includes(id) || !safeIsCollapsed(id)) continue
        // A body row too narrow to hold even one open section plus a rail
        // (under ~330px) makes the library fold BOTH body panels. Committing
        // that would trigger the swap rule, which reopens the partner, which
        // the library folds again on the next delivery — an oscillation once
        // per resize. Below that width the layout is already broken; the one
        // thing not to do is flicker. So a fold the library made on its own is
        // not committed while the section's partner is already down.
        const partner = partnerOf(id)
        if (!meta.isUserInteraction && partner && effective.includes(partner)) continue
        foldedNow.add(id)
        collapse(id)
      }
      if (!meta.isUserInteraction) return
      for (const id of ["timeline", "video"] as const) {
        if (effective.includes(id) || foldedNow.has(id)) continue
        const partner = partnerOf(id)
        if (partner && foldedNow.has(partner)) continue
        const px = lastOpenRef.current[id]
        if (!px || !shouldPersistSize(effective, id)) continue
        if (id === "timeline") writeStoredTimelinePaneHeight(fileId ?? "", px)
        else writeStoredVideoPaneWidth(px)
      }
    },
    [collapse, effective, fileId, safeIsCollapsed],
  )

  /**
   * Make sure a folded section is actually AT the rail.
   *
   * Pinning a panel (min === max === 40) is supposed to be enough: changing
   * those props re-registers the panel, which remounts the group, which clamps
   * the cached layout to the new constraints. Usually it is. Sam found a state
   * where it was not — timeline already folded, then the text folded by its
   * chevron — and the result is the worst of both: React renders the rail
   * because the state says collapsed, while the panel keeps its full width, so
   * the rail stretches across a thousand pixels of empty room and the video
   * never grows. Drag-folding the same section works, because a drag sets the
   * layout itself and the pin only has to agree with it.
   *
   * The library gives no way to ask "did the pin land" — `isCollapsed()`
   * requires the panel to still be `collapsible`, which a pinned one is not,
   * and `collapse()` is a silent no-op on it for the same reason. So this
   * measures the element and, if it is not at the rail, drives it there. It is
   * the same distrust `expand()` already applies in the other direction.
   *
   * In practice it is the effect that lands the size, not the clamp: a passive
   * effect from this commit runs before the render the re-registration
   * scheduled, so the panel is still at its old width when we measure. Which
   * is the point — the fold stops depending on a mechanism that was seen to
   * fail, in every browser rather than the one where it was caught.
   *
   * Safe rather than a loop: it runs after the commit and outside the
   * library's own call stack, so no `flushSync` and no re-entrancy; it is a
   * no-op the moment the panel is already at the rail;
   * `resize()` clamps rather than throws, and here the neighbour can always
   * absorb the change (the video has no ceiling, the table has none, the body
   * has none); and the layout report it produces is not a user interaction, so
   * the persist pass returns early and the fold pass skips what is already
   * collapsed. It cannot fire mid-drag, because `effective` does not change
   * until the pointer is released.
   */
  const repairsRef = useRef<Partial<Record<MediaSectionId, number>>>({})
  useEffect(() => {
    for (const id of effective) {
      const px = safeSizePx(id)
      if (px === null || isRailSized(px)) continue
      repairsRef.current[id] = (repairsRef.current[id] ?? 0) + 1
      applySize(id, MEDIA_RAIL_PX)
    }
  }, [applySize, effective, safeSizePx])

  /**
   * The console seam, in the shape of `__aqQueueState` and
   * `__aqDubDebugSnapshot`. The browser pass runs in Chromium and Sam drives
   * Safari, so the one bug this round fixes was found somewhere no automated
   * leg can see it. This is how the next one gets diagnosed rather than
   * guessed at.
   *
   * It reports the two numbers whose disagreement names the cause. Both come
   * from `getSize()`: `asPercentage` is what the library's own store believes,
   * `inPixels` is read live off the element. A folded section should be 40px
   * and a percentage to match. A small percentage beside a large pixel width
   * means the store is right and the DOM never caught up; two large numbers
   * mean the clamp never ran at all.
   */
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return
    const snapshot = () => ({
      fileId,
      present,
      collapsed: [...effective],
      previewing: [...previewRail],
      sections: Object.fromEntries(
        present.map((id) => {
          let size: { asPercentage: number; inPixels: number } | null = null
          try {
            size = panelRefs[id].current?.getSize() ?? null
          } catch {
            /* the group has not laid out — no size to report */
          }
          return [
            id,
            {
              collapsed: effective.includes(id),
              previewing: previewRail.includes(id),
              railed: size ? isRailSized(size.inPixels) : null,
              // How many times this section's size was driven to the rail
              // rather than left to the group's own clamp. One per fold is
              // normal — the effect runs before the remount that would have
              // clamped it — and that is the point: the fold no longer
              // depends on a mechanism that was seen to fail.
              repairs: repairsRef.current[id] ?? 0,
              size,
              frozen: frozenRef.current[id] ?? null,
            },
          ]
        }),
      ),
    })
    const win = window as unknown as { __aqMediaSections?: () => unknown }
    win.__aqMediaSections = snapshot
    return () => {
      delete win.__aqMediaSections
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panel refs are stable
  }, [effective, fileId, present, previewRail])

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
    /** Painted like a rail, but not folded — a drag is still holding it. */
    isPreviewingRail: (id: MediaSectionId) => previewRail.includes(id),
    /**
     * Is a rail painted over this section, folded or merely held there? The
     * two look identical, which is the point; only `isCollapsed` decides
     * anything, and only it freezes, inerts or persists.
     */
    showsRail: (id: MediaSectionId) => effective.includes(id) || previewRail.includes(id),
    collapse,
    expand,
    noteResize,
    notePointerLayout,
    noteLayoutSettled,
    restoreStoredSize,
    /** Should this measurement be written back as the section's size? */
    canPersist: (id: MediaSectionId) => shouldPersistSize(effective, id),
  }
}
