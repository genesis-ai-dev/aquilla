import * as React from "react"
import { LegendList, type LegendListRenderItemProps } from "@legendapp/list/react"
import type { Row } from "@tanstack/react-table"

/** Measured / allocated column widths so per-row tables match at panel width. */
const VirtualColumnWidthsContext = React.createContext<number[] | null>(null)

function useVirtualColumnWidths() {
  return React.useContext(VirtualColumnWidthsContext)
}

const NAME_MIN_PX = 16 * 16
const SECONDARY_FLEX_PX = 10 * 16

function parseColWidthPx(metaClass: string): number | null {
  const rem = metaClass.match(/(?:^|\s)w-\[([0-9.]+)rem\]/)
  if (rem) return parseFloat(rem[1]) * 16
  const px = metaClass.match(/(?:^|\s)w-\[([0-9.]+)px\]/)
  if (px) return parseFloat(px[1])
  const tw = metaClass.match(/(?:^|\s)w-(\d+)\b/)
  if (tw) return parseInt(tw[1], 10) * 4
  return null
}

/**
 * Name (first unconstrained column) gets leftover space, with a floor so it
 * does not collapse next to many `w-[…rem]` metric columns. Secondary flex
 * columns (Language, …) get a modest fixed width. If the floor does not fit,
 * the table grows and the outer overflow-x scroller handles it.
 */
function allocateColumnWidths(hints: (number | null)[], containerPx: number): number[] {
  const flexIdx = hints
    .map((w, i) => (w == null ? i : -1))
    .filter((i) => i >= 0)
  const fixedSum = hints.reduce<number>((sum, w) => sum + (w ?? 0), 0)
  const secondaryCount = Math.max(flexIdx.length - 1, 0)
  const secondaryTotal = secondaryCount * SECONDARY_FLEX_PX
  let namePx = containerPx - fixedSum - secondaryTotal
  if (namePx < NAME_MIN_PX) namePx = NAME_MIN_PX
  let flexN = 0
  const raw = hints.map((w) => {
    if (w != null) return w
    return flexN++ === 0 ? namePx : SECONDARY_FLEX_PX
  })
  const total = raw.reduce((sum, w) => sum + w, 0)
  if (containerPx > 0 && total > containerPx) {
    const scale = containerPx / total
    return raw.map((w) => Math.floor(w * scale))
  }
  return raw
}

/**
 * Virtualized body for `DataTable` when `fillHeight` is on. LegendList owns
 * vertical scroll; a shared overflow-x wrapper keeps the sticky header and
 * per-row tables aligned horizontally. Each item is its own `<table>` because
 * LegendList absolutely positions rows — a real `<tr>` cannot be its child.
 */
function VirtualizedDataTableBody<TData>({
  rows,
  extraData,
  estimatedItemSize,
  header,
  renderRow,
  onEndReached,
  footer,
  columnWidthHints,
}: {
  rows: Row<TData>[]
  extraData: unknown
  estimatedItemSize: number
  header: React.ReactNode
  renderRow: (row: Row<TData>) => React.ReactNode
  onEndReached?: () => void
  /** Element or null — LegendList's ListFooterComponent does not take arbitrary ReactNode. */
  footer: React.ReactElement | null
  columnWidthHints: (number | null)[]
}) {
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const [widths, setWidths] = React.useState<number[] | null>(null)

  React.useLayoutEffect(() => {
    const root = scrollerRef.current
    if (!root) return

    const apply = () => {
      const containerPx = root.clientWidth
      if (containerPx <= 0) return
      const next = allocateColumnWidths(columnWidthHints, containerPx)
      setWidths((prev) =>
        prev && prev.length === next.length && prev.every((w, i) => w === next[i])
          ? prev
          : next,
      )
    }

    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(root)
    return () => observer.disconnect()
  }, [columnWidthHints])

  const renderItem = React.useCallback(
    ({ item }: LegendListRenderItemProps<Row<TData>>) => renderRow(item),
    [renderRow],
  )

  const listExtraData = React.useMemo(
    () => ({ extraData, widths }),
    [extraData, widths],
  )

  const minWidth = widths?.reduce((sum, w) => sum + w, 0)

  return (
    <VirtualColumnWidthsContext.Provider value={widths}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          ref={scrollerRef}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto overflow-y-hidden"
        >
          <div
            className="flex h-full min-h-0 w-full flex-col"
            style={minWidth != null ? { minWidth } : undefined}
          >
            <div className="shrink-0">{header}</div>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <LegendList
                data={rows}
                extraData={listExtraData}
                renderItem={renderItem}
                keyExtractor={(row) => row.id}
                estimatedItemSize={estimatedItemSize}
                recycleItems={false}
                // Do not set maintainVisibleContentPosition. That flag is for
                // chat-style inserts: it pins the currently visible *item* (by
                // id) when `data` changes. A column sort reorders the same ids,
                // so the list would scroll to keep the old first row on screen
                // and the scrollbar thumb jumps. Append-at-end load-more does
                // not need it; pixel scroll already stays put.
                onEndReached={onEndReached ? () => onEndReached() : undefined}
                onEndReachedThreshold={0.4}
                ListFooterComponent={footer}
                style={{ flex: 1, minHeight: 0, height: "100%" }}
                contentContainerStyle={{ width: "100%" }}
              />
            </div>
          </div>
        </div>
      </div>
    </VirtualColumnWidthsContext.Provider>
  )
}

export {
  VirtualizedDataTableBody,
  useVirtualColumnWidths,
  parseColWidthPx,
  allocateColumnWidths,
}
