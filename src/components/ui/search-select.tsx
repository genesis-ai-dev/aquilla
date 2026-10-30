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
 * The same pattern as ProjectCombobox (AQU-1518) and LaneCombobox (AQU-609),
 * made generic so a dozen pickers can share one piece.
 */
import { useMemo, useState, type ReactNode } from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
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
      onValueChange={(option: O | null) => {
        if (option && option.value !== value) onValueChange(option.value)
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
        <ComboboxList>
          {(option: O) => (
            <ComboboxItem
              key={option.value}
              value={option}
              disabled={option.disabled}
              lang={option.lang}
              dir={option.dir}
              data-testid={optionTestId?.(option)}
            >
              {renderOption ? renderOption(option) : <span className="min-w-0 truncate">{option.label}</span>}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  )
}
