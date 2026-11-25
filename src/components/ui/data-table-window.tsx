import * as React from "react"
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual"

/**
 * Row windowing for `DataTable`'s plain HTML table (AQU-2708).
 *
 * The admin lists have no page cap — Admin → Projects paints every project
 * that has ever existed — and one `<tr>` per row is what makes those pages
 * slow. This windows the rows with `@tanstack/react-virtual` while keeping a
 * single real `<table>`: only the rows near the scrollport are mounted, and
 * two spacer rows stand in for the ones that are not, so the table keeps its
 * full height and the scrollbar still means what it says.
 *
 * It is deliberately *not* the `fillHeight` path. That one (`data-table-virtual.tsx`)
 * mounts a LegendList and gives every row its own table, because LegendList
 * absolutely positions its items. Here the scrollport is an ancestor the table
 * already lives in, nothing is repositioned, and the rendered markup is the
 * same table the plain path renders — just fewer rows of it.
 */

/** `data-slot` of a spacer row, so a query for a real row can exclude it. */
const SPACER_SLOT = "row-window-spacer"

/** Attribute naming a windowed row's index in the whole list. */
const ROW_INDEX_ATTRIBUTE = "data-row-index"

/** Rows kept mounted above and below the scrollport, so a flick shows no gap. */
const ROW_OVERSCAN = 8

/**
 * Under this many rows the window would cover the whole list anyway (a ~600px
 * scrollport holds ~17 dense rows, plus overscan above and below), so small
 * tables stay exactly the plain table they are today and the virtualizer never
 * mounts.
 */
const MIN_WINDOWED_ROWS = 32

/**
 * A scrollport we cannot measure — happy-dom, or a pane still being laid out —
 * must not window the table down to nothing. Treat it as tall enough for every
 * row; the first real measurement narrows it.
 */
const UNMEASURED_SCROLLPORT_PX = 1_000_000

/**
 * Whether this element is a scrollport: it scrolls vertically *and* its height
 * is bounded by something other than its own content.
 *
 * Both halves are needed. CSS promotes `overflow-y` to `auto` whenever
 * `overflow-x` is not `visible`, so an `overflow-x-auto` wrapper — the one
 * `Table` puts around every table so wide columns can scroll sideways —
 * answers "auto" while still growing to fit every row it is given. Windowing
 * against that wrapper would window nothing: its scrollport *is* the whole
 * list. A pane that actually clips the list has content taller than its box.
 */
function isScrollport(node: HTMLElement): boolean {
  const overflowY = getComputedStyle(node).overflowY
  if (overflowY !== "auto" && overflowY !== "scroll" && overflowY !== "overlay") {
    return false
  }
  return node.clientHeight > 0 && node.scrollHeight - node.clientHeight > 1
}

/**
 * The nearest ancestor that scrolls its own box — the virtualizer's scrollport.
 *
 * Null when nothing between the table and the document scrolls: such a table
 * grows the page instead of scrolling inside a bounded pane, so there is no
 * window to compute and it stays a plain table (`DataTable` → `plainRows`).
 * The table is mounted whole when this runs, so a pane that will have to clip
 * the list is already overflowing and is found on the first look.
 */
function findScrollParent(from: HTMLElement | null): HTMLElement | null {
  let node = from?.parentElement ?? null
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollport(node)) return node
    node = node.parentElement
  }
  return null
}

/** The slice of rows to mount, and the height of what is left out. */
interface RowWindow {
  /** Row indexes to mount, in order. */
  indexes: number[]
  /** Height of the rows skipped before `indexes[0]`. */
  paddingTop: number
  /** Height of the rows skipped after the last index. */
  paddingBottom: number
  /** Ref for each mounted row, so its real height replaces the estimate. */
  measureRow: (element: HTMLElement | null) => void
}

/** What a windowed table needs to know about the pane it scrolls inside. */
interface Scrollport {
  element: HTMLElement
  /** A real row's height, for rows not yet mounted and measured. */
  rowPx: number
  /**
   * How far the first row sits below the top of the scrollport's content. The
   * virtualizer counts from the scrollport, not from the table, so without
   * this the window is off by the page header and the toolbar above it.
   */
  scrollMargin: number
}

function measureScrollMargin(body: HTMLElement, scrollport: HTMLElement): number {
  // The tbody's top is where row 0 starts, spacer or not, so this reads the
  // same before and after the body is windowed.
  return (
    body.getBoundingClientRect().top -
    scrollport.getBoundingClientRect().top +
    scrollport.scrollTop
  )
}

/**
 * Which rows of a table inside a bounded pane are worth mounting.
 *
 * Returns null — meaning "mount every row, as before" — when windowing does
 * not apply: the caller opted out, the list is short, or the table has no
 * scrolling ancestor to window against.
 *
 * Every mounted row is measured, so a row whose name wraps to three lines is
 * not taken for a one-line row: without that, a list of unequal rows ends in
 * the wrong place and its last rows cannot be scrolled to at all. The first
 * row is measured while the table is still plain, before the first windowed
 * render, so the whole list starts from a real row height rather than
 * settling visibly as the estimate is corrected.
 *
 * A row must therefore be one element. `DataTable` keeps a table with
 * `renderSubRow` detail rows plain, since there a row is two.
 */
function useRowWindow({
  rowCount,
  getRowKey,
  estimateRowPx,
  enabled,
  bodyRef,
}: {
  rowCount: number
  getRowKey: (index: number) => string | number
  estimateRowPx: number
  enabled: boolean
  bodyRef: React.RefObject<HTMLTableSectionElement | null>
}): RowWindow | null {
  const active = enabled && rowCount >= MIN_WINDOWED_ROWS
  const [scrollport, setScrollport] = React.useState<Scrollport | null>(null)

  React.useLayoutEffect(() => {
    const body = bodyRef.current
    const element = active ? findScrollParent(body) : null
    if (!element || !body) {
      setScrollport(null)
      return
    }
    // Measured now, with every row still mounted: the first row is a real
    // row. Matched by what it is not, because a row that carries a menu is
    // rendered by its context-menu trigger and does not keep the table-row
    // slot — only a spacer is reliably marked.
    const rowHeight =
      body
        .querySelector<HTMLElement>(`tr:not([data-slot="${SPACER_SLOT}"])`)
        ?.getBoundingClientRect().height ?? 0
    const measure = () =>
      setScrollport((prev) => {
        const next: Scrollport = {
          element,
          // 0 is a runtime without layout (happy-dom), not a row.
          rowPx: rowHeight > 0 ? rowHeight : (prev?.rowPx ?? estimateRowPx),
          scrollMargin: measureScrollMargin(body, element),
        }
        return prev &&
          prev.element === next.element &&
          prev.rowPx === next.rowPx &&
          Math.abs(prev.scrollMargin - next.scrollMargin) < 1
          ? prev
          : next
      })

    measure()
    // The toolbar above the table rewraps as the pane resizes, which moves the
    // first row relative to the scrollport's content.
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active, bodyRef, estimateRowPx])

  const virtualizer = useVirtualizer({
    enabled: active && scrollport != null,
    count: rowCount,
    getScrollElement: () => scrollport?.element ?? null,
    getItemKey: getRowKey,
    estimateSize: () => scrollport?.rowPx ?? estimateRowPx,
    overscan: ROW_OVERSCAN,
    scrollMargin: scrollport?.scrollMargin ?? 0,
    initialRect: { width: 0, height: UNMEASURED_SCROLLPORT_PX },
    // `DataTable` marks a windowed row with its index in the whole list.
    indexAttribute: ROW_INDEX_ATTRIBUTE,
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height
      // 0 is a runtime without layout, not a row of no height.
      return height > 0 ? height : (scrollport?.rowPx ?? estimateRowPx)
    },
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb({
          width: rect.width,
          height: rect.height > 0 ? rect.height : UNMEASURED_SCROLLPORT_PX,
        })
      }),
  })

  const items = virtualizer.getVirtualItems()
  if (!active || !scrollport || items.length === 0) return null

  // A virtual item's start/end are offsets in the scrollport, so they include
  // `scrollMargin`; `getTotalSize()` is the list's own height and does not.
  // Both paddings are heights inside the table, so take the margin back off.
  const totalSize = virtualizer.getTotalSize()
  const firstStart = items[0].start - scrollport.scrollMargin
  const lastEnd = items[items.length - 1].end - scrollport.scrollMargin
  return {
    indexes: items.map((item) => item.index),
    paddingTop: Math.max(0, firstStart),
    paddingBottom: Math.max(0, totalSize - lastEnd),
    measureRow: virtualizer.measureElement,
  }
}

/**
 * Stands in for the rows a window leaves out, so the table is as tall as its
 * whole list. Hidden from assistive tech and from role queries — it is a
 * measurement, not a row.
 */
function RowWindowSpacer({ height, colSpan }: { height: number; colSpan: number }) {
  if (height <= 0) return null
  return (
    <tr aria-hidden="true" data-slot={SPACER_SLOT} style={{ height }}>
      <td colSpan={colSpan} style={{ height, padding: 0, border: 0 }} />
    </tr>
  )
}

export { useRowWindow, RowWindowSpacer, ROW_INDEX_ATTRIBUTE }
export type { RowWindow }
