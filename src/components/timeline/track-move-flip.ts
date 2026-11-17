// "Move to" in a track's menu changes folders with no drag in progress, so
// there is no pointer travel to release from. The rows are measured when the
// choice is made and, once the move paints, slid from there to their new
// places on the curve a drop's release uses, the moved tracks lifted over the
// rows they cross as a dragged row is.

import { prefersReducedMotion, trackSlideMotion } from "./track-gutter-dnd"

/** A move that has not painted by now is not the one these rects describe. */
export const TRACK_MOVE_MAX_WAIT_MS = 1200

export type TrackMoveSnapshot = {
  at: number
  tops: ReadonlyMap<string, number>
  /** Padding-left of each row's indent, before the move. A menu move remounts
   *  the row, so the CSS padding transition on it never runs. */
  indents: ReadonlyMap<string, number>
  /** The tracks being moved, each with the folder it was in. */
  moving: ReadonlyMap<string, string | null>
}

/** Every gutter row and every copy of every lane, keyed so the same element
 *  can be found again after the move re-renders (or remounts) it. */
function trackNodes(root: ParentNode): Map<string, HTMLElement> {
  const nodes = new Map<string, HTMLElement>()
  for (const node of root.querySelectorAll<HTMLElement>("[data-tl-track-id]")) {
    nodes.set(`row:${node.getAttribute("data-tl-track-id")}`, node)
  }
  const copies = new Map<string, number>()
  for (const node of root.querySelectorAll<HTMLElement>("[data-tl-track-lane]")) {
    const id = node.getAttribute("data-tl-track-lane") ?? ""
    const n = copies.get(id) ?? 0
    copies.set(id, n + 1)
    nodes.set(`lane:${id}:${n}`, node)
  }
  return nodes
}

/** The content that steps in under a folder. The row's own box stays full width. */
function indentNode(row: HTMLElement): HTMLElement | null {
  const node = row.querySelector(":scope > [data-tl-track-indent]")
  return node instanceof HTMLElement ? node : null
}

function indentPx(row: HTMLElement): number {
  const node = indentNode(row)
  if (!node) return 0
  // Drop a transition that is about to run, so this is the padding the class
  // resolves to and not the value it is easing away from.
  const previous = node.style.transition
  node.style.transition = "none"
  const value = parseFloat(getComputedStyle(node).paddingLeft) || 0
  node.style.transition = previous
  return value
}

export function snapshotTrackMove(
  root: ParentNode,
  moving: ReadonlyArray<{ id: string; groupId: string | null }>,
): TrackMoveSnapshot {
  const tops = new Map<string, number>()
  const indents = new Map<string, number>()
  for (const [key, node] of trackNodes(root)) {
    tops.set(key, node.getBoundingClientRect().top)
    if (key.startsWith("row:")) indents.set(key, indentPx(node))
  }
  return { at: performance.now(), tops, indents, moving: new Map(moving.map((tr) => [tr.id, tr.groupId])) }
}

/** Has any moved track changed folder in this list yet? */
export function trackMoveLanded(
  snapshot: TrackMoveSnapshot,
  tracks: ReadonlyArray<{ id: string; groupId?: string | null }>,
): boolean {
  return tracks.some((tr) => snapshot.moving.has(tr.id) && snapshot.moving.get(tr.id) !== (tr.groupId ?? null))
}

function trackIdOf(key: string): string {
  return key.startsWith("row:") ? key.slice(4) : key.slice(5, key.lastIndexOf(":"))
}

/** The lanes are a virtualized list that places its rows a frame or more after
 *  the gutter's, so a lane measured with the rows has not moved yet. How long
 *  to wait for one before taking it as staying put. */
const LANE_SETTLE_MS = 250

/** Slide every row from where the snapshot saw it to where it is now. A row
 *  the move created (a new folder) fades in where it lands. A lane that lands
 *  late slides from the same place on the same clock, so it keeps level with
 *  its name instead of leaving the name sliding beside an empty lane. */
export function playTrackMove(root: ParentNode, snapshot: TrackMoveSnapshot): void {
  if (prefersReducedMotion()) return
  const handled = new Set<string>()
  /** Each name's slide. A lane joining late starts on its name's start time:
   *  a slide is pending until the next paint, which a busy render delays, so
   *  the wall clock since the move ran the lane ahead of its name. */
  const names = new Map<string, Animation>()
  const pass = () => {
    // Measure everything before animating anything: a running animation's
    // transform is part of the rect.
    const plans: { node: HTMLElement; key: string; dy: number | null }[] = []
    for (const [key, node] of trackNodes(root)) {
      if (handled.has(key)) continue
      const was = snapshot.tops.get(key)
      if (was == null) {
        plans.push({ node, key, dy: null })
        continue
      }
      const dy = was - node.getBoundingClientRect().top
      if (Math.abs(dy) >= 0.5) plans.push({ node, key, dy })
      else if (key.startsWith("row:")) {
        handled.add(key)
        easeIndent(node, key, snapshot, 0)
      }
    }
    for (const { node, key, dy } of plans) {
      handled.add(key)
      const isRow = key.startsWith("row:")
      if (isRow) easeIndent(node, key, snapshot, dy == null ? 0 : Math.abs(dy))
      const animation = slideTrackNode(node, key, dy, snapshot)
      if (!animation) continue
      if (isRow) names.set(trackIdOf(key), animation)
      else {
        const startTime = names.get(trackIdOf(key))?.startTime
        if (startTime != null) animation.startTime = startTime
      }
    }
  }
  pass()
  if (typeof MutationObserver !== "function") return
  // Caught as the list moves the lane, before that frame paints. Checking on
  // the next frame instead let the lane flash at its new place, ahead of its
  // name, and then jump back to slide.
  const observer = new MutationObserver(pass)
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["style"] })
  window.setTimeout(() => observer.disconnect(), LANE_SETTLE_MS)
}

/** Ease the indent across the same trip as the row. The node is new — the
 *  track just mounted inside its folder — so there is no CSS transition to
 *  carry the padding from where it was. */
function easeIndent(row: HTMLElement, key: string, snapshot: TrackMoveSnapshot, travelPx: number): void {
  const from = snapshot.indents.get(key)
  const content = indentNode(row)
  if (from == null || !content || typeof content.animate !== "function") return
  const to = indentPx(row)
  if (Math.abs(to - from) < 0.5) return
  content.style.transition = "none"
  const animation = content.animate(
    [{ paddingLeft: `${from}px` }, { paddingLeft: `${to}px` }],
    trackSlideMotion(Math.max(travelPx, Math.abs(to - from))),
  )
  const restore = () => { content.style.transition = "" }
  animation.addEventListener("finish", restore)
  animation.addEventListener("cancel", restore)
}

function slideTrackNode(node: HTMLElement, key: string, dy: number | null, snapshot: TrackMoveSnapshot): Animation | null {
  if (typeof node.animate !== "function") return null
  if (dy == null) return node.animate([{ opacity: 0 }, { opacity: 1 }], trackSlideMotion(0))
  const lifted = snapshot.moving.has(trackIdOf(key))
  const animation = node.animate(
    [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
    trackSlideMotion(Math.abs(dy)),
  )
  if (!lifted) return animation
  // The same lift a dragged row and its lane wear (see SortableTrackBlock
  // and the lane's `data-tl-lifted` classes), for the length of the trip.
  const isRow = key.startsWith("row:")
  const before = { zIndex: node.style.zIndex, background: node.style.backgroundColor }
  if (isRow) {
    node.style.zIndex = "40"
    if (!node.hasAttribute("data-selected")) node.style.backgroundColor = "var(--color-background)"
  } else {
    node.setAttribute("data-tl-lifted", "")
  }
  const land = () => {
    if (isRow) {
      node.style.zIndex = before.zIndex
      node.style.backgroundColor = before.background
    } else {
      node.removeAttribute("data-tl-lifted")
    }
  }
  animation.addEventListener("finish", land)
  animation.addEventListener("cancel", land)
  return animation
}
