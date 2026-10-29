// The media view's docking layout: which panel sits in which area, what is
// folded, and what full screen folded. (Media redesign, layout — the canvas's
// board 23 "your mix" and the docking boards 18/19, Sam, Oct 23–24.)
//
// Pure and localStorage-only, like the layout modules beside it: nothing in
// the suite renders ProjectWorkspace, so every rule lives where a unit test
// can reach it.
//
// THE MODEL. The timeline is the anchor across the top. Below it are two
// areas, Bottom left and Bottom right, and each holds one or more panels as
// tabs (today: Film and Text). Any region — the timeline or an area — can be
// FOLDED, and a folded region takes no space at all. Full screen is not a
// mode: it is folding every other region (and the left panel) and keeping a
// note of exactly what was folded, so "Restore the other panels" can unfold
// just those. Anything else that unfolds a region ends full screen and drops
// the note.

export type DockPanel = "film" | "text"
export type DockArea = "ll" | "lr"
export type DockRegion = "tl" | DockArea

export const DOCK_AREAS: readonly DockArea[] = ["ll", "lr"]
export const DOCK_REGIONS: readonly DockRegion[] = ["tl", "ll", "lr"]
export const DOCK_PANELS: readonly DockPanel[] = ["film", "text"]

/** What full screen folded, so restoring can unfold exactly that. "left:<tab>"
 *  is the left panel, with the tab it had open. */
export type UndoEntry = DockRegion | `left:${string}`

export interface DockLayout {
  areas: Record<DockArea, DockPanel[]>
  active: Record<DockArea, DockPanel | null>
  folded: Record<DockRegion, boolean>
  fullUndo: UndoEntry[]
}

// THE SIZES ARE NOT HERE. The timeline's height keeps the per-file key it
// already had (timeline-pane-layout.ts), and the film's width, one shared key
// before, is per file now and still reads the shared one for a file with none
// (video-pane-layout.ts), so nobody's remembered sizes are lost to this. With
// neither, a file starts from its kind's sizes (media-layout-start.ts).

/** Every file starts here: the film bottom left, the text bottom right. */
export function startDockLayout(): DockLayout {
  return {
    areas: { ll: ["film"], lr: ["text"] },
    active: { ll: "film", lr: "text" },
    folded: { tl: false, ll: false, lr: false },
    fullUndo: [],
  }
}

/** Which panels this file has right now. Text always; the film only when one
 *  is linked and shown (`shouldShowVideoPane`). */
export interface DockPresence {
  film: boolean
}

export interface DockView {
  layout: DockLayout
  present: DockPanel[]
  /** An area's panels that exist right now, as tabs in order. */
  list(area: DockArea): DockPanel[]
  /** The area a panel sits in, or null. */
  areaOf(panel: DockPanel): DockArea | null
  /** The tab an area shows. */
  activeOf(area: DockArea): DockPanel | null
  /** A region that exists: the timeline always, an area while it holds a panel. */
  exists(region: DockRegion): boolean
  /** On screen: exists and not folded. */
  isOpen(region: DockRegion): boolean
  openRegions: DockRegion[]
  /** The row below the timeline has something open. */
  bodyOpen: boolean
  /** Folding this would not empty the view. */
  canFold(region: DockRegion): boolean
  /** Is this panel on screen (its area open and it the active tab)? */
  isShowing(panel: DockPanel): boolean
}

export function dockView(layout: DockLayout, presence: DockPresence): DockView {
  const present = DOCK_PANELS.filter((p) => p === "text" || presence.film)
  const list = (area: DockArea) => layout.areas[area].filter((p) => present.includes(p))
  const areaOf = (panel: DockPanel) => DOCK_AREAS.find((a) => layout.areas[a].includes(panel)) ?? null
  const activeOf = (area: DockArea) => {
    const tabs = list(area)
    const a = layout.active[area]
    return a && tabs.includes(a) ? a : (tabs[0] ?? null)
  }
  const exists = (region: DockRegion) => region === "tl" || list(region).length > 0
  const isOpen = (region: DockRegion) => exists(region) && !layout.folded[region]
  const openRegions = DOCK_REGIONS.filter(isOpen)
  return {
    layout,
    present,
    list,
    areaOf,
    activeOf,
    exists,
    isOpen,
    openRegions,
    bodyOpen: isOpen("ll") || isOpen("lr"),
    canFold: (region) => isOpen(region) && openRegions.some((r) => r !== region),
    isShowing: (panel) => {
      const area = areaOf(panel)
      return area !== null && present.includes(panel) && isOpen(area) && activeOf(area) === panel
    },
  }
}

const clone = (l: DockLayout): DockLayout => ({
  areas: { ll: [...l.areas.ll], lr: [...l.areas.lr] },
  active: { ...l.active },
  folded: { ...l.folded },
  fullUndo: [...l.fullUndo],
})

/** Fold a region. Refused when it would leave nothing on screen. */
export function foldRegion(layout: DockLayout, presence: DockPresence, region: DockRegion): DockLayout {
  const v = dockView(layout, presence)
  if (!v.canFold(region)) return layout
  const next = clone(layout)
  next.folded[region] = true
  return next
}

/** Unfold a region by hand. Ends full screen: the note goes with it. A region
 *  already open unfolds nothing, so it ends nothing either: showing the
 *  timeline while it is the full-screen region keeps the way back. */
export function unfoldRegion(layout: DockLayout, region: DockRegion): DockLayout {
  if (!layout.folded[region]) return layout
  const next = clone(layout)
  next.folded[region] = false
  next.fullUndo = []
  return next
}

/** Show a panel: its area unfolds and it becomes the area's tab. Showing
 *  something that was folded ends full screen. */
export function showPanel(layout: DockLayout, panel: DockPanel): DockLayout {
  const area = DOCK_AREAS.find((a) => layout.areas[a].includes(panel))
  if (!area) return layout
  const next = clone(layout)
  if (next.folded[area]) next.fullUndo = []
  next.folded[area] = false
  next.active[area] = panel
  return next
}

/** Move a panel to another area, where it becomes the shown tab. */
export function movePanel(layout: DockLayout, panel: DockPanel, to: DockArea): DockLayout {
  const from = DOCK_AREAS.find((a) => layout.areas[a].includes(panel))
  if (from === to) return layout
  const next = clone(layout)
  if (from) {
    next.areas[from] = next.areas[from].filter((p) => p !== panel)
    if (next.active[from] === panel) next.active[from] = next.areas[from][0] ?? null
  }
  next.areas[to] = [...next.areas[to], panel]
  next.active[to] = panel
  if (next.folded[to]) next.fullUndo = []
  next.folded[to] = false
  return next
}

/**
 * The region that has the whole view: the only one open, with the left panel
 * folded too. Derived every time, never stored.
 */
export function fullScreenRegion(view: DockView, leftFolded: boolean): DockRegion | null {
  return view.openRegions.length === 1 && leftFolded ? view.openRegions[0] : null
}

/** Full screen with something to restore: the stored note is the way back. */
export function canRestore(view: DockView, leftFolded: boolean): boolean {
  return fullScreenRegion(view, leftFolded) !== null && view.layout.fullUndo.length > 0
}

/**
 * Give a region the whole view: fold every other open region and, when it is
 * open, the left panel (`leftTab`: the tab it shows). Keeps the note of what
 * it folded on top of any note already there, so pressing full screen on a
 * second region from full screen still restores the original arrangement.
 */
export function enterFullScreen(
  layout: DockLayout,
  presence: DockPresence,
  region: DockRegion,
  leftTab: string | null,
): { layout: DockLayout; foldLeft: boolean } {
  const v = dockView(layout, presence)
  if (!v.exists(region)) return { layout, foldLeft: false }
  const next = clone(layout)
  const undo: UndoEntry[] = [...next.fullUndo].filter((u) => u !== region)
  next.folded[region] = false
  for (const r of DOCK_REGIONS) {
    if (r === region || !v.isOpen(r)) continue
    next.folded[r] = true
    if (!undo.includes(r)) undo.push(r)
  }
  const foldLeft = leftTab !== null
  if (foldLeft && !undo.some((u) => u.startsWith("left:"))) undo.push(`left:${leftTab}`)
  next.fullUndo = undo
  return { layout: next, foldLeft }
}

/** Unfold exactly what full screen folded. Returns the left panel's tab to
 *  reopen, when it folded that too. */
export function restoreFromFullScreen(layout: DockLayout): { layout: DockLayout; leftTab: string | null } {
  if (layout.fullUndo.length === 0) return { layout, leftTab: null }
  const next = clone(layout)
  let leftTab: string | null = null
  for (const u of layout.fullUndo) {
    if (u.startsWith("left:")) leftTab = u.slice("left:".length)
    else next.folded[u as DockRegion] = false
  }
  next.fullUndo = []
  return { layout: next, leftTab }
}

/** Names for the Panels menu's note: what full screen folded. */
export function undoTargets(layout: DockLayout): Array<DockRegion | "left"> {
  return layout.fullUndo.map((u) => (u.startsWith("left:") ? "left" : (u as DockRegion)))
}

// ——— Storage: one key per file, per browser (this person's arrangement).

const KEY_PREFIX = "aquilla:mediaDock:"

function isPanel(x: unknown): x is DockPanel {
  return x === "film" || x === "text"
}

/** The stored arrangement, or null for anything missing or malformed — the
 *  file then starts from its kind's layout. */
export function readStoredDock(fileId: string | null | undefined): DockLayout | null {
  if (!fileId) return null
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}${fileId}`)
    if (!raw) return null
    const o = JSON.parse(raw) as Partial<DockLayout>
    const base = startDockLayout()
    const areas = {
      ll: Array.isArray(o.areas?.ll) ? o.areas!.ll.filter(isPanel) : base.areas.ll,
      lr: Array.isArray(o.areas?.lr) ? o.areas!.lr.filter(isPanel) : base.areas.lr,
    }
    // Each panel in exactly one area; a panel lost by a bad write goes home.
    areas.lr = areas.lr.filter((p) => !areas.ll.includes(p))
    for (const p of DOCK_PANELS) {
      if (!areas.ll.includes(p) && !areas.lr.includes(p)) areas[p === "film" ? "ll" : "lr"].push(p)
    }
    const active = {
      ll: isPanel(o.active?.ll) ? o.active!.ll : (areas.ll[0] ?? null),
      lr: isPanel(o.active?.lr) ? o.active!.lr : (areas.lr[0] ?? null),
    }
    const folded = {
      tl: o.folded?.tl === true,
      ll: o.folded?.ll === true,
      lr: o.folded?.lr === true,
    }
    const fullUndo = Array.isArray(o.fullUndo)
      ? o.fullUndo.filter((u): u is UndoEntry => typeof u === "string" && (DOCK_REGIONS.includes(u as DockRegion) || u.startsWith("left:")))
      : []
    return { areas, active, folded, fullUndo }
  } catch {
    return null
  }
}

export function writeStoredDock(fileId: string | null | undefined, layout: DockLayout | null): void {
  if (!fileId) return
  try {
    if (layout) localStorage.setItem(`${KEY_PREFIX}${fileId}`, JSON.stringify(layout))
    else localStorage.removeItem(`${KEY_PREFIX}${fileId}`)
  } catch {
    /* private mode — just won't persist */
  }
}
