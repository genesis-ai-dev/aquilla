/**
 * SearchSelect — a dropdown with a search box, for the lists that grow with
 * your data (AQU-2260, Sam, Oct 29, Settings cleanup option 2B): the UI
 * language, a Bible's books, projects, members, models, Monday boards, Airtable
 * bases and tables. Short fixed lists stay a plain Select.
 *
 * It looks like a Select on the page — the same button, the same chevron — and
 * opens below it like every other list. Typing in the box at the top narrows
 * the list to the options whose name (or `keywords`) contains what you typed,
 * anywhere and ignoring case; the arrow keys and Enter choose. The box never
 * commits text anywhere: it only decides which rows show, and it is emptied
 * whenever the list closes, so the list always reopens whole.
 *
 * The open list is virtualized (AQU-2308): "Set a new milestone…" offers one
 * row per cell of the file, and a whole-Bible file has thirty thousand, which
 * is the row count that took the voice library down (AQU-1013). Only the rows
 * in view are mounted, the same way ChapterNavigator's list is, and the shape
 * is the one Base UI documents for its Combobox: `virtualized` on the root,
 * `index` on each item, and the scrolling the item DOM cannot do itself
 * (opening on the chosen row, the keyboard reaching an edge) done here.
 *
 * The same pattern as ProjectCombobox (AQU-1518) and LaneCombobox (AQU-609),
 * made generic so a dozen pickers can share one piece.
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { observeElementRect, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual"
import { ChevronDownIcon } from "lucide-react"
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox"
import { SELECT_TRIGGER_CLASS } from "@/components/ui/select"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

export interface SearchSelectOption {
  value: string
  /** What the button shows once chosen, and what the search matches. */
  label: string
  /** More text the search matches, never shown (a language code, an email). */
  keywords?: string
  disabled?: boolean
  /** For a name written in its own script (the UI language list). */
  lang?: string
  dir?: "ltr" | "rtl" | "auto"
}

export interface SearchSelectProps<O extends SearchSelectOption = SearchSelectOption> {
  options: readonly O[]
  /** The chosen option's value. Null, or a value no option has, shows the
   *  placeholder; an option with value `""` is a "nothing chosen" row. */
  value: string | null
  onValueChange: (value: string) => void
  /** Id of the button, so a `<label htmlFor>` names it. */
  id?: string
  /** The button's accessible name when no label points at it. */
  "aria-label"?: string
  /** Button text while nothing is chosen. */
  placeholder?: string
  /** The search box's placeholder; "Search…" by default. */
  searchPlaceholder?: string
  /** The search box's accessible name; "Search the list" by default. */
  searchAriaLabel?: string
  /** Shown when nothing matches; "No matches" by default. */
  emptyText?: string
  disabled?: boolean
  invalid?: boolean
  size?: "sm" | "default"
  /** Classes for the button (its width, mostly). */
  className?: string
  /** Classes for the open list. */
  contentClassName?: string
  "data-testid"?: string
  /** A test id for each option row. */
  optionTestId?: (option: O) => string
  /** How an option is drawn in the list (an avatar beside a name). */
  renderOption?: (option: O) => ReactNode
  /** How the chosen option is drawn on the button. */
  renderValue?: (option: O) => ReactNode
}

/** A ComboboxItem is `py-1` around one `text-sm` line: 4 + 20 + 4. A row a
 *  `renderOption` draws taller is measured once it mounts. */
const OPTION_ROW_HEIGHT_PX = 28
const LIST_OVERSCAN_ROWS = 12
/** happy-dom reports 0×0 for CSS-sized scrollports; coerce so rows mount. */
const FALLBACK_SCROLLPORT = { width: 320, height: 288 }

type OptionListVirtualizer = Virtualizer<HTMLDivElement, Element>

export function SearchSelect<O extends SearchSelectOption = SearchSelectOption>({
  options,
  value,
  onValueChange,
  id,
  "aria-label": ariaLabel,
  placeholder,
  searchPlaceholder,
  searchAriaLabel,
  emptyText,
  disabled = false,
  invalid,
  size = "default",
  className,
  contentClassName,
  "data-testid": testId,
  optionTestId,
  renderOption,
  renderValue,
}: SearchSelectProps<O>) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const virtualizerRef = useRef<OptionListVirtualizer | null>(null)
  // An option whose value is "" is the list's own "nothing chosen" row
  // ("Select member…", "No project"); the button shows it, greyed.
  const selected = useMemo(
    () => (value == null ? null : options.find((o) => o.value === value) ?? null),
    [options, value],
  )
  const empty = !selected || selected.value === ""

  return (
    <ComboboxPrimitive.Root
      items={options as O[]}
      value={selected}
      disabled={disabled}
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (!next) setQuery("") // it always reopens on the whole list
      }}
      inputValue={query}
      onInputValueChange={(next: string) => setQuery(next)}
      autoHighlight
      virtualized
      onValueChange={(option: O | null) => {
        if (option && option.value !== value) onValueChange(option.value)
      }}
      onItemHighlighted={(option: O | undefined, { reason, index }) => {
        const virtualizer = virtualizerRef.current
        if (!option || !virtualizer || index < 0) return
        const isStart = index === 0
        const isEnd = index === virtualizer.options.count - 1
        // Base UI's guidance for a virtualized Combobox: scroll on a
        // programmatic highlight (typing, with `autoHighlight`), and on the
        // keyboard only at the edges — in-window ArrowUp/Down is handled by
        // the item DOM, and a row that is already in view must not move.
        const shouldScroll = reason === "none" || (reason === "keyboard" && (isStart || isEnd))
        if (!shouldScroll) return
        queueMicrotask(() => {
          virtualizer.scrollToIndex(index, { align: isStart ? "start" : isEnd ? "end" : "auto" })
        })
      }}
      itemToStringLabel={(option: O) => option.label}
      itemToStringValue={(option: O) => option.value}
      isItemEqualToValue={(a: O, b: O) => a.value === b.value}
      filter={(option: O, q: string) => {
        const needle = q.trim().toLocaleLowerCase()
        if (needle === "") return true
        // Anywhere in the name, ignoring case: a project or a person is as
        // likely to be known by a word in the middle as by its first.
        return `${option.label} ${option.keywords ?? ""}`.toLocaleLowerCase().includes(needle)
      }}
    >
      <ComboboxPrimitive.Trigger
        id={id}
        data-slot="search-select-trigger"
        data-size={size}
        data-testid={testId}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        className={cn(SELECT_TRIGGER_CLASS, "data-popup-open:bg-accent/40", className)}
      >
        <span
          data-slot="select-value"
          className={cn("min-w-0 flex-1 truncate text-start", empty && "text-muted-foreground")}
          lang={selected?.lang}
          dir={selected?.dir}
        >
          {selected ? (renderValue ? renderValue(selected) : selected.label) : placeholder}
        </span>
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent align="start" className={cn("w-(--anchor-width) min-w-56 p-0", contentClassName)}>
        <ComboboxInput
          showTrigger={false}
          showSearchIcon
          showClear={query.trim() !== ""}
          placeholder={searchPlaceholder ?? t("common.searchPlaceholder")}
          aria-label={searchAriaLabel ?? t("common.searchListAria")}
        />
        <ComboboxSeparator className="mx-0 my-0" />
        <ComboboxEmpty>{emptyText ?? t("common.noMatches")}</ComboboxEmpty>
        {/* The scrollport moves inside: the virtualizer has to own the element
            that scrolls, and the list's own max-height would otherwise clip
            a spacer it never measures. */}
        <ComboboxList className="max-h-none overflow-visible p-0">
          <VirtualizedOptions
            open={open}
            selectedValue={selected?.value ?? null}
            optionTestId={optionTestId}
            renderOption={renderOption}
            virtualizerRef={virtualizerRef}
          />
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  )
}

/**
 * The rows in view, and nothing else. Lives inside the root so it can read
 * the list Base UI's own `filter` produced — the search box keeps working
 * exactly as it did, on every option, and only the drawing is windowed.
 */
function VirtualizedOptions<O extends SearchSelectOption>({
  open,
  selectedValue,
  optionTestId,
  renderOption,
  virtualizerRef,
}: {
  open: boolean
  selectedValue: string | null
  optionTestId?: (option: O) => string
  renderOption?: (option: O) => ReactNode
  virtualizerRef: RefObject<OptionListVirtualizer | null>
}) {
  const filteredItems = ComboboxPrimitive.useFilteredItems<O>()
  const scrollElementRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    enabled: open,
    count: filteredItems.length,
    getScrollElement: () => scrollElementRef.current,
    getItemKey: (index) => filteredItems[index]?.value ?? index,
    estimateSize: () => OPTION_ROW_HEIGHT_PX,
    overscan: LIST_OVERSCAN_ROWS,
    initialRect: FALLBACK_SCROLLPORT,
    observeElementRect: (instance, cb) =>
      observeElementRect(instance, (rect) => {
        cb({
          width: rect.width > 0 ? rect.width : FALLBACK_SCROLLPORT.width,
          height: rect.height > 0 ? rect.height : FALLBACK_SCROLLPORT.height,
        })
      }),
    // A `renderOption` row (an avatar beside a name) may stand taller than
    // the estimate, so what mounted is measured. 0 is happy-dom, not a row.
    measureElement: (element) => {
      const height = element.getBoundingClientRect().height
      return height > 0 ? height : OPTION_ROW_HEIGHT_PX
    },
  })

  useImperativeHandle(virtualizerRef, () => virtualizer)

  const handleScrollElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      scrollElementRef.current = element
      if (element) virtualizer.measure()
    },
    [virtualizer],
  )

  // Open on the chosen row, as a native select does — once per open, so the
  // list does not jump back while the person scrolls or types.
  const didScrollOnOpenRef = useRef(false)
  useEffect(() => {
    if (!open) {
      didScrollOnOpenRef.current = false
      return
    }
    if (didScrollOnOpenRef.current || filteredItems.length === 0) return
    didScrollOnOpenRef.current = true
    if (selectedValue == null) return
    const index = filteredItems.findIndex((option) => option.value === selectedValue)
    if (index < 0) return
    queueMicrotask(() => {
      virtualizer.scrollToIndex(index, { align: "center" })
    })
  }, [filteredItems, open, selectedValue, virtualizer])

  const totalSize = virtualizer.getTotalSize()

  if (filteredItems.length === 0) return null

  return (
    <div
      role="presentation"
      ref={handleScrollElementRef}
      // The height ComboboxList had: 18rem less the search box, or what the
      // viewport leaves. Native overflow scroll, like every list.
      className="max-h-[min(calc(--spacing(72)---spacing(9)),calc(var(--available-height)---spacing(9)))] overflow-y-auto overscroll-contain p-1"
    >
      <div role="presentation" className="relative w-full" style={{ height: totalSize }}>
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const option = filteredItems[virtualItem.index]
          if (!option) return null
          return (
            <ComboboxItem
              key={option.value}
              ref={virtualizer.measureElement}
              index={virtualItem.index}
              data-index={virtualItem.index}
              value={option}
              disabled={option.disabled}
              lang={option.lang}
              dir={option.dir}
              data-testid={optionTestId?.(option)}
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
              {renderOption ? renderOption(option) : <span className="min-w-0 truncate">{option.label}</span>}
            </ComboboxItem>
          )
        })}
      </div>
    </div>
  )
}
