import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react"
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { ChevronLeft, ChevronRight, CheckIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/components/ui/combobox"

export interface ChapterNavigationItem {
  label: string
  displayLabel: string
  verseRange: string | null
  translated: number
  validated: number
  total: number
}

// Estimate only — real height comes from measureElement (no locked style.height).
const CHAPTER_ROW_HEIGHT_PX = 44

type ChapterListVirtualizer = ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>

export function chapterMatchesSearch(chapter: ChapterNavigationItem, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true

  if (/^\d+$/.test(normalizedQuery)) {
    const chapterNumber = chapter.label.match(/\s(\d+)$/)?.[1]
      ?? chapter.displayLabel.match(/\s(\d+)$/)?.[1]
    return chapterNumber === normalizedQuery
  }

  return `${chapter.displayLabel} ${chapter.label}`.toLocaleLowerCase().includes(normalizedQuery)
}

function VirtualizedChapterList({
  activeLabel,
  open,
  virtualizerRef,
}: {
  activeLabel: string
  open: boolean
  virtualizerRef: RefObject<ChapterListVirtualizer | null>
}) {
  const filteredItems = ComboboxPrimitive.useFilteredItems<ChapterNavigationItem>()
  const scrollElementRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    enabled: open,
    count: filteredItems.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => CHAPTER_ROW_HEIGHT_PX,
    overscan: 12,
    initialRect: { width: 320, height: 360 },
    // happy-dom reports 0×0 for CSS-sized scrollports; coerce so rows mount.
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb({
          width: rect.width > 0 ? rect.width : 320,
          height: rect.height > 0 ? rect.height : 360,
        })
      }),
  })

  useImperativeHandle(virtualizerRef, () => virtualizer)

  const handleScrollElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollElementRef.current = element
      if (element) virtualizer.measure()
    },
    [virtualizer],
  )

  useEffect(() => {
    if (!open || filteredItems.length === 0) return
    const index = filteredItems.findIndex((chapter) => chapter.label === activeLabel)
    if (index < 0) return
    queueMicrotask(() => {
      virtualizer.scrollToIndex(index, { align: "center" })
    })
  }, [activeLabel, filteredItems, open, virtualizer])

  const totalSize = virtualizer.getTotalSize()

  if (filteredItems.length === 0) return null

  return (
    <div
      role="presentation"
      className="h-72 max-h-[var(--available-height)] overflow-hidden p-1"
    >
      <div
        role="presentation"
        ref={handleScrollElementRef}
        className="h-full overflow-auto overscroll-contain scrollbar-thin"
      >
        <div role="presentation" className="relative w-full" style={{ height: totalSize }}>
          {virtualizer.getVirtualItems().map((virtualItem) => {
            const chapter = filteredItems[virtualItem.index]
            if (!chapter) return null

            const translatedPercent = chapter.total > 0
              ? Math.round((chapter.translated / chapter.total) * 100)
              : 0
            const isActive = chapter.label === activeLabel

            return (
              <ComboboxPrimitive.Item
                key={chapter.label}
                index={virtualItem.index}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                value={chapter}
                className="relative flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50"
                aria-setsize={filteredItems.length}
                aria-posinset={virtualItem.index + 1}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  width: "auto",
                  transform: `translateY(${virtualItem.start}px)`,
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium tabular-nums">{chapter.displayLabel}</span>
                  <span className="block text-xs tabular-nums text-muted-foreground">
                    {chapter.verseRange ? `Verses ${chapter.verseRange}` : `${chapter.total} cells`}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {translatedPercent}% translated
                </span>
                {isActive ? (
                  <CheckIcon className="size-4 shrink-0 text-foreground" aria-hidden="true" />
                ) : null}
              </ComboboxPrimitive.Item>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function ChapterNavigator({
  chapters,
  activeLabel,
  onSelect,
}: {
  chapters: ChapterNavigationItem[]
  activeLabel: string
  onSelect: (label: string) => void
}) {
  const [open, setOpen] = useState(false)
  const virtualizerRef = useRef<ChapterListVirtualizer | null>(null)
  const matchedActiveIndex = chapters.findIndex((chapter) => chapter.label === activeLabel)
  const activeIndex = matchedActiveIndex >= 0 ? matchedActiveIndex : 0
  const active = chapters[activeIndex]
  const canGoPrevious = activeIndex > 0
  const canGoNext = activeIndex >= 0 && activeIndex < chapters.length - 1

  const activeSummary = useMemo(() => {
    if (!active) return ""
    return active.verseRange ? `Verses ${active.verseRange}` : `${active.total} cells`
  }, [active])

  if (!active || chapters.length === 0) return null

  const choose = (label: string) => {
    onSelect(label)
  }

  return (
    <nav aria-label="Chapter navigation" className="flex items-center justify-center">
      <ButtonGroup aria-label="Move between chapters" className="shadow-xs">
        <Button
          variant="outline"
          size="icon"
          disabled={!canGoPrevious}
          aria-label="Previous chapter"
          onClick={() => choose(chapters[activeIndex - 1].label)}
        >
          <ChevronLeft />
        </Button>
        <Combobox
          items={chapters}
          value={active}
          open={open}
          onOpenChange={setOpen}
          virtualized
          autoHighlight
          onValueChange={(chapter) => {
            if (chapter) choose(chapter.label)
          }}
          itemToStringLabel={(chapter) => chapter.displayLabel}
          itemToStringValue={(chapter) => chapter.label}
          isItemEqualToValue={(a, b) => a.label === b.label}
          filter={(chapter, query) => chapterMatchesSearch(chapter, query)}
          onItemHighlighted={(chapter, { reason, index }) => {
            const virtualizer = virtualizerRef.current
            if (!chapter || !virtualizer || index < 0) return

            const isStart = index === 0
            const isEnd = index === virtualizer.options.count - 1
            // Match Base UI's virtualized Combobox guidance: scroll on
            // programmatic highlight, and on keyboard only at the edges
            // (in-window ArrowUp/Down is handled by the item DOM).
            const shouldScroll = reason === "none" || (reason === "keyboard" && (isStart || isEnd))
            if (!shouldScroll) return

            queueMicrotask(() => {
              virtualizer.scrollToIndex(index, { align: isEnd ? "start" : "end" })
            })
          }}
        >
          <ComboboxTrigger
            render={
              <Button
                variant="outline"
                className="flex min-w-56 items-center justify-center gap-2 px-3"
                aria-label={`Current chapter: ${active.displayLabel}. Choose chapter`}
              />
            }
          >
            <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
              <span className="truncate font-semibold tabular-nums">{active.displayLabel}</span>
              <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
                {activeSummary}
              </span>
            </span>
          </ComboboxTrigger>
          <ComboboxContent
            align="center"
            // min-w-56 trigger + two size-8 prev/next buttons
            className="w-[calc(14rem+2rem+2rem)] min-w-[calc(14rem+2rem+2rem)] *:data-[slot=input-group]:mx-0! *:data-[slot=input-group]:my-0! *:data-[slot=input-group]:border-0! *:data-[slot=input-group]:bg-transparent! *:data-[slot=input-group]:shadow-none!"
          >
            <ComboboxInput
              showTrigger={false}
              showSearchIcon
              placeholder="Find a chapter…"
              aria-label="Find a chapter"
              className="w-auto rounded-none border-0 shadow-none outline-none ring-0 tabular-nums *:data-[slot=input-group-addon]:pl-3 hover:border-0! focus-within:border-0! has-[[data-slot=input-group-control]:focus-visible]:border-0! has-[[data-slot=input-group-control]:focus-visible]:ring-0!"
            />
            <ComboboxSeparator className="mx-0 my-0" />
            <ComboboxEmpty>No chapters found.</ComboboxEmpty>
            <ComboboxList className="max-h-none overflow-visible p-0">
              <VirtualizedChapterList
                activeLabel={active.label}
                open={open}
                virtualizerRef={virtualizerRef}
              />
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Button
          variant="outline"
          size="icon"
          disabled={!canGoNext}
          aria-label="Next chapter"
          onClick={() => choose(chapters[activeIndex + 1].label)}
        >
          <ChevronRight />
        </Button>
      </ButtonGroup>
    </nav>
  )
}
