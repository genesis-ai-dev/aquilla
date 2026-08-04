import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check, AtSign } from "lucide-react"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { useUserSearch, type UserSearchResult } from "@/hooks/useUserSearch"

/**
 * AQU-734: multi-select wiring. When passed, each search result renders as a
 * checkbox row reflecting `stagedUsernames` (lowercased) instead of a
 * single-pick row, toggling keeps the dropdown open (staging accumulates
 * across searches), and Enter stages the free-typed value. The parent owns the
 * staged set + chips; this component only surfaces the search + toggle affordances.
 */
export interface MultiSelectConfig {
  /** Lowercased usernames currently staged, used to render the checked state. */
  stagedUsernames: ReadonlySet<string>
  /** Toggle a searched user in/out of the staged set. */
  onToggleResult: (u: UserSearchResult) => void
  /** Stage whatever is currently typed (Enter key). Parent clears `raw`. */
  onStageTyped: () => void
}

export type RecipientMode = "username" | "email"

export interface RecipientValue {
  mode: RecipientMode
  /** Raw input (username or email). For username mode, gets resolved to a
   * verified UserSearchResult when the user picks from suggestions. */
  raw: string
  /** Set when the user explicitly picked a search result. Used by the
   * caller to know "this username is verified to exist" without a separate
   * lookup round-trip. Cleared whenever raw changes after a pick. */
  resolved?: UserSearchResult
}

interface Props {
  value: RecipientValue
  onChange: (next: RecipientValue) => void
  disabled?: boolean
  /** Optional id wired to a <label htmlFor="…"> in the parent. */
  inputId?: string
  /** Show the mode toggle (username / email). When false, the component
   * stays in `value.mode` permanently — useful for surfaces that don't
   * support email invites yet. */
  showModeToggle?: boolean
  placeholder?: { username?: string; email?: string }
  excludedUserIds?: readonly number[]
  /** Scope search to related users. Disable for org membership, where any Aquilla user can be added. */
  scopedSearch?: boolean
  /** AQU-734: enable checkbox multi-select. Absent = legacy single-pick. */
  multiSelect?: MultiSelectConfig
  /**
   * Eligible people offered as rows before any search fires — e.g. org
   * colleagues without a direct grant (the AQU-672 Team-detail pattern).
   * When provided (even empty), the dropdown opens on focus with these rows;
   * typing narrows them by substring, and 2+ characters merges in server
   * search results. Absent = dropdown only opens once something is typed.
   */
  suggestions?: readonly UserSearchResult[]
  /** Shown when `suggestions` is provided but empty and nothing is typed. */
  emptySuggestionsHint?: string
}

/**
 * Add-member input with a server-validated username typeahead and an
 * optional email mode for inviting people who don't have a Frontier
 * account yet.
 *
 * Username mode:
 *   - As the user types, calls /api/v2/users/search and renders a
 *     dropdown of matches. The user clicks a row to "lock in" the
 *     selection — `value.resolved` carries the verified user record.
 *   - Sub-2-char input renders a hint instead of a request.
 *   - "No matches" renders explicitly so the user knows the username
 *     they typed isn't a Frontier account (use email mode instead).
 *
 * Email mode:
 *   - Plain email input. Caller validates / passes through to the
 *     invite endpoint (which RFC-validates server-side too).
 *
 * Mode toggle is a single-char-width affordance to swap between the
 * two — chosen over two separate fields to keep the form compact and
 * clearly mutually-exclusive (you invite ONE person, by ONE handle).
 */
export function UsernameTypeahead({
  value,
  onChange,
  disabled,
  inputId,
  showModeToggle = true,
  placeholder,
  excludedUserIds = [],
  scopedSearch = true,
  multiSelect,
  suggestions,
  emptySuggestionsHint,
}: Props) {
  const [open, setOpen] = useState(false)
  // Anchored below the input by default (`top`), flipped above (`bottom`)
  // when the viewport can't fit the dropdown underneath — e.g. the add row
  // at the bottom of the project overview Members card.
  const [dropdownPosition, setDropdownPosition] = useState<{
    left: number
    width: number
    top?: number
    bottom?: number
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const { query, results, isLoading, lastFetchOk } = useUserSearch(
    value.mode === "username" ? value.raw : "",
    undefined,
    undefined,
    scopedSearch
  )
  const trimmedRaw = value.raw.trim()
  const searchMatchesInput = query.trim() === trimmedRaw
  const needsMorePrefix = trimmedRaw.length > 0 && trimmedRaw.length < 2
  const excludedUserIdSet = new Set(excludedUserIds)
  const byName = (a: UserSearchResult, b: UserSearchResult) =>
    a.username.localeCompare(b.username, undefined, { sensitivity: "base" })
  const visibleResults = searchMatchesInput
    ? results.filter((u) => !excludedUserIdSet.has(u.id)).sort(byName)
    : []
  // Eligible-colleague rows: the full pool with nothing typed, substring-
  // narrowed as the user types (mirrors the AQU-672 combobox). Server search
  // results merge in from 2 characters, deduped by id.
  const matchingSuggestions = (suggestions ?? [])
    .filter((u) => !excludedUserIdSet.has(u.id))
    .filter(
      (u) =>
        trimmedRaw.length === 0 ||
        u.username.toLowerCase().includes(trimmedRaw.toLowerCase())
    )
    .sort(byName)
  const suggestedIds = new Set(matchingSuggestions.map((u) => u.id))
  const visibleRows =
    trimmedRaw.length >= 2
      ? [
          ...matchingSuggestions,
          ...visibleResults.filter((u) => !suggestedIds.has(u.id)),
        ].sort(byName)
      : matchingSuggestions
  const allMatchesAlreadyAdded =
    !needsMorePrefix &&
    searchMatchesInput &&
    !isLoading &&
    results.length > 0 &&
    visibleRows.length === 0
  const searchPendingForInput =
    !needsMorePrefix && trimmedRaw.length >= 2 && (!searchMatchesInput || isLoading)
  const canShowSettledEmptyState =
    !needsMorePrefix &&
    searchMatchesInput &&
    !isLoading &&
    results.length === 0 &&
    visibleRows.length === 0 &&
    trimmedRaw.length >= 2
  const showEmptySuggestionsHint =
    suggestions != null &&
    trimmedRaw.length === 0 &&
    matchingSuggestions.length === 0 &&
    emptySuggestionsHint != null
  const showSuggestions =
    value.mode === "username" &&
    open &&
    (trimmedRaw.length > 0 || suggestions != null)

  // Close the dropdown on outside click — typeahead UX expects this.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node
      if (containerRef.current?.contains(target)) return
      if (dropdownRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [open])

  useEffect(() => {
    if (!showSuggestions) {
      setDropdownPosition(null)
      return
    }

    function updateDropdownPosition() {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) return
      // max-h-44 (176px) + gap: flip above when that can't fit below and
      // there's more room above. Anchoring with `bottom` lets the list grow
      // upward as rows load, so no content measurement is needed.
      const DROPDOWN_MAX_PX = 176 + 8
      const spaceBelow = window.innerHeight - rect.bottom
      const openAbove = spaceBelow < DROPDOWN_MAX_PX && rect.top > spaceBelow
      setDropdownPosition(
        openAbove
          ? {
              left: rect.left,
              width: rect.width,
              bottom: window.innerHeight - rect.top + 4,
            }
          : { left: rect.left, width: rect.width, top: rect.bottom + 4 },
      )
    }

    updateDropdownPosition()
    window.addEventListener("resize", updateDropdownPosition)
    window.addEventListener("scroll", updateDropdownPosition, true)
    return () => {
      window.removeEventListener("resize", updateDropdownPosition)
      window.removeEventListener("scroll", updateDropdownPosition, true)
    }
  }, [showSuggestions])

  function handleChange(raw: string) {
    onChange({
      mode: value.mode,
      raw,
      // Clear resolved if the user edited away from a previously-picked username.
      resolved:
        value.resolved && value.resolved.username === raw ? value.resolved : undefined,
    })
    if (value.mode === "username") setOpen(true)
  }

  function handlePick(result: UserSearchResult) {
    onChange({ mode: "username", raw: result.username, resolved: result })
    setOpen(false)
  }

  function handleSwitchMode(next: RecipientMode) {
    onChange({ mode: next, raw: "", resolved: undefined })
    setOpen(false)
  }

  return (
    <div ref={containerRef} className="relative space-y-1">
      <div className="flex items-center gap-1.5">
        {showModeToggle && (
          <div className="inline-flex shrink-0 rounded-md border bg-muted/20 p-0.5 text-[10px]">
            <AppTooltip content="Invite an existing Aquilla user">
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={() => handleSwitchMode("username")}
                  disabled={disabled}
                  className={`rounded px-1.5 py-0.5 ${
                    value.mode === "username"
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  @user
                </button>
              </span>
            </AppTooltip>
            <AppTooltip content="Invite by email; they'll be prompted to sign up if needed" className="max-w-xs">
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={() => handleSwitchMode("email")}
                  disabled={disabled}
                  className={`rounded px-1.5 py-0.5 ${
                    value.mode === "email"
                      ? "bg-background text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  email
                </button>
              </span>
            </AppTooltip>
          </div>
        )}

        <InputGroup className="flex-1">
          <InputGroupInput
            id={inputId}
            type={value.mode === "email" ? "email" : "text"}
            inputMode={value.mode === "email" ? "email" : undefined}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
            value={value.raw}
            onChange={(e) => handleChange(e.target.value)}
            onKeyDown={(e) => {
              // AQU-734: in multi-select mode Enter stages the typed value as a
              // chip rather than submitting a single add. Only fire when there's
              // something to stage so an empty Enter is a no-op.
              if (
                multiSelect &&
                e.key === "Enter" &&
                value.mode === "username" &&
                value.raw.trim().length > 0
              ) {
                e.preventDefault()
                multiSelect.onStageTyped()
              }
            }}
            onFocus={() => value.mode === "username" && setOpen(true)}
            placeholder={
              placeholder?.[value.mode] ??
              (value.mode === "email"
                ? "name@example.com"
                : "Aquilla username")
            }
          />
          {value.mode === "username" && value.resolved && (
            <InputGroupAddon align="inline-end">
              <AppTooltip content="Verified Aquilla user">
                <InputGroupText className="rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[10px]">
                  <Check /> verified
                </InputGroupText>
              </AppTooltip>
            </InputGroupAddon>
          )}
        </InputGroup>
      </div>

      {/* Username suggestions dropdown */}
      {showSuggestions && dropdownPosition && typeof document !== "undefined" && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[60] max-h-44 overflow-y-auto rounded-md border bg-popover shadow-md"
          style={{
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            top: dropdownPosition.top,
            bottom: dropdownPosition.bottom,
          }}
        >
          {needsMorePrefix && visibleRows.length === 0 && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              Type at least 2 characters to search.
            </p>
          )}

          {showEmptySuggestionsHint && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              {emptySuggestionsHint}
            </p>
          )}

          {searchPendingForInput && visibleRows.length === 0 && (
            <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
              <Spinner className="size-3" /> Searching…
            </p>
          )}

          {allMatchesAlreadyAdded && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              Matching users are already members.
            </p>
          )}

          {/* Only claim "no user named X" when the search actually
              succeeded (lastFetchOk). When the search endpoint isn't
              deployed yet (404) or the network errored, we'd otherwise
              be lying about the user's existence — suppress the
              false-negative and render a softer fallback hint. */}
          {canShowSettledEmptyState && lastFetchOk && (
            <div className="px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                {multiSelect && scopedSearch
                  ? // Scoped search only sees org/project-overlap users
                    // (AQU-321), so a miss is NOT proof the account doesn't
                    // exist — don't claim it is.
                    `No match among people who share an org or project with you.`
                  : `No Aquilla user named "${trimmedRaw}".`}
              </p>
              {multiSelect && (
                <button
                  type="button"
                  onClick={() => multiSelect.onStageTyped()}
                  className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                >
                  Add "{trimmedRaw}" by exact username
                </button>
              )}
              {showModeToggle && (
                <button
                  type="button"
                  onClick={() => handleSwitchMode("email")}
                  className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                >
                  <AtSign className="h-3 w-3" />
                  Invite by email instead
                </button>
              )}
            </div>
          )}

          {canShowSettledEmptyState && !lastFetchOk && (
            <div className="px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                Couldn't search right now — we'll verify the username when you submit.
              </p>
              {multiSelect && (
                <button
                  type="button"
                  onClick={() => multiSelect.onStageTyped()}
                  className="mt-1 inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                >
                  Add "{trimmedRaw}" by exact username
                </button>
              )}
            </div>
          )}

          {visibleRows.length > 0 && (
            <ul className="py-0.5">
              {visibleRows.map((u) => {
                if (multiSelect) {
                  // AQU-734: checkbox row. The whole row is one control acting as
                  // a checkbox (role+aria-checked) so its accessible name is the
                  // username and there's no nested-interactive nesting. Toggling
                  // keeps the dropdown open so several people accumulate.
                  const checked = multiSelect.stagedUsernames.has(
                    u.username.toLowerCase(),
                  )
                  return (
                    <li key={u.id}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        onClick={() => multiSelect.onToggleResult(u)}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted ${
                          checked ? "bg-muted/60" : ""
                        }`}
                      >
                        <span
                          aria-hidden
                          className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border ${
                            checked
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-input"
                          }`}
                        >
                          {checked && <Check className="h-3 w-3" />}
                        </span>
                        <span className="truncate">{u.username}</span>
                      </button>
                    </li>
                  )
                }
                const isSelected =
                  value.resolved?.id === u.id && value.resolved?.username === u.username
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      onClick={() => handlePick(u)}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-muted ${
                        isSelected ? "bg-muted/60" : ""
                      }`}
                    >
                      <span>{u.username}</span>
                      {isSelected && (
                        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      )}
                    </button>
                  </li>
                )
              })}
              {isLoading && (
                <li className="flex items-center px-3 py-1 text-muted-foreground">
                  <Spinner className="size-3" />
                </li>
              )}
            </ul>
          )}
        </div>,
        document.body
      )}
    </div>
  )
}
