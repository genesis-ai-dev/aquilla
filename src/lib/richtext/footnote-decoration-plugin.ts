// Computes the visible label / tooltip / ordinal for each footnote NODE and
// hands them to the node's NodeView via a node decoration. Numbering depends on
// the chapter-level `numberOffset` (footnotes in earlier cells), which lives
// outside the doc — so this rebuilds on doc change or on an explicit "rebuild"
// meta dispatched when the offset / tooltip preference changes.
//
// IMPORTANT: this set is NOT rebuilt on selection change. The selected-state
// highlight is left entirely to the browser's native text selection (it paints
// over the contenteditable=false pill just fine — verified in WebKit/Blink).
// An earlier version toggled a "selected" class here on every selectionChanged,
// which recreated every node decoration's spec object each cursor move and made
// ProseMirror re-render the footnote NodeViews' DOM mid-selection. Real Safari
// reacts to that mid-selection DOM mutation by collapsing/ballooning the live
// selection (the "selects the whole row, then corrects on the next press" bug).
//
// The footnote itself is an atomic node (see footnote-node.ts); this plugin only
// decorates it, it does not hide or render raw text.

import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { extractUsfmFootnotes } from "@/lib/footnotes/extract"
import { FOOTNOTE_NODE_NAME } from "@/lib/richtext/usfm-plain-text"
import { FOOTNOTE_DECORATION_SPEC, type FootnoteMarkerInfo } from "@/lib/richtext/footnote-node"

export const footnoteDecorationPluginKey = new PluginKey<DecorationSet>("footnoteDecorations")
export const measuredSelectionPluginKey = new PluginKey("measuredSelectionOverlay")

interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export interface MeasuredSelectionRect {
  left: number
  top: number
  width: number
  height: number
}

function docHasFootnote(doc: PMNode): boolean {
  let found = false
  doc.descendants((node) => {
    if (found) return false
    if (node.type.name === FOOTNOTE_NODE_NAME) {
      found = true
      return false
    }
    return true
  })
  return found
}

function shouldMeasureSelection(view: EditorView): boolean {
  const domDirection = view.dom.getAttribute("dir") || getComputedStyle(view.dom).direction
  return domDirection === "rtl" || docHasFootnote(view.state.doc)
}

function createDomRange(view: EditorView, from: number, to: number): Range | null {
  try {
    const start = view.domAtPos(from)
    const end = view.domAtPos(to)
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    return range
  } catch {
    return null
  }
}

export function normalizeMeasuredSelectionRects(
  rects: RectLike[],
  hostRect: RectLike,
  clipRect: RectLike,
  scrollLeft = 0,
  scrollTop = 0,
): MeasuredSelectionRect[] {
  const out: MeasuredSelectionRect[] = []
  const seen = new Set<string>()
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue
    const left = Math.max(rect.left, clipRect.left)
    const right = Math.min(rect.right, clipRect.right)
    const top = Math.max(rect.top, clipRect.top)
    const bottom = Math.min(rect.bottom, clipRect.bottom)
    const width = right - left
    const height = bottom - top
    if (width <= 0 || height <= 0) continue
    const measured = {
      left: left - hostRect.left + scrollLeft,
      top: top - hostRect.top + scrollTop,
      width,
      height,
    }
    const key = [
      Math.round(measured.left),
      Math.round(measured.top),
      Math.round(measured.width),
      Math.round(measured.height),
    ].join(":")
    if (seen.has(key)) continue
    seen.add(key)
    out.push(measured)
  }
  return out
}

function selectedFootnoteMarkerRects(view: EditorView, range: Range): DOMRect[] {
  const rects: DOMRect[] = []
  for (const marker of Array.from(view.dom.querySelectorAll<HTMLElement>(".usfm-footnote-marker"))) {
    try {
      if (range.intersectsNode(marker)) rects.push(marker.getBoundingClientRect())
    } catch {
      // Detached/re-rendered marker while a selection is changing. Ignore it;
      // the next view update will redraw against the current DOM.
    }
  }
  return rects
}

function renderMeasuredSelection(view: EditorView, overlay: HTMLElement, host: HTMLElement): void {
  const enabled = shouldMeasureSelection(view)
  overlay.replaceChildren()
  view.dom.classList.remove("pm-measured-selection")
  if (!enabled || view.state.selection.empty || !view.hasFocus()) return

  const from = Math.min(view.state.selection.from, view.state.selection.to)
  const to = Math.max(view.state.selection.from, view.state.selection.to)
  if (from === to) return

  const range = createDomRange(view, from, to)
  if (!range) return

  const hostRect = host.getBoundingClientRect()
  const clipRect = view.dom.getBoundingClientRect()
  const rects = normalizeMeasuredSelectionRects(
    [
      ...Array.from(range.getClientRects()),
      ...selectedFootnoteMarkerRects(view, range),
    ],
    hostRect,
    clipRect,
    host.scrollLeft,
    host.scrollTop,
  )
  if (rects.length === 0) return

  view.dom.classList.add("pm-measured-selection")
  for (const rect of rects) {
    const node = document.createElement("span")
    node.className = "pm-selection-overlay-rect"
    node.style.left = `${rect.left}px`
    node.style.top = `${rect.top}px`
    node.style.width = `${rect.width}px`
    node.style.height = `${rect.height}px`
    overlay.appendChild(node)
  }
}

function createMeasuredSelectionPlugin(): Plugin {
  return new Plugin({
    key: measuredSelectionPluginKey,
    view(view) {
      const host = view.dom.parentElement ?? view.dom
      host.classList.add("pm-selection-overlay-host")
      const overlay = document.createElement("div")
      overlay.className = "pm-selection-overlay"
      overlay.setAttribute("aria-hidden", "true")
      host.appendChild(overlay)

      let frame: number | null = null
      let resizeObserver: ResizeObserver | null = null
      const draw = () => {
        frame = null
        renderMeasuredSelection(view, overlay, host)
      }
      const schedule = () => {
        if (frame !== null) return
        frame = requestAnimationFrame(draw)
      }

      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(schedule)
        resizeObserver.observe(view.dom)
      }
      window.addEventListener("resize", schedule)
      window.addEventListener("scroll", schedule, { capture: true, passive: true })
      schedule()

      return {
        update() {
          schedule()
        },
        destroy() {
          if (frame !== null) cancelAnimationFrame(frame)
          resizeObserver?.disconnect()
          window.removeEventListener("resize", schedule)
          window.removeEventListener("scroll", schedule, { capture: true })
          overlay.remove()
          host.classList.remove("pm-selection-overlay-host")
          view.dom.classList.remove("pm-measured-selection")
        },
      }
    },
  })
}

export function buildFootnoteDecorationSet(
  doc: PMNode,
  numberOffset = 0,
  showTooltips = true,
): DecorationSet {
  const decorations: Decoration[] = []
  let ordinal = 0
  doc.descendants((node, pos) => {
    if (node.type.name !== FOOTNOTE_NODE_NAME) return true
    const raw = (node.attrs.raw as string) ?? ""
    const parsed = extractUsfmFootnotes(raw)[0]
    const caller = parsed?.caller ?? ""
    const ref = parsed?.ref ?? ""
    const text = parsed?.text ?? ""
    const explicit = caller && caller !== "+" && caller !== "-"
    const ariaLabel = `Footnote${ref ? ` ${ref}` : ""}${text ? `: ${text}` : ""}`
    const info: FootnoteMarkerInfo = {
      label: explicit ? caller : String(numberOffset + ordinal + 1),
      tooltip: text || ref || ariaLabel,
      ariaLabel,
      index: ordinal,
      showTooltips,
    }
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {}, { [FOOTNOTE_DECORATION_SPEC]: info }),
    )
    ordinal += 1
    return false
  })
  return decorations.length === 0 ? DecorationSet.empty : DecorationSet.create(doc, decorations)
}

export function createFootnoteDecorationExtension(
  getNumberOffset: () => number = () => 0,
  shouldShowTooltips: () => boolean = () => true,
) {
  return Extension.create({
    name: "footnoteDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: footnoteDecorationPluginKey,
          state: {
            init: (_, state) => buildFootnoteDecorationSet(
              state.doc,
              getNumberOffset(),
              shouldShowTooltips(),
            ),
            apply: (tr, old) => {
              if (tr.docChanged || tr.getMeta(footnoteDecorationPluginKey) === "rebuild") {
                return buildFootnoteDecorationSet(
                  tr.doc,
                  getNumberOffset(),
                  shouldShowTooltips(),
                )
              }
              return old.map(tr.mapping, tr.doc)
            },
          },
          props: {
            decorations(state) {
              return this.getState(state)
            },
          },
        }),
        createMeasuredSelectionPlugin(),
      ]
    },
  })
}
