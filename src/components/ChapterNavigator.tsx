import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react"
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { ChevronDown, ChevronLeft, ChevronRight, CheckIcon, CornerDownRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
} from "@/components/ui/combobox"
import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import type { ImportMilestoneKind } from "../../shared/import-contract"

export interface MilestoneNavigationItem {
  key: string
  kind: ImportMilestoneKind
  label: string
  shortLabel: string
  description: string
  translated: number
  validated: number
  total: number
  subsections?: readonly MilestoneNavigationSubsection[]
}

export interface MilestoneNavigationSubsection {
  key: string
  label: string
  firstCellId: string
  translated: number
  validated: number
  total: number
}

/**
 * One virtualized row. A row with a `subsection` is a cell range listed under
 * its expanded milestone; otherwise the row is the milestone itself.
 */
interface NavigationRow {
  key: string
  milestone: MilestoneNavigationItem
  subsection?: MilestoneNavigationSubsection
}

// Estimate only — real height comes from measureElement (no locked style.height).
const MILESTONE_ROW_HEIGHT_PX = 48

/** Matches EditorTable: picker is absolutely centered from lg up. */
const LG_MIN_WIDTH_QUERY = "(min-width: 1024px)"

function useMinWidthLg(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mq = window.matchMedia(LG_MIN_WIDTH_QUERY)
      mq.addEventListener("change", onStoreChange)
      return () => mq.removeEventListener("change", onStoreChange)
    },
    () => window.matchMedia(LG_MIN_WIDTH_QUERY).matches,
    () => true,
  )
}

type MilestoneListVirtualizer = ReturnType<typeof useVirtualizer<HTMLDivElement, Element>>

export function milestoneMatchesSearch(item: MilestoneNavigationItem, query: string): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery) return true

  if (/^\d+(?:[-–]\d+)?$/.test(normalizedQuery)) {
    const normalizedNumericQuery = normalizedQuery.replace("–", "-")
    return [
      item.shortLabel,
      ...(item.subsections?.map((subsection) => subsection.label) ?? []),
    ].some((label) => label.toLocaleLowerCase().replace("–", "-") === normalizedNumericQuery)
  }

  return `${item.label} ${item.shortLabel} ${item.description} ${
    item.subsections?.map((subsection) => subsection.label).join(" ") ?? ""
  }`
    .toLocaleLowerCase()
    .includes(normalizedQuery)
}

/**
 * Which set of navigator labels a file's divisions use.
 *
 * Each vocabulary owns whole sentences, not a noun the app pours into a shared
 * frame: "Previous chapter" is its own key, so a translator can inflect the noun
 * for the frame around it (Arabic) or move it (Burmese). `heading` is the one
 * standalone noun left — the picker's group name — and stays a bare plural.
 */
interface NavigationVocabulary {
  heading: MessageKey
  moveBetween: MessageKey
  previous: MessageKey
  next: MessageKey
  current: MessageKey
  currentWithCells: MessageKey
  findPlaceholder: MessageKey
  find: MessageKey
  empty: MessageKey
}

type VocabularyId = "chapter" | "slide" | "story" | "section" | "timeRange" | "part" | "group" | "milestone"

/** Exported so a test can assert every kind's sentences are complete. */
export const VOCABULARIES: Record<VocabularyId, NavigationVocabulary> = {
  chapter: {
    heading: "editor.milestone.vocab.chapterPlural",
    moveBetween: "editor.milestone.chapter.moveBetween",
    previous: "editor.milestone.chapter.previous",
    next: "editor.milestone.chapter.next",
    current: "editor.milestone.chapter.current",
    currentWithCells: "editor.milestone.chapter.currentWithCells",
    findPlaceholder: "editor.milestone.chapter.findPlaceholder",
    find: "editor.milestone.chapter.find",
    empty: "editor.milestone.chapter.empty",
  },
  slide: {
    heading: "editor.milestone.vocab.slidePlural",
    moveBetween: "editor.milestone.slide.moveBetween",
    previous: "editor.milestone.slide.previous",
    next: "editor.milestone.slide.next",
    current: "editor.milestone.slide.current",
    currentWithCells: "editor.milestone.slide.currentWithCells",
    findPlaceholder: "editor.milestone.slide.findPlaceholder",
    find: "editor.milestone.slide.find",
    empty: "editor.milestone.slide.empty",
  },
  story: {
    heading: "editor.milestone.vocab.storyPlural",
    moveBetween: "editor.milestone.story.moveBetween",
    previous: "editor.milestone.story.previous",
    next: "editor.milestone.story.next",
    current: "editor.milestone.story.current",
    currentWithCells: "editor.milestone.story.currentWithCells",
    findPlaceholder: "editor.milestone.story.findPlaceholder",
    find: "editor.milestone.story.find",
    empty: "editor.milestone.story.empty",
  },
  section: {
    heading: "editor.milestone.vocab.sectionPlural",
    moveBetween: "editor.milestone.section.moveBetween",
    previous: "editor.milestone.section.previous",
    next: "editor.milestone.section.next",
    current: "editor.milestone.section.current",
    currentWithCells: "editor.milestone.section.currentWithCells",
    findPlaceholder: "editor.milestone.section.findPlaceholder",
    find: "editor.milestone.section.find",
    empty: "editor.milestone.section.empty",
  },
  timeRange: {
    heading: "editor.milestone.vocab.timeRangePlural",
    moveBetween: "editor.milestone.timeRange.moveBetween",
    previous: "editor.milestone.timeRange.previous",
    next: "editor.milestone.timeRange.next",
    current: "editor.milestone.timeRange.current",
    currentWithCells: "editor.milestone.timeRange.currentWithCells",
    findPlaceholder: "editor.milestone.timeRange.findPlaceholder",
    find: "editor.milestone.timeRange.find",
    empty: "editor.milestone.timeRange.empty",
  },
  part: {
    heading: "editor.milestone.vocab.partPlural",
    moveBetween: "editor.milestone.part.moveBetween",
    previous: "editor.milestone.part.previous",
    next: "editor.milestone.part.next",
    current: "editor.milestone.part.current",
    currentWithCells: "editor.milestone.part.currentWithCells",
    findPlaceholder: "editor.milestone.part.findPlaceholder",
    find: "editor.milestone.part.find",
    empty: "editor.milestone.part.empty",
  },
  group: {
    heading: "editor.milestone.vocab.groupPlural",
    moveBetween: "editor.milestone.group.moveBetween",
    previous: "editor.milestone.group.previous",
    next: "editor.milestone.group.next",
    current: "editor.milestone.group.current",
    currentWithCells: "editor.milestone.group.currentWithCells",
    findPlaceholder: "editor.milestone.group.findPlaceholder",
    find: "editor.milestone.group.find",
    empty: "editor.milestone.group.empty",
  },
  milestone: {
    heading: "editor.milestone.vocab.milestonePlural",
    moveBetween: "editor.milestone.milestone.moveBetween",
    previous: "editor.milestone.milestone.previous",
    next: "editor.milestone.milestone.next",
    current: "editor.milestone.milestone.current",
    currentWithCells: "editor.milestone.milestone.currentWithCells",
    findPlaceholder: "editor.milestone.milestone.findPlaceholder",
    find: "editor.milestone.milestone.find",
    empty: "editor.milestone.milestone.empty",
  },
}

function vocabularyFor(items: readonly MilestoneNavigationItem[]): NavigationVocabulary {
  const kinds = new Set(items.map((item) => item.kind))
  if ([...kinds].every((kind) => (
    kind === "chapter" || kind === "chapter-range" || kind === "preface"
  ))) {
    return VOCABULARIES.chapter
  }
  if (kinds.size === 1 && kinds.has("slide")) return VOCABULARIES.slide
  if (kinds.size === 1 && kinds.has("story")) return VOCABULARIES.story
  if (kinds.size === 1 && kinds.has("section")) return VOCABULARIES.section
  if (kinds.size === 1 && kinds.has("time-range")) return VOCABULARIES.timeRange
  if (kinds.size === 1 && kinds.has("part")) return VOCABULARIES.part
  if (kinds.size === 1 && kinds.has("group")) return VOCABULARIES.group
  return VOCABULARIES.milestone
}

function percent(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

function ProgressSummary({ translated, validated, total }: {
  translated: number
  validated: number
  total: number
}) {
  const t = useT()
  return (
    <span className="w-[7.5rem] shrink-0 justify-self-end text-end text-xs tabular-nums text-muted-foreground">
      <span className="block">
        {t("editor.milestone.percentTranslated", { percent: percent(translated, total) })}
      </span>
      <span className="block">
        {t("editor.milestone.percentValidated", { percent: percent(validated, total) })}
      </span>
    </span>
  )
}

function VirtualizedMilestoneList({
  activeRowKey,
  expandedKey,
  open,
  virtualizerRef,
}: {
  activeRowKey: string
  expandedKey: string
  open: boolean
  virtualizerRef: RefObject<MilestoneListVirtualizer | null>
}) {
  const t = useT()
  const filteredItems = ComboboxPrimitive.useFilteredItems<NavigationRow>()
  const scrollElementRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    enabled: open,
    count: filteredItems.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => MILESTONE_ROW_HEIGHT_PX,
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
    const index = filteredItems.findIndex((row) => row.key === activeRowKey)
    if (index < 0) return
    queueMicrotask(() => {
      virtualizer.scrollToIndex(index, { align: "center" })
    })
  }, [activeRowKey, filteredItems, open, virtualizer])

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
            const row = filteredItems[virtualItem.index]
            if (!row) return null

            const isActive = row.key === activeRowKey
            const subsection = row.subsection
            const expandable = !subsection && Boolean(row.milestone.subsections?.length)

            return (
              <ComboboxPrimitive.Item
                key={row.key}
                index={virtualItem.index}
                data-index={virtualItem.index}
                ref={virtualizer.measureElement}
                value={row}
                data-checked={isActive || undefined}
                {...(subsection ? { "data-milestone-subsection": "" } : {})}
                className={cn(
                  "relative flex w-full cursor-default items-center gap-3 rounded-md px-2 py-1 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
                  // Cell ranges read as children of the milestone above them.
                  subsection && "ps-6",
                )}
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
                {subsection ? (
                  <>
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium tabular-nums">
                      <CornerDownRight
                        aria-hidden="true"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate">
                        {t("editor.milestone.cellRange", { range: subsection.label })}
                      </span>
                    </span>
                    <ProgressSummary {...subsection} />
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium tabular-nums">
                        {row.milestone.label}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {row.milestone.description}
                      </span>
                    </span>
                    <ProgressSummary {...row.milestone} />
                  </>
                )}
                {expandable ? (
                  <ChevronDown
                    aria-hidden="true"
                    className={cn(
                      "size-4 shrink-0 text-muted-foreground transition-transform",
                      expandedKey === row.milestone.key && "rotate-180",
                    )}
                  />
                ) : isActive ? (
                  <CheckIcon className="size-4 shrink-0 text-foreground" aria-hidden="true" />
                ) : (
                  <span className="size-4 shrink-0" aria-hidden="true" />
                )}
              </ComboboxPrimitive.Item>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function MilestoneNavigator({
  items,
  activeKey,
  activeSubsectionKey,
  onSelect,
}: {
  items: MilestoneNavigationItem[]
  activeKey: string
  activeSubsectionKey?: string
  onSelect: (key: string, subsectionKey?: string) => void
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [expandedKey, setExpandedKey] = useState(activeKey)
  const [iconOnlyTrigger, setIconOnlyTrigger] = useState(false)
  const virtualizerRef = useRef<MilestoneListVirtualizer | null>(null)
  const buttonGroupRef = useRef<HTMLDivElement | null>(null)
  const pickerCentered = useMinWidthLg()
  const vocabulary = useMemo(() => vocabularyFor(items), [items])
  const matchedActiveIndex = items.findIndex((item) => item.key === activeKey)
  const activeIndex = matchedActiveIndex >= 0 ? matchedActiveIndex : 0
  const active = items[activeIndex]
  const activeSubsection = active?.subsections?.find(
    (subsection) => subsection.key === activeSubsectionKey,
  ) ?? active?.subsections?.[0]

  // Prev/Next walk every reachable destination, so a milestone split into cell
  // ranges steps range-by-range instead of jumping past them.
  const destinations = useMemo<{ milestoneKey: string; subsectionKey?: string }[]>(
    () => items.flatMap((item) => (
      item.subsections?.length
        ? item.subsections.map((subsection) => ({
            milestoneKey: item.key,
            subsectionKey: subsection.key,
          }))
        : [{ milestoneKey: item.key }]
    )),
    [items],
  )
  const activeDestinationIndex = destinations.findIndex((destination) => (
    destination.milestoneKey === active?.key
    && (
      destination.subsectionKey === activeSubsection?.key
      || (!destination.subsectionKey && !activeSubsection)
    )
  ))
  const canGoPrevious = activeDestinationIndex > 0
  const canGoNext = activeDestinationIndex >= 0 && activeDestinationIndex < destinations.length - 1

  const rows = useMemo<NavigationRow[]>(
    () => items.flatMap((milestone) => {
      const milestoneRow: NavigationRow = { key: milestone.key, milestone }
      if (milestone.key !== expandedKey || !milestone.subsections?.length) return [milestoneRow]
      return [
        milestoneRow,
        ...milestone.subsections.map((subsection): NavigationRow => ({
          key: subsection.key,
          milestone,
          subsection,
        })),
      ]
    }),
    [expandedKey, items],
  )

  const activeRowKey = activeSubsection && active?.key === expandedKey
    ? activeSubsection.key
    : active?.key ?? ""
  const activeRow = rows.find((row) => row.key === activeRowKey) ?? null

  const activeSummary = activeSubsection ? `(${activeSubsection.label})` : active?.description ?? ""

  // Collapse the middle trigger to a centered chevron when the header slot
  // is too narrow. Measure the flex slot (available width), not the button
  // group content width — content-sized observation can't grow back out of
  // icon-only mode. Hysteresis avoids flicker at the threshold.
  useEffect(() => {
    const group = buttonGroupRef.current
    if (!group || typeof ResizeObserver === "undefined") return
    const slot = group.closest("[data-chapter-nav-slot]")
    if (!slot) return

    const COLLAPSE_BELOW_PX = 120
    const EXPAND_ABOVE_PX = 168

    const update = () => {
      const width = slot.getBoundingClientRect().width
      if (width <= 0) return
      setIconOnlyTrigger((prev) => {
        if (prev) return width < EXPAND_ABOVE_PX
        return width <= COLLAPSE_BELOW_PX
      })
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(slot)
    return () => ro.disconnect()
  }, [])

  if (!active || items.length === 0) return null

  const choose = (key: string, subsectionKey?: string) => {
    if (subsectionKey) onSelect(key, subsectionKey)
    else onSelect(key)
    setOpen(false)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (nextOpen) setExpandedKey(active.key)
  }

  return (
    <nav aria-label={t("editor.milestone.region")} className="flex w-full min-w-24 max-w-full items-center lg:w-auto">
      <ButtonGroup
        ref={buttonGroupRef}
        aria-label={t(vocabulary.moveBetween)}
        // Floor: prev + middle + next icon buttons (3× size-8). Never shrink
        // below the collapsed chevron-only trigger state.
        className="min-w-24 max-w-full shadow-xs"
      >
        <Button
          variant="outline"
          size="icon"
          disabled={!canGoPrevious}
          aria-label={t(vocabulary.previous)}
          onClick={() => {
            const destination = destinations[activeDestinationIndex - 1]
            if (destination) choose(destination.milestoneKey, destination.subsectionKey)
          }}
        >
          <ChevronLeft />
        </Button>
        <Combobox
          items={rows}
          value={activeRow}
          open={open}
          onOpenChange={handleOpenChange}
          virtualized
          autoHighlight
          onValueChange={(row, eventDetails) => {
            if (!row) return
            if (row.subsection) {
              choose(row.milestone.key, row.subsection.key)
              return
            }
            if (row.milestone.subsections?.length) {
              // Selecting a split milestone reveals its cell ranges rather than
              // navigating. Canceling keeps Base UI from closing the popup.
              setExpandedKey(expandedKey === row.milestone.key ? "" : row.milestone.key)
              eventDetails.cancel()
              return
            }
            choose(row.milestone.key)
          }}
          itemToStringLabel={(row) => (
            row.subsection
              ? t("editor.milestone.cellRange", { range: row.subsection.label })
              : row.milestone.label
          )}
          itemToStringValue={(row) => row.key}
          isItemEqualToValue={(a, b) => a.key === b.key}
          filter={(row, query) => milestoneMatchesSearch(row.milestone, query)}
          onItemHighlighted={(row, { reason, index }) => {
            const virtualizer = virtualizerRef.current
            if (!row || !virtualizer || index < 0) return

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
                data-icon-only={iconOnlyTrigger || undefined}
                // Default: padded label + chevron. data-icon-only: true icon
                // button (w-8, p-0, label hidden, chevron centered). xl+: fixed
                // width with start-aligned label regardless of squeeze.
                className="flex h-8 min-w-8 w-auto max-w-full shrink items-center justify-center gap-2 overflow-hidden px-2.5 data-[icon-only]:w-8 data-[icon-only]:shrink-0 data-[icon-only]:gap-0 data-[icon-only]:p-0 xl:w-56 xl:min-w-56 xl:shrink-0 xl:justify-start xl:px-2.5 xl:data-[icon-only]:w-56 xl:data-[icon-only]:gap-2 xl:data-[icon-only]:p-2.5 xl:[&>svg:last-child]:ms-auto [&>svg:last-child]:shrink-0"
                aria-label={
                  activeSubsection
                    ? t(vocabulary.currentWithCells, {
                        label: active.label,
                        cells: activeSubsection.label,
                      })
                    : t(vocabulary.current, { label: active.label })
                }
              />
            }
          >
            <span
              className={
                iconOnlyTrigger
                  ? "hidden min-w-0 truncate text-start font-semibold xl:inline"
                  : "min-w-0 truncate text-start font-semibold"
              }
            >
              {active.label}
            </span>
            {/* Below xl: chapter label only — drop the verse/cell summary. */}
            <span className="hidden min-w-0 truncate text-xs font-normal text-muted-foreground xl:inline">
              {activeSummary}
            </span>
          </ComboboxTrigger>
          <ComboboxContent
            // Below lg the picker sits left — anchor to the full prev/trigger/
            // next group so the popover's left edge meets the prev arrow.
            // lg+: center under the trigger with the absolute picker.
            align={pickerCentered ? "center" : "start"}
            anchor={pickerCentered ? undefined : buttonGroupRef}
            // min-w-56 trigger + two size-8 prev/next buttons
            className="w-[calc(14rem+2rem+2rem)] min-w-[calc(14rem+2rem+2rem)] *:data-[slot=input-group]:mx-0! *:data-[slot=input-group]:my-0! *:data-[slot=input-group]:border-0! *:data-[slot=input-group]:bg-transparent! *:data-[slot=input-group]:shadow-none!"
          >
            <ComboboxInput
              showTrigger={false}
              showSearchIcon
              placeholder={t(vocabulary.findPlaceholder)}
              aria-label={t(vocabulary.find)}
              // Input defaults to text-base below md (iOS zoom guard); keep this
              // popover field at text-sm so it doesn't jump larger on small screens.
              className="w-auto rounded-none border-0 shadow-none outline-none ring-0 tabular-nums *:data-[slot=input-group-control]:text-sm *:data-[slot=input-group-addon]:ps-3 hover:border-0! focus-within:border-0! has-[[data-slot=input-group-control]:focus-visible]:border-0! has-[[data-slot=input-group-control]:focus-visible]:ring-0!"
            />
            <ComboboxSeparator className="mx-0 my-0" />
            <ComboboxEmpty>{t(vocabulary.empty)}</ComboboxEmpty>
            <ComboboxList className="max-h-none overflow-visible p-0">
              {/* Named for assistive tech without a visible heading — the
                  trigger and search field already carry the vocabulary. */}
              <ComboboxGroup aria-label={t(vocabulary.heading)}>
                <VirtualizedMilestoneList
                  activeRowKey={activeRowKey}
                  expandedKey={expandedKey}
                  open={open}
                  virtualizerRef={virtualizerRef}
                />
              </ComboboxGroup>
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
        <Button
          variant="outline"
          size="icon"
          disabled={!canGoNext}
          aria-label={t(vocabulary.next)}
          onClick={() => {
            const destination = destinations[activeDestinationIndex + 1]
            if (destination) choose(destination.milestoneKey, destination.subsectionKey)
          }}
        >
          <ChevronRight />
        </Button>
      </ButtonGroup>
    </nav>
  )
}
