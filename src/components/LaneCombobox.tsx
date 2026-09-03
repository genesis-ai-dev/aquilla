/**
 * LaneCombobox — searchable single-select picker for target-language lanes
 * (AQU-609). Client projects can carry 150+ lanes, and lane pickers are
 * comboboxes by explicit client request — every lane picker (the editor's
 * lane switcher, the rule editor's scope, the rules lane filter) routes
 * through this one component so none of them regresses to an unsearchable
 * list.
 *
 * Closed vocabulary on purpose: unlike the removed free-text language chips
 * combobox (see LanguageComboboxInput.tsx for that regression), the search
 * input never commits text anywhere — it is controlled here purely to decide
 * which rows exist (Base UI does not consult `filter` while the query is
 * empty, so browse-mode rules live in the items array) and it resets on
 * close. Selection itself is the same closed Base-UI Combobox usage the app
 * already ships in ChapterNavigator and MemberMultiSelect.
 *
 * Archived lanes (AQU-601): hidden behind a "Show archived (n)" row while
 * browsing, but a non-empty search matches them too — with 150 lanes,
 * expand-then-scan is not navigation. The current selection is always
 * visible, and an archived selection auto-reveals the archived section.
 */
import { useMemo, useState } from "react"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { Archive } from "lucide-react"
import {
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
} from "@/components/ui/combobox"
import { useT } from "@/lib/i18n/I18nProvider"

export interface LaneComboboxOption {
  value: string
  label: string
  /** AQU-601: archived lanes hide behind the reveal row while browsing. */
  archived?: boolean
  /** When set, the item carries `data-testid="lane-option-<testId>"` (the
   *  editor lane switcher's e2e contract; see Workspace.switchLane). */
  testId?: string
}

/** The reveal row is a sentinel item in the same collection as the options. */
type RevealRow = { kind: "reveal" }
type Row = LaneComboboxOption | RevealRow
const isReveal = (row: Row): row is RevealRow =>
  (row as RevealRow).kind === "reveal"

interface LaneComboboxProps {
  options: readonly LaneComboboxOption[]
  value: string
  onValueChange: (value: string) => void
  /** The popup trigger. Rendered via Base-UI's render prop so each caller
   *  owns its look (badge pill in the editor, outline button in rules) —
   *  including its own chevron. */
  trigger: React.ReactElement<Record<string, unknown>>
  searchPlaceholder: string
  searchAriaLabel: string
  emptyText: string
  align?: "start" | "center" | "end"
  /** Rendered under the list behind a separator (e.g. the editor's "Change
   *  target language…" action). Receives close() to dismiss the popup. */
  footer?: (close: () => void) => React.ReactNode
}

export function LaneCombobox({
  options,
  value,
  onValueChange,
  trigger,
  searchPlaceholder,
  searchAriaLabel,
  emptyText,
  align = "start",
  footer,
}: LaneComboboxProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  // Persists across open/close, mirroring the pre-combobox dropdown (AQU-601).
  const [revealed, setRevealed] = useState(false)

  const archivedCount = options.filter((o) => o.archived).length
  const selected = options.find((o) => o.value === value) ?? null
  // An archived active selection must be visible without a manual reveal.
  const effectiveRevealed = revealed || selected?.archived === true
  const searching = query.trim() !== ""

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const option of options) {
      // Browsing (no query): archived lanes stay behind the reveal, except
      // the current selection. A search always covers them.
      if (option.archived && !searching && !effectiveRevealed && option.value !== value) {
        continue
      }
      out.push(option)
    }
    if (archivedCount > 0 && !searching && !effectiveRevealed) {
      out.push({ kind: "reveal" })
    }
    return out
  }, [options, searching, effectiveRevealed, value, archivedCount])

  return (
    <ComboboxPrimitive.Root
      items={rows}
      value={selected}
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next)
        if (!next) setQuery("") // reopening always starts from a browsable list
      }}
      inputValue={query}
      onInputValueChange={(next: string) => setQuery(next)}
      autoHighlight
      onValueChange={(row: Row | null, eventDetails: { cancel: () => void }) => {
        if (!row) return
        if (isReveal(row)) {
          // Reveal expands in place; canceling keeps the popup open (the
          // same Base-UI move as ChapterNavigator's split milestones).
          setRevealed(true)
          eventDetails.cancel()
          return
        }
        onValueChange(row.value)
      }}
      itemToStringLabel={(row: Row) =>
        isReveal(row)
          ? t("editor.lane.showArchived", { count: archivedCount })
          : row.label
      }
      itemToStringValue={(row: Row) => (isReveal(row) ? " reveal" : row.value)}
      isItemEqualToValue={(a: Row, b: Row) =>
        isReveal(a) || isReveal(b)
          ? isReveal(a) && isReveal(b)
          : a.value === b.value
      }
      filter={(row: Row, q: string) => {
        const needle = q.trim().toLowerCase()
        if (needle === "") return true // browse mode is shaped by `rows`
        if (isReveal(row)) return false
        return row.label.toLowerCase().includes(needle)
      }}
    >
      <ComboboxPrimitive.Trigger render={trigger} />
      <ComboboxContent align={align} className="min-w-[12rem]">
        <ComboboxInput
          showTrigger={false}
          showSearchIcon
          placeholder={searchPlaceholder}
          aria-label={searchAriaLabel}
        />
        <ComboboxSeparator className="mx-0 my-0" />
        <ComboboxEmpty>{emptyText}</ComboboxEmpty>
        <ComboboxList>
          {(row: Row) =>
            isReveal(row) ? (
              <ComboboxItem
                key=" reveal"
                value={row}
                showIndicator={false}
                data-testid="lane-show-archived"
                className="gap-1.5 text-xs text-muted-foreground"
              >
                <Archive className="h-3 w-3" />
                {t("editor.lane.showArchived", { count: archivedCount })}
              </ComboboxItem>
            ) : (
              <ComboboxItem
                key={row.value}
                value={row}
                data-testid={row.testId !== undefined ? `lane-option-${row.testId}` : undefined}
                data-active={row.value === value ? "true" : undefined}
                data-archived={row.archived ? "true" : undefined}
                className={row.archived ? "text-muted-foreground" : undefined}
              >
                {row.archived && <Archive className="h-3 w-3 shrink-0" />}
                <span className="min-w-0 truncate">{row.label}</span>
              </ComboboxItem>
            )
          }
        </ComboboxList>
        {footer && (
          <>
            <ComboboxSeparator className="mx-0 my-0" />
            {footer(() => setOpen(false))}
          </>
        )}
      </ComboboxContent>
    </ComboboxPrimitive.Root>
  )
}
