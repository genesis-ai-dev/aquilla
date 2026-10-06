/**
 * ProjectCombobox — searchable single-select picker for a *project* (AQU-1518).
 *
 * The same move the app already made for lanes (LaneCombobox, AQU-609), orgs
 * (OrgSwitcher, AQU-759) and the "Add to projects" dialog (AQU-1150): a plain
 * dropdown whose only navigation is scrolling becomes a combobox with a search
 * box. An account with a long project list could not find its upstream in the
 * Create New Project dialog without scrolling the whole list.
 *
 * Same Base-UI usage as LaneCombobox, and closed-vocabulary for the same
 * reason: the search input never commits text anywhere, it only decides which
 * rows exist, and it resets on close. (See LanguageComboboxInput.tsx for the
 * regression that free-typed combobox text caused — it does not apply here.)
 *
 * Why this is not LaneCombobox itself: lanes carry archive/reveal semantics and
 * lane-specific i18n that mean nothing for projects, and the lane picker's
 * contract is "every lane picker routes through this one component". Projects
 * get their own component on the same pattern.
 *
 * `allowClear` adds a "none" row so a chosen project can be unpicked — the
 * dropdown this replaced had no way back to the empty state once a project was
 * selected.
 */
import { useMemo, useState } from "react"
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
import { cn } from "@/lib/utils"

export interface ProjectComboboxOption {
  id: string
  name: string
}

/** The clear row is a sentinel item in the same collection as the projects. */
type ClearRow = { kind: "clear" }
type Row = ProjectComboboxOption | ClearRow
const isClear = (row: Row): row is ClearRow => (row as ClearRow).kind === "clear"

interface ProjectComboboxProps {
  options: readonly ProjectComboboxOption[]
  /** The chosen project's id; `""` means nothing is chosen. */
  value: string
  /** Fires with the chosen id, or `""` when the selection is cleared. */
  onValueChange: (value: string) => void
  /** Id of the trigger, so a `FieldLabel htmlFor` names this picker. */
  id?: string
  /** Trigger text while nothing is chosen. */
  placeholder: string
  searchPlaceholder: string
  searchAriaLabel: string
  emptyText: string
  /** Label of the row that returns the field to its empty state. */
  clearText?: string
  invalid?: boolean
  /** Takes the picker out of play, e.g. while its dialog is working (AQU-1519). */
  disabled?: boolean
}

export function ProjectCombobox({
  options,
  value,
  onValueChange,
  id,
  placeholder,
  searchPlaceholder,
  searchAriaLabel,
  emptyText,
  clearText,
  invalid,
  disabled = false,
}: ProjectComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const selected = options.find((o) => o.id === value) ?? null
  const searching = query.trim() !== ""
  const allowClear = clearText !== undefined && selected !== null

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [...options]
    // Browse-mode only: a search is looking for a project, not for "none".
    if (allowClear && !searching) out.unshift({ kind: "clear" })
    return out
  }, [options, allowClear, searching])

  return (
    <ComboboxPrimitive.Root
      items={rows}
      value={selected}
      disabled={disabled}
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (!next) setQuery("") // reopening always starts from a browsable list
      }}
      inputValue={query}
      onInputValueChange={(next: string) => setQuery(next)}
      autoHighlight
      onValueChange={(row: Row | null) => {
        if (!row) return
        onValueChange(isClear(row) ? "" : row.id)
      }}
      itemToStringLabel={(row: Row) => (isClear(row) ? (clearText ?? "") : row.name)}
      itemToStringValue={(row: Row) => (isClear(row) ? " clear" : row.id)}
      isItemEqualToValue={(a: Row, b: Row) =>
        isClear(a) || isClear(b) ? isClear(a) && isClear(b) : a.id === b.id
      }
      filter={(row: Row, q: string) => {
        const needle = q.trim().toLowerCase()
        if (needle === "") return true // browse mode is shaped by `rows`
        if (isClear(row)) return false
        // Matches anywhere in the name, case-insensitively — a project is as
        // likely to be recognised by a word in the middle as by its first.
        return row.name.toLowerCase().includes(needle)
      }}
    >
      <ComboboxPrimitive.Trigger
        id={id}
        aria-invalid={invalid || undefined}
        // Mirrors SelectTrigger (components/ui/select.tsx) so swapping the
        // dropdown for this picker is not also a visual change.
        className={cn(
          "flex h-8 w-fit items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent py-2 pe-2 ps-2.5 text-sm text-foreground whitespace-nowrap outline-none select-none",
          "hover:bg-accent/40 focus-visible:border-ring",
          "aria-expanded:border-input data-popup-open:border-input",
          "aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
          "dark:bg-input/30 dark:hover:bg-accent/40 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        )}
      >
        <span
          className={cn("min-w-0 truncate text-start", !selected && "text-muted-foreground")}
        >
          {selected?.name ?? placeholder}
        </span>
        <ChevronDownIcon className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent align="start" className="w-(--anchor-width) min-w-56 p-0">
        <ComboboxInput
          showTrigger={false}
          showSearchIcon
          showClear={searching}
          placeholder={searchPlaceholder}
          aria-label={searchAriaLabel}
        />
        <ComboboxSeparator className="mx-0 my-0" />
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(row: Row) =>
            isClear(row) ? (
              <ComboboxItem
                key=" clear"
                value={row}
                showIndicator={false}
                data-testid="project-option-none"
                className="text-xs text-muted-foreground"
              >
                {clearText}
              </ComboboxItem>
            ) : (
              <ComboboxItem
                key={row.id}
                value={row}
                data-testid={`project-option-${row.id}`}
                data-active={row.id === value ? "true" : undefined}
              >
                <span className="min-w-0 truncate">{row.name}</span>
              </ComboboxItem>
            )
          }
        </ComboboxList>
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  )
}
