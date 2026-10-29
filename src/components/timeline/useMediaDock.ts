// The React half of the media view's docking layout. (Media redesign, layout)
//
// The rules are in media-dock-layout.ts; this is the part that needs React and
// the panel handles: the per-file state, the panel constraints, the order the
// panel library forces on us, moving the film and the text between areas, and
// the keyboard.
//
// LESSONS CARRIED OVER FROM useMediaSectionCollapse (AQU-1119), each paid for
// in a browser:
//
// - A Panel re-registers when its min/max/collapsible change, and the group
//   only takes the new constraints on the render after. So an unfold is driven
//   with `flushSync` — state first, then `resize()` — never from an effect,
//   which would resize a panel still pinned at zero and do nothing.
// - Folding needs no imperative call: pinning the panel (min = max = 0) is
//   enough, and an effect drives it to zero when the pin alone does not land.
// - `resize()` and `getSize()` THROW before the group has laid out; every call
//   is guarded, or the throw unmounts the whole view.
// - Sizes are remembered at the END of a gesture (the group's onLayoutChanged),
//   never from onResize, and only while nothing beside them is folded.
// - Several regions reopen one at a time, each with its own flushSync, or the
//   second is still at zero while the first is being resized.
//
// NEW HERE: the film and the text can sit in either area, and as tabs of one.
// Their content is rendered once, through a portal into a host element this
// hook owns, and the HOST is moved between the areas' content boxes. A portal
// whose container changes remounts everything under it; a host that moves
// keeps it all mounted — the text table keeps its rows, the film keeps playing.
// Except a YouTube film: it is an iframe, and a browser reloads an iframe that
// moves. The host announces each move first (DOCK_HOST_MOVING), and the film
// pane rebuilds that picture where it lands, from where it was.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { usePanelRef } from "react-resizable-panels"
import {
  canRestore as canRestoreFrom,
  DOCK_AREAS,
  DOCK_HOST_MOVING,
  DOCK_PANELS,
  dockView,
  enterFullScreen,
  foldRegion,
  fullScreenRegion,
  movePanel,
  readStoredDock,
  restoreFromFullScreen,
  showPanel,
  startDockLayout,
  unfoldRegion,
  writeStoredDock,
  type DockArea,
  type DockLayout,
  type DockPanel,
  type DockRegion,
  type DockView,
} from "./media-dock-layout"
import type { StartingLayout } from "./media-layout-start"
import {
  clearStoredTimelinePaneHeight,
  MEDIA_BODY_MIN_HEIGHT,
  readStoredTimelinePaneHeight,
  TIMELINE_PANE_MAX_SHARE,
  TIMELINE_PANE_MIN_HEIGHT,
  writeStoredTimelinePaneHeight,
} from "./timeline-pane-layout"
import {
  clearStoredVideoPaneWidth,
  readStoredVideoPaneWidth,
  VIDEO_PANE_MIN_WIDTH,
  VIDEO_PANE_TABLE_MIN_WIDTH,
  writeStoredVideoPaneWidth,
} from "./video-pane-layout"

/** A folded region measures this, and nothing else does: it takes no room. */
export const DOCK_FOLDED_PX = 0

/** Below a pixel is a fold; a real panel is never that small. */
const isFoldSized = (px: number) => px < 1

type PanelConstraints = {
  minSize?: number | string
  maxSize?: number | string
  collapsible?: boolean
  collapsedSize?: number
  groupResizeBehavior?: "preserve-pixel-size"
}

const PINNED: PanelConstraints = { minSize: DOCK_FOLDED_PX, maxSize: DOCK_FOLDED_PX }

/** The left panel, which full screen folds to its icon strip and restores. */
export interface DockLeftPanel {
  /** The tab it shows, or null while folded to its icon strip. */
  tab: string | null
  /** Narrow windows show it as an overlay sheet, not a rail: never folded here. */
  isRail: boolean
  setTab(tab: string | null): void
}

export interface UseMediaDockInput {
  fileId: string | null
  /** The media timeline is on screen (the media lens on a time-ordered file). */
  timelineStacked: boolean
  /** A film is linked and shown (`shouldShowVideoPane`). */
  filmPresent: boolean
  /** The sizes this file starts from, by its kind (media-layout-start.ts). */
  start: StartingLayout
  left: DockLeftPanel
  /** Blur whatever is being edited before the text goes out of sight. */
  onBeforeHideText?: () => void
}

/** Which region a DOM node belongs to, from the `data-media-region` on each. */
function regionOf(node: Element | null): DockRegion | null {
  const el = node?.closest?.("[data-media-region]")
  const v = el?.getAttribute("data-media-region")
  return v === "tl" || v === "ll" || v === "lr" ? v : null
}

/** Typing, where a bare key or ⌥+digit is text, not a command. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"
}

/** A dialog or a menu is open: Esc is theirs. */
function somethingModalOpen(): boolean {
  return Boolean(document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot="popover-content"]'))
}

/** Keep every scroll position under `root` across a DOM move, which resets them. */
function moveKeepingScroll(root: HTMLElement, into: HTMLElement): void {
  const kept: Array<[Element, number, number]> = []
  for (const el of root.querySelectorAll("*")) {
    if (el.scrollTop || el.scrollLeft) kept.push([el, el.scrollTop, el.scrollLeft])
  }
  into.appendChild(root)
  for (const [el, top, left] of kept) {
    el.scrollTop = top
    el.scrollLeft = left
  }
}

export function useMediaDock(input: UseMediaDockInput) {
  const { fileId, timelineStacked, filmPresent, start, left, onBeforeHideText } = input
  const presence = useMemo(() => ({ film: filmPresent }), [filmPresent])

  const [layout, setLayout] = useState<DockLayout>(() => readStoredDock(fileId) ?? startDockLayout())
  // Per file, read on switch: the panels do not remount with the file. Read
  // during the render that brings the new file, so no commit ever pairs one
  // file with the other's arrangement. Read in an effect, the switch's first
  // commit still held the old file's layout: the sizes were put on the old
  // file's areas (the film's width on what is now the text), and the old
  // layout was written under the new file's key.
  const [layoutFor, setLayoutFor] = useState(fileId)
  if (layoutFor !== fileId) {
    setLayoutFor(fileId)
    setLayout(readStoredDock(fileId) ?? startDockLayout())
  }
  // Written on change — only in the media lens, so a visit to the text lens
  // never writes what the reader arranged.
  useEffect(() => {
    if (!timelineStacked) return
    writeStoredDock(fileId, layout)
  }, [fileId, layout, timelineStacked])

  const view: DockView = useMemo(() => dockView(layout, presence), [layout, presence])
  const leftFolded = !left.isRail || left.tab === null
  const fullRegion = timelineStacked ? fullScreenRegion(view, leftFolded) : null
  const canRestore = timelineStacked && canRestoreFrom(view, leftFolded)

  // Opening the left panel by hand ends full screen: the note goes, and every
  // control reads Full screen again.
  useEffect(() => {
    if (left.isRail && left.tab !== null && layout.fullUndo.length > 0) {
      setLayout((l) => (l.fullUndo.length ? { ...l, fullUndo: [] } : l))
    }
  }, [left.isRail, left.tab, layout.fullUndo.length])

  const tlRef = usePanelRef()
  const bodyRef = usePanelRef()
  const llRef = usePanelRef()
  const lrRef = usePanelRef()
  const panelRefs = { tl: tlRef, ll: llRef, lr: lrRef } as const

  // ——— Sizes

  /** The film's area: the one whose width is remembered, while both areas show. */
  const filmArea: DockArea | null =
    view.isOpen("ll") && view.isOpen("lr") ? (view.areaOf("film") && view.present.includes("film") ? view.areaOf("film") : null) : null
  const tlHeight = () => readStoredTimelinePaneHeight(fileId ?? "", start.timelineHeight)
  const filmWidth = () => readStoredVideoPaneWidth(fileId, start.videoWidth)

  const safeSize = useCallback((region: DockRegion | "body"): number | null => {
    const ref = region === "body" ? bodyRef : panelRefs[region]
    try {
      return ref.current?.getSize().inPixels ?? null
    } catch {
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panel refs are stable
  }, [])
  const safeResize = useCallback((region: DockRegion | "body", px: number | string) => {
    const ref = region === "body" ? bodyRef : panelRefs[region]
    try {
      ref.current?.resize(px)
    } catch {
      /* the group has not laid out yet — defaultSize covers this commit */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- panel refs are stable
  }, [])

  /** Put the remembered sizes back on whatever is open now. */
  const applySizes = useCallback(
    (v: DockView) => {
      if (v.isOpen("tl") && v.bodyOpen) safeResize("tl", tlHeight())
      const both = v.isOpen("ll") && v.isOpen("lr")
      const fa = v.areaOf("film")
      if (both && fa && v.present.includes("film")) safeResize(fa, filmWidth())
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest file through the closures
    [safeResize, fileId, start.timelineHeight, start.videoWidth],
  )

  const minWidthOf = (area: DockArea) => (view.list(area).includes("text") ? VIDEO_PANE_TABLE_MIN_WIDTH : VIDEO_PANE_MIN_WIDTH)

  const constraints: Record<DockRegion | "body", PanelConstraints> = (() => {
    if (!timelineStacked) return { tl: {}, body: {}, ll: {}, lr: {} }
    const both = view.isOpen("ll") && view.isOpen("lr")
    const area = (a: DockArea): PanelConstraints => {
      if (!view.isOpen(a)) return PINNED
      if (!both) return {}
      return {
        minSize: minWidthOf(a),
        collapsible: true,
        collapsedSize: DOCK_FOLDED_PX,
        ...(a === filmArea ? { groupResizeBehavior: "preserve-pixel-size" as const } : {}),
      }
    }
    return {
      tl: !view.isOpen("tl")
        ? PINNED
        : view.bodyOpen
          ? { minSize: TIMELINE_PANE_MIN_HEIGHT, maxSize: TIMELINE_PANE_MAX_SHARE, collapsible: true, collapsedSize: DOCK_FOLDED_PX, groupResizeBehavior: "preserve-pixel-size" }
          // Alone (the row below pinned at zero) the timeline takes the whole
          // view, and there is no divider to drag it shut by.
          : { minSize: TIMELINE_PANE_MIN_HEIGHT, maxSize: "100%" },
      body: view.bodyOpen ? { minSize: MEDIA_BODY_MIN_HEIGHT } : PINNED,
      ll: area("ll"),
      lr: area("lr"),
    }
  })()

  // ——— Hosts: the film and the text render once, into these, and the hosts
  // move between the areas' content boxes.

  const [hosts] = useState(() => {
    const make = (panel: DockPanel) => {
      if (typeof document === "undefined") return null
      const el = document.createElement("div")
      el.className = "flex h-full min-h-0 w-full min-w-0 flex-col"
      el.dataset.mediaPanel = panel
      return el
    }
    return { film: make("film"), text: make("text") } as Record<DockPanel, HTMLDivElement | null>
  })
  const boxesRef = useRef<Record<DockArea, HTMLElement | null>>({ ll: null, lr: null })
  const parkingRef = useRef<HTMLElement | null>(null)
  const latest = useRef({ view, timelineStacked })
  latest.current = { view, timelineStacked }

  /** Put each host in its area's box (or the parking spot), the shown tab visible. */
  const place = useCallback(() => {
    const { view: v, timelineStacked: stacked } = latest.current
    for (const panel of DOCK_PANELS) {
      const host = hosts[panel]
      if (!host) continue
      const area = v.areaOf(panel)
      const box = (area && boxesRef.current[area]) || parkingRef.current
      if (box && host.parentElement !== box) {
        // A first placement moves nothing that has loaded; a move does.
        if (host.parentElement) host.dispatchEvent(new Event(DOCK_HOST_MOVING))
        moveKeepingScroll(host, box)
      }
      // The text lens shows the text alone, whatever tab its area has up.
      const shown = stacked ? area !== null && v.activeOf(area) === panel : panel === "text"
      host.style.display = shown ? "" : "none"
    }
  }, [hosts])

  const boxRefs = useMemo(
    () =>
      Object.fromEntries(
        DOCK_AREAS.map((a) => [
          a,
          (el: HTMLElement | null) => {
            boxesRef.current[a] = el
            place()
          },
        ]),
      ) as Record<DockArea, (el: HTMLElement | null) => void>,
    [place],
  )
  const parkingBoxRef = useCallback(
    (el: HTMLElement | null) => {
      parkingRef.current = el
      place()
    },
    [place],
  )
  useLayoutEffect(() => {
    place()
  }, [place, view, timelineStacked])

  // ——— Folded areas keep their content at the size it last had, so nothing
  // inside re-lays-out at zero (the text table keeps its rows measured).

  const frozenRef = useRef<Partial<Record<DockRegion, { width: number; height: number }>>>({})
  const lastOpenRef = useRef<Partial<Record<DockRegion, number>>>({})
  // A size noted on one file is never remembered for the next.
  useEffect(() => {
    lastOpenRef.current = {}
  }, [fileId])
  const timelineContentRef = useRef<HTMLElement | null>(null)
  const freeze = useCallback((region: DockRegion) => {
    const el = region === "tl" ? timelineContentRef.current : boxesRef.current[region]
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) frozenRef.current[region] = { width: r.width, height: r.height }
  }, [])
  const timelineContentBoxRef = useCallback((el: HTMLElement | null) => {
    timelineContentRef.current = el
  }, [])

  const textGoingOutOfSight = useCallback(
    (next: DockView) => {
      if (view.isShowing("text") && !next.isShowing("text")) onBeforeHideText?.()
    },
    [view, onBeforeHideText],
  )

  // ——— Actions

  const fold = useCallback(
    (region: DockRegion) => {
      const next = foldRegion(layout, presence, region)
      if (next === layout) return
      textGoingOutOfSight(dockView(next, presence))
      freeze(region)
      setLayout(next)
    },
    [freeze, layout, presence, textGoingOutOfSight],
  )

  /** Apply a layout that unfolds things: state first, then the sizes.
   *  `alongside` is another update that has to land in the same commit. */
  const commitOpening = useCallback(
    (next: DockLayout, alongside?: () => void) => {
      const before = view
      flushSync(() => {
        setLayout(next)
        alongside?.()
      })
      const v = dockView(next, presence)
      for (const r of ["tl", "ll", "lr"] as const) {
        if (!before.isOpen(r) && v.isOpen(r)) delete frozenRef.current[r]
      }
      applySizes(v)
    },
    [applySizes, presence, view],
  )

  const unfold = useCallback(
    (region: DockRegion) => {
      // Already open (Alt+1 on a full-screen timeline): nothing to unfold, and
      // full screen's way back stays.
      if (!layout.folded[region]) return
      commitOpening(unfoldRegion(layout, region))
    },
    [commitOpening, layout],
  )

  const show = useCallback(
    (target: DockPanel | "timeline") => {
      if (target === "timeline") {
        unfold("tl")
        return
      }
      if (!view.present.includes(target)) return
      const next = showPanel(layout, target)
      textGoingOutOfSight(dockView(next, presence))
      commitOpening(next)
    },
    [commitOpening, layout, presence, textGoingOutOfSight, unfold, view],
  )

  /**
   * Hide a panel that is showing. A tab beside another panel: that one shows
   * instead, and the area stays (Sources › Hide film did this first). Alone in
   * its area: the area folds. Folding a shared area would take the other tab
   * out of sight with it.
   */
  const hide = useCallback(
    (panel: DockPanel) => {
      const area = view.areaOf(panel)
      if (!area || !view.isShowing(panel)) return
      const other = view.list(area).find((p) => p !== panel)
      if (other) show(other)
      else fold(area)
    },
    [fold, show, view],
  )

  const move = useCallback(
    (panel: DockPanel, to: DockArea) => {
      const next = movePanel(layout, panel, to)
      if (next === layout) return
      textGoingOutOfSight(dockView(next, presence))
      commitOpening(next)
    },
    [commitOpening, layout, presence, textGoingOutOfSight],
  )

  /** Give a region the whole view: fold the others and the left panel. */
  const enterFull = useCallback(
    (region: DockRegion) => {
      const leftTab = left.isRail ? left.tab : null
      const { layout: next, foldLeft } = enterFullScreen(layout, presence, region, leftTab)
      textGoingOutOfSight(dockView(next, presence))
      for (const r of ["tl", "ll", "lr"] as const) if (r !== region && view.isOpen(r)) freeze(r)
      const foldLeftPanel = foldLeft ? () => left.setTab(null) : undefined
      if (layout.folded[region]) {
        // The left panel folds in the SAME commit as the unfold. flushSync
        // runs that commit's effects before it returns, so the one above that
        // ends full screen when the left panel is open saw it still open and
        // dropped the note just written: Esc then restored nothing.
        commitOpening(next, foldLeftPanel)
      } else {
        setLayout(next)
        foldLeftPanel?.()
      }
    },
    [commitOpening, freeze, layout, left, presence, textGoingOutOfSight, view],
  )

  /** Unfold exactly what full screen folded, one region at a time. */
  const restore = useCallback(() => {
    const { layout: target, leftTab } = restoreFromFullScreen(layout)
    if (target === layout) return
    let current = layout
    for (const r of ["tl", "ll", "lr"] as const) {
      if (current.folded[r] && !target.folded[r]) {
        current = { ...current, folded: { ...current.folded, [r]: false }, fullUndo: [] }
        commitOpening(current)
      }
    }
    if (current.fullUndo.length) flushSync(() => setLayout({ ...current, fullUndo: [] }))
    if (leftTab) left.setTab(leftTab)
  }, [commitOpening, layout, left])

  const toggleFull = useCallback(
    (region: DockRegion) => {
      if (fullRegion === region && canRestore) restore()
      else if (fullRegion === region) {
        // Full screen by hand (everything else folded one by one): nothing was
        // recorded, so restoring opens everything there is.
        let current = layout
        for (const r of ["tl", "ll", "lr"] as const) {
          if (current.folded[r] && view.exists(r)) {
            current = unfoldRegion(current, r)
            commitOpening(current)
          }
        }
      } else enterFull(region)
    },
    [canRestore, commitOpening, enterFull, fullRegion, layout, restore, view],
  )

  /** Click on a tab: show it in its area. */
  const activate = useCallback((panel: DockPanel) => show(panel), [show])

  /** "Reset layout": forget this file's arrangement and its sizes. */
  const resetLayout = useCallback(() => {
    writeStoredDock(fileId, null)
    clearStoredTimelinePaneHeight(fileId ?? "")
    clearStoredVideoPaneWidth(fileId)
    lastOpenRef.current = {}
    const home = startDockLayout()
    // Arrangement first (areas and tabs), folds still as they are; then each
    // folded region reopens on its own, as restore does.
    let current: DockLayout = { ...home, folded: { ...layout.folded }, fullUndo: [] }
    textGoingOutOfSight(dockView(current, presence))
    commitOpening(current)
    for (const r of ["tl", "ll", "lr"] as const) {
      if (current.folded[r]) {
        current = { ...current, folded: { ...current.folded, [r]: false } }
        commitOpening(current)
      }
    }
    frozenRef.current = {}
    if (left.isRail && left.tab === null && layout.fullUndo.some((u) => u.startsWith("left:"))) {
      const tab = layout.fullUndo.find((u) => u.startsWith("left:"))!.slice("left:".length)
      left.setTab(tab)
    }
  }, [commitOpening, fileId, layout, left, presence, textGoingOutOfSight])

  // ——— Hearing the library

  /** Records only (see the note at the top): the size to remember at pointer-up. */
  const noteResize = useCallback((region: DockRegion, px: number) => {
    if (!isFoldSized(px)) lastOpenRef.current[region] = px
  }, [])

  /**
   * Once per settled layout. A drag that shut a region folds it; a size that
   * ENDED a gesture open is remembered. Only the reader's own gestures count:
   * a layout the library settled on by itself (a window resize, or our own
   * resize while reopening one region after another) is never read as a fold,
   * which is what used to shut the second of two regions reopened together.
   */
  const noteLayoutSettled = useCallback(
    (meta: { isUserInteraction: boolean }) => {
      if (!timelineStacked || !meta.isUserInteraction) return
      let next = layout
      for (const r of ["tl", "ll", "lr"] as const) {
        if (!view.isOpen(r)) continue
        const px = safeSize(r)
        if (px !== null && isFoldSized(px)) next = foldRegion(next, presence, r)
      }
      if (next !== layout) {
        textGoingOutOfSight(dockView(next, presence))
        setLayout(next)
        return
      }
      const tl = lastOpenRef.current.tl
      if (tl && view.isOpen("tl") && view.bodyOpen) writeStoredTimelinePaneHeight(fileId ?? "", tl)
      const fw = filmArea ? lastOpenRef.current[filmArea] : undefined
      if (fw && filmArea) writeStoredVideoPaneWidth(fileId, fw)
    },
    [fileId, filmArea, layout, presence, safeSize, textGoingOutOfSight, timelineStacked, view],
  )

  /**
   * Make sure a folded region is AT zero. The pin is supposed to be enough and
   * usually is; a state where it was not (one fold already in place, then a
   * second by button) left a folded panel at full width (AQU-1119). Measured,
   * and driven to zero if it is not there.
   */
  const repairsRef = useRef(0)
  useEffect(() => {
    if (!timelineStacked) return
    for (const r of ["tl", "ll", "lr"] as const) {
      if (!view.exists(r) || view.isOpen(r)) continue
      const px = safeSize(r)
      if (px !== null && !isFoldSized(px)) {
        repairsRef.current++
        safeResize(r, DOCK_FOLDED_PX)
      }
    }
    if (!view.bodyOpen) {
      const px = safeSize("body")
      if (px !== null && !isFoldSized(px)) {
        repairsRef.current++
        safeResize("body", DOCK_FOLDED_PX)
      }
    }
    // …and the other way: a region the layout says is OPEN, left at zero by
    // the group, is sized back out (Sam, Oct 28: Film and Text ticked, the
    // row below the timeline drawn empty). Reproduced in WebKit: after a move
    // and a fold, Text was ticked and its area 0 px wide. The layout is the
    // truth, and the sizes follow it both ways. On the next frame: in this
    // commit the group may still hold the area at its folded pin (max 0), and
    // a resize now would be clamped straight back to zero.
    const reopenShut = () => {
      const shut = (r: DockRegion | "body") => {
        const px = safeSize(r)
        return px !== null && isFoldSized(px)
      }
      if (view.isOpen("tl") && view.bodyOpen && (shut("tl") || shut("body"))) {
        repairsRef.current++
        try {
          if (panelRefs.tl.current?.isCollapsed()) panelRefs.tl.current?.expand()
        } catch {
          /* not laid out yet */
        }
        safeResize("tl", tlHeight())
      } else if (!view.isOpen("tl") && view.bodyOpen && shut("body")) {
        repairsRef.current++
        safeResize("body", "100%")
      }
      const both = view.isOpen("ll") && view.isOpen("lr")
      for (const r of ["ll", "lr"] as const) {
        if (!view.isOpen(r) || !shut(r)) continue
        repairsRef.current++
        // A panel the group holds COLLAPSED stays collapsed when its
        // neighbour is resized (full screen, then a move, left the text so):
        // it has to be expanded first.
        try {
          if (panelRefs[r].current?.isCollapsed()) panelRefs[r].current?.expand()
        } catch {
          /* not laid out yet */
        }
        if (!both) {
          safeResize(r, "100%")
        } else if (filmArea) {
          // The film at its remembered width, leaving the text its minimum.
          const other = filmArea === "ll" ? "lr" : "ll"
          const row = (safeSize("ll") ?? 0) + (safeSize("lr") ?? 0)
          const room = row > 0 ? row - minWidthOf(other) : filmWidth()
          safeResize(filmArea, Math.max(minWidthOf(filmArea), Math.min(filmWidth(), room)))
        } else {
          safeResize(r, "50%")
        }
      }
    }
    const frame = requestAnimationFrame(reopenShut)
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest sizes through the closures
  }, [safeResize, safeSize, timelineStacked, view])

  /**
   * On a file switch or a return from the text lens, the remembered sizes —
   * on the next frame. Files arrange their areas differently (one has the film
   * bottom right, the next bottom left), and the group takes the panels' new
   * minimums only on the render after this commit; a width put on now is held
   * to the old file's floors.
   */
  useEffect(() => {
    if (!timelineStacked) return
    const frame = requestAnimationFrame(() => applySizes(latest.current.view))
    return () => cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per file / lens, not per fold
  }, [fileId, timelineStacked, filmPresent])

  // ——— The Panels menu, and the keyboard

  const [panelsOpen, setPanelsOpen] = useState(false)
  const keys = useRef({ toggleFull, fold, restore, show, canRestore, fullRegion })
  keys.current = { toggleFull, fold, restore, show, canRestore, fullRegion }
  useEffect(() => {
    if (!timelineStacked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const mod = e.metaKey || e.ctrlKey
      const k = keys.current
      if (mod && !e.shiftKey && !e.altKey && e.code === "Backslash") {
        e.preventDefault()
        e.stopPropagation()
        setPanelsOpen((o) => !o)
        return
      }
      if (mod && e.shiftKey && !e.altKey && (e.code === "KeyF" || e.code === "KeyH")) {
        e.preventDefault()
        e.stopPropagation()
        const region = regionOf(document.activeElement) ?? k.fullRegion ?? "tl"
        if (e.code === "KeyF") k.toggleFull(region)
        else k.fold(region)
        return
      }
      if (e.key === "Escape" && !mod && !e.altKey && k.canRestore && !isTyping(e.target) && !somethingModalOpen()) {
        e.preventDefault()
        k.restore()
        return
      }
      if (e.altKey && !mod && !e.shiftKey && !isTyping(e.target)) {
        const target = ({ Digit1: "timeline", Digit2: "film", Digit3: "text" } as const)[e.code as "Digit1"]
        if (target) {
          e.preventDefault()
          k.show(target)
        }
      }
    }
    // Capture, so the workspace's own ⌘⇧F (search across all files) does not
    // also fire in the media view, where ⌘⇧F is full screen.
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [timelineStacked])

  // ——— The console seam, in the shape of __aqQueueState: what the browser
  // pass reads, and how the next Safari-only bug gets diagnosed.
  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return
    const win = window as unknown as { __aqMediaDock?: () => unknown }
    win.__aqMediaDock = () => ({
      fileId,
      layout,
      present: view.present,
      open: view.openRegions,
      fullScreen: fullRegion,
      canRestore,
      leftTab: left.tab,
      repairs: repairsRef.current,
      sizes: {
        tl: safeSize("tl"),
        body: safeSize("body"),
        ll: view.exists("ll") ? safeSize("ll") : null,
        lr: view.exists("lr") ? safeSize("lr") : null,
      },
    })
    return () => {
      delete win.__aqMediaDock
    }
  }, [canRestore, fileId, fullRegion, layout, left.tab, safeSize, view])

  return {
    layout,
    view,
    /** The region with the whole view, or null. Derived, never stored. */
    fullRegion,
    canRestore,
    constraints,
    panelRefs,
    bodyRef,
    /** The film's area while both areas show — it carries the remembered width. */
    filmArea,
    defaults: { tlHeight: tlHeight(), filmWidth: filmWidth() },
    hosts,
    boxRefs,
    parkingBoxRef,
    timelineContentBoxRef,
    frozen: frozenRef.current,
    separatorDisabled: (between: "tl-body" | "ll-lr") =>
      between === "tl-body" ? !(view.isOpen("tl") && view.bodyOpen) : !(view.isOpen("ll") && view.isOpen("lr")),
    fold,
    unfold,
    show,
    hide,
    move,
    activate,
    toggleFull,
    restore,
    resetLayout,
    noteResize,
    noteLayoutSettled,
    panelsOpen,
    setPanelsOpen,
  }
}

export type MediaDock = ReturnType<typeof useMediaDock>
