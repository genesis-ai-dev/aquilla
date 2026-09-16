import * as React from "react"
import { createPortal } from "react-dom"

import { cn } from "@/lib/utils"
import { useT } from "@/lib/i18n/I18nProvider"
import { Input } from "@/components/ui/input"
import {
  filterLanguages,
  isSettledLanguage,
  type LanguageEntry,
} from "@/lib/languages/catalog"

/**
 * AQU-988 — select-or-type language fields.
 *
 * WHY THIS IS NOT A `<Combobox>` (read before "simplifying" it):
 * a previous Base-UI Combobox version of the target-language chips field was
 * removed because its controlled `inputValue`/`value` interplay cleared
 * free-typed text on Enter in a real browser — happy-dom tests passed and
 * chips never stuck in Chromium. So this component owns nothing about the
 * text: the caller's `value` goes straight onto a plain `<input>`, exactly as
 * before, and the suggestion list is a *purely additive* portal layer on top.
 *
 * The two rules that keep the regression dead:
 *
 *  1. A highlight exists only while the list has matches to offer. AQU-1116
 *     pre-highlights the top-ranked row so type-then-Enter picks it, but the
 *     moment the query has no catalog match — or is already exactly one
 *     (`isSettledLanguage`) — `items` is empty, `activeIndex` falls back to -1
 *     and Enter falls through to whatever the field already did (commit a
 *     chip, add a lane, submit the form). Free-typed text like
 *     "Grade 7 English" therefore still never matches a suggestion.
 *  2. The list never writes back into the input on its own. Only an explicit
 *     click, or Enter on a highlighted row, calls `onSelect`/`onEnterSelect`.
 *
 * Opening is deliberately narrow: the list appears only when a real keystroke
 * produced the edit (or on ArrowDown), never on bare focus and never on a
 * value set programmatically. That keeps a popup from ever covering the
 * controls under a field that something else filled in — a form reset,
 * autofill, or a Playwright `fill()`. Specs that want the list open type with
 * `pressSequentially()`, which is what a user does anyway.
 */

/** Popup geometry, recomputed from the anchor's viewport rect while open. */
type PopupRect = { top: number; left: number; width: number; maxHeight: number }

const POPUP_GAP = 4
const POPUP_MAX_HEIGHT = 264
const POPUP_MIN_WIDTH = 180

function measure(anchor: HTMLElement): PopupRect {
  const rect = anchor.getBoundingClientRect()
  const below = window.innerHeight - rect.bottom - POPUP_GAP * 2
  const above = rect.top - POPUP_GAP * 2
  // Flip above the field when there is materially more room up there.
  const flip = below < 140 && above > below
  const maxHeight = Math.max(96, Math.min(POPUP_MAX_HEIGHT, flip ? above : below))
  return {
    top: flip ? rect.top - POPUP_GAP - maxHeight : rect.bottom + POPUP_GAP,
    left: rect.left,
    width: Math.max(POPUP_MIN_WIDTH, rect.width),
    maxHeight,
  }
}

let listIdSeq = 0

export type UseLanguageSuggestionsOptions = {
  /** Current text of the field — filters the catalog. */
  query: string
  /** Values already chosen (chips/lanes), so they aren't suggested again. */
  exclude?: readonly string[]
  disabled?: boolean
  /** Fires only on an explicit pick (click, or Enter on a highlighted row). */
  onSelect: (name: string) => void
  /**
   * AQU-1116 — overrides `onSelect` for the Enter path only. Fields that
   * already commit on Enter (the add-lane input) use this to commit the
   * *match* rather than the typed prefix, since their own `onKeyDown` never
   * runs once Enter has been claimed by a highlighted row. Clicking a row
   * still goes through `onSelect`, which only fills the field.
   */
  onEnterSelect?: (name: string) => void
}

export type LanguageSuggestions = {
  open: boolean
  items: LanguageEntry[]
  /**
   * Props to spread onto the field's `<input>`, after your own handlers. Pass
   * your handlers (and `ref`) in — they are composed, not replaced.
   */
  getInputProps: (
    props?: React.InputHTMLAttributes<HTMLInputElement> & {
      ref?: React.Ref<HTMLInputElement>
    },
  ) => React.InputHTMLAttributes<HTMLInputElement> & {
    ref: React.RefCallback<HTMLInputElement>
  }
  /** Render this next to the field; it portals to `document.body`. */
  popup: React.ReactNode
  close: () => void
  /** Focus the field the list is attached to (chips fields click-to-focus). */
  focusInput: () => void
}

/**
 * Headless select-or-type behaviour, shared by the single-value field below
 * and by the create dialog's chips field (which owns its own markup).
 */
export function useLanguageSuggestions({
  query,
  exclude,
  disabled = false,
  onSelect,
  onEnterSelect,
}: UseLanguageSuggestionsOptions): LanguageSuggestions {
  const t = useT()
  const [open, setOpen] = React.useState(false)
  const [activeIndex, setActiveIndex] = React.useState(-1)
  const [rect, setRect] = React.useState<PopupRect | null>(null)
  const anchorRef = React.useRef<HTMLInputElement | null>(null)
  /** Set by a text-producing keydown, consumed by the change it causes. */
  const typedRef = React.useRef(false)
  const listId = React.useMemo(() => `language-suggestions-${++listIdSeq}`, [])

  const items = React.useMemo(() => {
    if (disabled) return []
    const matches = filterLanguages(query, { exclude })
    // Nothing left to offer once the text IS the only match — hide rather than
    // suggest the user's own value back at them (and keep the popup from
    // covering the controls under a fully-filled field).
    return isSettledLanguage(query, matches) ? [] : matches
  }, [disabled, exclude, query])

  const close = React.useCallback(() => {
    setOpen(false)
    setActiveIndex(-1)
  }, [])

  // A query edit can shrink the list out from under the highlight. With
  // matches left the top row takes over (AQU-1116); with none, nothing is
  // highlighted, which is what keeps Enter falling through to free text.
  React.useEffect(() => {
    setActiveIndex((current) => {
      if (items.length === 0) return -1
      return current >= items.length ? 0 : current
    })
  }, [items.length])

  React.useEffect(() => {
    if (!open) return
    const anchor = anchorRef.current
    if (!anchor) return
    const sync = () => setRect(measure(anchor))
    sync()
    // Capture so the popup tracks scrolling inside dialogs and settings cards.
    window.addEventListener("scroll", sync, true)
    window.addEventListener("resize", sync)
    return () => {
      window.removeEventListener("scroll", sync, true)
      window.removeEventListener("resize", sync)
    }
  }, [open, items.length])

  React.useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (!target) return
      if (anchorRef.current?.contains(target)) return
      if ((target as HTMLElement).closest?.(`[data-language-list="${listId}"]`)) return
      close()
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [close, listId, open])

  const focusInput = React.useCallback(() => {
    anchorRef.current?.focus()
  }, [])

  const pick = React.useCallback(
    (entry: LanguageEntry, via: "click" | "enter") => {
      close()
      const handler = (via === "enter" && onEnterSelect) || onSelect
      handler(entry.name)
      anchorRef.current?.focus()
    },
    [close, onEnterSelect, onSelect],
  )

  const getInputProps: LanguageSuggestions["getInputProps"] = React.useCallback(
    ({ ref: externalRef, ...props } = {}) => ({
      ...props,
      ref: (node) => {
        anchorRef.current = node
        if (typeof externalRef === "function") externalRef(node)
        else if (externalRef) externalRef.current = node
      },
      role: "combobox",
      "aria-expanded": open,
      "aria-controls": open ? listId : undefined,
      "aria-autocomplete": "list",
      "aria-activedescendant":
        open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined,
      onChange: (event) => {
        const field = event.currentTarget
        const typed = typedRef.current
        typedRef.current = false
        props.onChange?.(event)
        if (disabled) return
        // Only a keystroke on the focused field raises the list.
        const raise = typed && field.ownerDocument.activeElement === field
        // AQU-1116: typing re-ranks the list, so the highlight goes back to
        // the new best match. If the edit leaves no matches at all, the clamp
        // effect above drops this to -1 before Enter can see it.
        setActiveIndex(raise ? 0 : -1)
        setOpen(raise)
      },
      onBlur: (event) => {
        props.onBlur?.(event)
        close()
      },
      onKeyDown: (event) => {
        if (!disabled) {
          // A printable key or a delete is about to change the text; mark it
          // so the resulting change event knows a human caused it.
          if (
            event.key.length === 1 ||
            event.key === "Backspace" ||
            event.key === "Delete" ||
            event.key === "Process"
          ) {
            typedRef.current = true
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (items.length > 0) {
              event.preventDefault()
              if (!open) {
                setOpen(true)
                setActiveIndex(event.key === "ArrowDown" ? 0 : items.length - 1)
              } else {
                setActiveIndex((current) => {
                  const step = event.key === "ArrowDown" ? 1 : -1
                  const next = current + step
                  if (next < 0) return items.length - 1
                  if (next >= items.length) return 0
                  return next
                })
              }
              return
            }
          } else if (event.key === "Enter") {
            // Only a highlighted row wins Enter — and a row is highlighted
            // only while the list actually has matches, so free text still
            // falls through to the field's own handler.
            const entry = open && activeIndex >= 0 ? items[activeIndex] : undefined
            if (entry) {
              event.preventDefault()
              event.stopPropagation()
              pick(entry, "enter")
              return
            }
          } else if (event.key === "Escape" && open) {
            // Swallow so Escape dismisses the list, not the whole dialog.
            event.preventDefault()
            event.stopPropagation()
            close()
            return
          } else if (event.key === "Tab") {
            close()
          }
        }
        props.onKeyDown?.(event)
      },
    }),
    [activeIndex, close, disabled, items, listId, open, pick],
  )

  const visible = open && items.length > 0 && rect !== null
  const popup =
    visible && typeof document !== "undefined"
      ? createPortal(
          <div
            data-language-list={listId}
            data-slot="language-suggestions"
            className="fixed z-50 overflow-hidden rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            style={{
              top: rect.top,
              left: rect.left,
              width: rect.width,
              maxHeight: rect.maxHeight,
            }}
            // Keep focus in the field so blur-driven commits never fire mid-pick.
            onMouseDown={(event) => event.preventDefault()}
          >
            <ul
              id={listId}
              role="listbox"
              aria-label={t("projectSettings.languages.suggestionsAriaLabel")}
              className="max-h-full overflow-y-auto overscroll-contain"
              style={{ maxHeight: rect.maxHeight - 8 }}
            >
              {items.map((entry, index) => (
                <li key={entry.code} role="presentation">
                  <button
                    type="button"
                    id={`${listId}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    tabIndex={-1}
                    data-testid={`language-option-${entry.code}`}
                    data-highlighted={index === activeIndex ? "" : undefined}
                    className={cn(
                      "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-start text-sm",
                      index === activeIndex && "bg-accent/40 text-accent-foreground",
                    )}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => pick(entry, "click")}
                  >
                    <span className="truncate">{entry.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {entry.code}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )
      : null

  return { open: visible, items, getInputProps, popup, close, focusInput }
}

export type LanguageComboboxInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange"
> & {
  value: string
  /** Fires for both typing and picking a suggestion — always a plain string. */
  onValueChange: (next: string) => void
  /**
   * AQU-1116 — replaces `onValueChange` when Enter picks a highlighted row,
   * for fields that commit on Enter and so need the match itself, not just
   * the text. See `UseLanguageSuggestionsOptions.onEnterSelect`.
   */
  onEnterSelect?: (name: string) => void
  /** Values already chosen elsewhere in the same field group. */
  exclude?: readonly string[]
}

/**
 * Drop-in replacement for a free-text language `<Input>`: same id/name/testid
 * contract, same value semantics, plus a filterable suggestion list. Renders
 * no wrapper element, so existing layout and locators are untouched.
 */
export function LanguageComboboxInput({
  value,
  onValueChange,
  onEnterSelect,
  exclude,
  disabled,
  onChange,
  onKeyDown,
  onBlur,
  ...props
}: LanguageComboboxInputProps & {
  onChange?: React.ChangeEventHandler<HTMLInputElement>
}) {
  const { getInputProps, popup } = useLanguageSuggestions({
    query: value,
    exclude,
    disabled,
    onSelect: onValueChange,
    onEnterSelect,
  })

  return (
    <>
      <Input
        {...props}
        disabled={disabled}
        value={value}
        {...getInputProps({
          onChange: (event) => {
            onChange?.(event)
            onValueChange(event.currentTarget.value)
          },
          onKeyDown,
          onBlur,
        })}
      />
      {popup}
    </>
  )
}
