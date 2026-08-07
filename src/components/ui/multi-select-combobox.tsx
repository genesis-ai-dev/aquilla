import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  ComboboxValue,
} from "@/components/ui/combobox"

// Popup search field styling — same strip treatment as ChapterNavigator.
// size={1} on the input kills the native default size=20 (~20ch) that was
// forcing the popover wider than checkbox+avatar+name rows.
const POPUP_SEARCH_CLASS =
  "w-full min-w-0 rounded-none border-0 shadow-none outline-none ring-0 *:data-[slot=input-group-control]:min-w-0 *:data-[slot=input-group-control]:w-full *:data-[slot=input-group-control]:text-sm *:data-[slot=input-group-addon]:pl-3 hover:border-0! focus-within:border-0! has-[[data-slot=input-group-control]:focus-visible]:border-0! has-[[data-slot=input-group-control]:focus-visible]:ring-0!"

const POPUP_CONTENT_CLASS =
  // Hug list content (not trigger / not input size=20). Search stretches to match.
  "w-max! min-w-48! max-w-(--available-width) *:data-[slot=input-group]:w-full *:data-[slot=input-group]:min-w-0 *:data-[slot=input-group]:mx-0! *:data-[slot=input-group]:my-0! *:data-[slot=input-group]:border-0! *:data-[slot=input-group]:bg-transparent! *:data-[slot=input-group]:shadow-none!"

const triggerVariants = cva(
  // w-fit! so the trigger hugs its avatar stack + names instead of the field.
  // Kill outline Button hover/open fills — resting bg only (no muted on hover or expanded).
  "h-auto w-fit! justify-between gap-2 font-normal hover:bg-background aria-expanded:bg-background dark:hover:bg-input/30 dark:aria-expanded:bg-input/30 [&>svg:last-child]:shrink-0",
  {
    variants: {
      size: {
        default: "min-h-9 px-2.5 py-1.5",
        sm: "min-h-8 px-2 py-1 text-xs",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
)

type MultiSelectComboboxContextValue = {
  value: string[]
  disabled: boolean
  toggle: (item: string) => void
  setOpen: (open: boolean) => void
  /** Last item Base UI reported as highlighted, when it reported one. */
  highlightedRef: React.RefObject<string | null>
  /** True while Space selects instead of typing (list-nav after ArrowDown). */
  spaceSelectsRef: React.RefObject<boolean>
}

const MultiSelectComboboxContext =
  React.createContext<MultiSelectComboboxContextValue | null>(null)

function useMultiSelectCombobox(): MultiSelectComboboxContextValue {
  const context = React.useContext(MultiSelectComboboxContext)
  if (!context) {
    throw new Error(
      "MultiSelectCombobox parts must be rendered inside <MultiSelectCombobox>",
    )
  }
  return context
}

function optionElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]'),
  )
}

function highlightedOption(root: HTMLElement): HTMLElement | null {
  const rows = optionElements(root)
  // Fall back to the first option when autoHighlight hasn't stamped
  // data-highlighted yet (common in happy-dom).
  return rows.find((row) => row.hasAttribute("data-highlighted")) ?? rows[0] ?? null
}

function isOnTopOption(root: HTMLElement): boolean {
  const rows = optionElements(root)
  if (rows.length === 0) return false
  return highlightedOption(root) === rows[0]
}

function readSearchValue(event: { target: EventTarget | null }): string {
  return event.target instanceof HTMLInputElement ? event.target.value : ""
}

function toStringArray(raw: unknown, fallback: string[]): string[] {
  if (!Array.isArray(raw)) return fallback
  return raw.filter((item): item is string => typeof item === "string")
}

interface MultiSelectComboboxProps {
  /** Selectable values. Base UI filters the popup against these strings. */
  items: string[]
  value: string[]
  onValueChange: (next: string[]) => void
  disabled?: boolean
  /** Omit for self-managed open state. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children?: React.ReactNode
}

/**
 * shadcn Combobox Popup + `multiple` + checkbox rows, as a composable set:
 *
 *   MultiSelectCombobox
 *     MultiSelectComboboxTrigger → MultiSelectComboboxValue (render prop)
 *     MultiSelectComboboxContent → Search, Empty, List → Option (checkbox + children)
 *
 * Keyboard:
 *   - autoHighlight keeps the first/matching row ready for Enter
 *   - Enter toggles the highlighted item and closes
 *   - Shift+Enter toggles and keeps the popup open
 *   - Space with an empty query toggles the auto-highlighted (first) item
 *   - After typing, ArrowDown locks Space-as-typing; Space then toggles the
 *     highlighted item (popup stays open). ArrowUp on the top item — or typing
 *     again — unlocks Space-as-typing (highlight wrap left unchanged)
 *   - Other keys still type while navigating
 */
function MultiSelectCombobox({
  items,
  value,
  onValueChange,
  disabled = false,
  open: openProp,
  onOpenChange,
  children,
}: MultiSelectComboboxProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const highlightedRef = React.useRef<string | null>(null)
  const spaceSelectsRef = React.useRef(false)
  const open = openProp ?? uncontrolledOpen

  const setOpen = React.useCallback(
    (next: boolean) => {
      if (!next) spaceSelectsRef.current = false
      if (openProp === undefined) setUncontrolledOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange, openProp],
  )

  const toggle = React.useCallback(
    (item: string) => {
      onValueChange(
        value.includes(item) ? value.filter((v) => v !== item) : [...value, item],
      )
    },
    [onValueChange, value],
  )

  const context = React.useMemo<MultiSelectComboboxContextValue>(
    () => ({ value, disabled, toggle, setOpen, highlightedRef, spaceSelectsRef }),
    [disabled, setOpen, toggle, value],
  )

  return (
    <MultiSelectComboboxContext.Provider value={context}>
      <Combobox
        multiple
        autoHighlight
        open={open}
        onOpenChange={setOpen}
        disabled={disabled}
        items={items}
        value={value}
        onItemHighlighted={(item) => {
          highlightedRef.current = typeof item === "string" ? item : null
        }}
        onValueChange={(next) => onValueChange(toStringArray(next, []))}
        onInputValueChange={() => {
          // Resume Space-as-typing whenever the query is edited again.
          spaceSelectsRef.current = false
        }}
      >
        {children}
      </Combobox>
    </MultiSelectComboboxContext.Provider>
  )
}

function MultiSelectComboboxTrigger({
  className,
  size,
  children,
  ...props
}: Omit<React.ComponentProps<typeof ComboboxTrigger>, "render"> &
  VariantProps<typeof triggerVariants>) {
  const { disabled } = useMultiSelectCombobox()
  return (
    <ComboboxTrigger
      data-slot="multi-select-combobox-trigger"
      disabled={disabled}
      // className goes to Button so buttonVariants conflicts (h-9, px-4) are
      // resolved by its own cn() rather than by stylesheet order.
      render={<Button variant="outline" className={cn(triggerVariants({ size }), className)} />}
      {...props}
    >
      {children}
    </ComboboxTrigger>
  )
}

/**
 * Selected-values summary for the trigger. `children` receives the selected
 * values; without it, values render comma-separated.
 */
function MultiSelectComboboxValue({
  placeholder,
  children,
}: {
  placeholder?: React.ReactNode
  children?: (selected: string[]) => React.ReactNode
}) {
  const { value } = useMultiSelectCombobox()
  return (
    <ComboboxValue>
      {(selected) => {
        const values = toStringArray(selected, value)
        if (values.length === 0) {
          return <span className="text-muted-foreground">{placeholder}</span>
        }
        return (
          children?.(values) ?? (
            <span className="truncate text-left">{values.join(", ")}</span>
          )
        )
      }}
    </ComboboxValue>
  )
}

function MultiSelectComboboxContent({
  className,
  style,
  onKeyDownCapture,
  ...props
}: React.ComponentProps<typeof ComboboxContent>) {
  const { disabled, toggle, setOpen, highlightedRef, spaceSelectsRef } =
    useMultiSelectCombobox()

  return (
    <ComboboxContent
      className={cn(POPUP_CONTENT_CLASS, className)}
      style={{ width: "max-content", minWidth: "12rem", ...style }}
      // Capture before ComboboxInput handlers (Enter / Space / space-lock).
      onKeyDownCapture={(event) => {
        onKeyDownCapture?.(event)
        if (disabled || event.defaultPrevented) return
        const popup = event.currentTarget
        const highlighted = () =>
          highlightedRef.current ??
          highlightedOption(popup)?.getAttribute("aria-label")?.trim() ??
          null

        // ArrowDown after typing → lock Space (list navigation). Do not
        // preventDefault — Base UI still moves the highlight / wraps.
        if (event.key === "ArrowDown") {
          if (readSearchValue(event).trim().length > 0) {
            spaceSelectsRef.current = true
          }
          return
        }

        // Extra step: ArrowUp on the top item unlocks Space without changing
        // wrap rules — consume this keypress so highlight stays; the next
        // ArrowUp wraps as usual.
        if (event.key === "ArrowUp") {
          if (spaceSelectsRef.current && isOnTopOption(popup)) {
            event.preventDefault()
            event.stopPropagation()
            spaceSelectsRef.current = false
          }
          return
        }

        // Space: empty query or list-nav lock → toggle highlighted (keep open).
        // Otherwise allow Space into the search field.
        if (event.key === " ") {
          const typed = readSearchValue(event)
          if (typed.trim().length === 0 || spaceSelectsRef.current) {
            const item = highlighted()
            if (!item) return
            event.preventDefault()
            event.stopPropagation()
            toggle(item)
          }
          return
        }

        if (event.key !== "Enter") return
        const item = highlighted()
        if (!item) return
        event.preventDefault()
        event.stopPropagation()
        toggle(item)
        if (!event.shiftKey) {
          setOpen(false)
        }
      }}
      {...props}
    />
  )
}

/** Popup search strip. Renders the separator below it by default. */
function MultiSelectComboboxSearch({
  className,
  showSeparator = true,
  autoComplete = "off",
  autoCorrect = "off",
  autoCapitalize = "none",
  spellCheck = false,
  ...props
}: React.ComponentProps<typeof ComboboxInput> & { showSeparator?: boolean }) {
  const { disabled } = useMultiSelectCombobox()
  return (
    <>
      <ComboboxInput
        showTrigger={false}
        showSearchIcon
        disabled={disabled}
        // Native default size=20 (~20ch) was wider than short option rows.
        size={1}
        className={cn(POPUP_SEARCH_CLASS, className)}
        {...props}
        autoComplete={autoComplete}
        autoCorrect={autoCorrect}
        autoCapitalize={autoCapitalize}
        spellCheck={spellCheck}
      />
      {showSeparator && <ComboboxSeparator className="mx-0 my-0" />}
    </>
  )
}

/**
 * Checkbox row. The Checkbox owns the selection chrome, so the trailing
 * ItemIndicator is omitted; `children` render the row's label content.
 */
function MultiSelectComboboxOption({
  value: itemValue,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<typeof ComboboxItem>, "value"> & { value: string }) {
  const { value } = useMultiSelectCombobox()
  return (
    <ComboboxItem
      value={itemValue}
      aria-label={itemValue}
      showIndicator={false}
      className={className}
      {...props}
    >
      <Checkbox
        checked={value.includes(itemValue)}
        tabIndex={-1}
        aria-hidden
        className="pointer-events-none"
      />
      {children}
    </ComboboxItem>
  )
}

export {
  MultiSelectCombobox,
  MultiSelectComboboxContent,
  MultiSelectComboboxOption,
  MultiSelectComboboxSearch,
  MultiSelectComboboxTrigger,
  MultiSelectComboboxValue,
  // Unchanged from the base primitive — re-exported so a consumer composes the
  // whole popup from one module.
  ComboboxEmpty as MultiSelectComboboxEmpty,
  ComboboxList as MultiSelectComboboxList,
}
