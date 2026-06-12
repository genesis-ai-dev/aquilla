import { useEffect, useRef, useState } from "react"
import { Check, AtSign } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useUserSearch, type UserSearchResult } from "@/hooks/useUserSearch"

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
}: Props) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { results, isLoading, needsMorePrefix, lastFetchOk } = useUserSearch(
    value.mode === "username" ? value.raw : ""
  )

  // Close the dropdown on outside click — typeahead UX expects this.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDocClick)
    return () => document.removeEventListener("mousedown", onDocClick)
  }, [open])

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

  const showSuggestions =
    value.mode === "username" && open && value.raw.trim().length > 0

  return (
    <div ref={containerRef} className="relative space-y-1">
      <div className="flex items-center gap-1.5">
        {showModeToggle && (
          <div className="inline-flex shrink-0 rounded-md border bg-muted/20 p-0.5 text-[10px]">
            <button
              type="button"
              onClick={() => handleSwitchMode("username")}
              disabled={disabled}
              className={`rounded px-1.5 py-0.5 ${
                value.mode === "username"
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Invite an existing Aquilla user"
            >
              @user
            </button>
            <button
              type="button"
              onClick={() => handleSwitchMode("email")}
              disabled={disabled}
              className={`rounded px-1.5 py-0.5 ${
                value.mode === "email"
                  ? "bg-background shadow-sm text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              title="Invite by email — they'll be prompted to sign up if needed"
            >
              email
            </button>
          </div>
        )}

        <div className="relative flex-1">
          <Input
            id={inputId}
            type={value.mode === "email" ? "email" : "text"}
            inputMode={value.mode === "email" ? "email" : undefined}
            autoComplete="off"
            disabled={disabled}
            value={value.raw}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => value.mode === "username" && setOpen(true)}
            placeholder={
              placeholder?.[value.mode] ??
              (value.mode === "email"
                ? "name@example.com"
                : "Aquilla username")
            }
          />
          {value.mode === "username" && value.resolved && (
            <span
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 text-[10px]"
              title="Verified Aquilla user"
            >
              <Check className="h-3 w-3" /> verified
            </span>
          )}
        </div>
      </div>

      {/* Username suggestions dropdown */}
      {showSuggestions && (
        <div className="absolute left-0 right-0 top-full mt-0.5 z-40 max-h-56 overflow-y-auto rounded-md border bg-popover shadow-md">
          {needsMorePrefix && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              Type at least 2 characters to search.
            </p>
          )}

          {!needsMorePrefix && isLoading && results.length === 0 && (
            <p className="flex items-center gap-1.5 px-3 py-2 text-[11px] text-muted-foreground">
              <Spinner className="size-3" /> Searching…
            </p>
          )}

          {/* Only claim "no user named X" when the search actually
              succeeded (lastFetchOk). When the search endpoint isn't
              deployed yet (404) or the network errored, we'd otherwise
              be lying about the user's existence — suppress the
              false-negative and render a softer fallback hint. */}
          {!needsMorePrefix && !isLoading && results.length === 0 && value.raw.trim().length >= 2 && lastFetchOk && (
            <div className="px-3 py-2">
              <p className="text-[11px] text-muted-foreground">
                No Aquilla user named "{value.raw.trim()}".
              </p>
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

          {!needsMorePrefix && !isLoading && results.length === 0 && value.raw.trim().length >= 2 && !lastFetchOk && (
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              Couldn't search right now — we'll verify the username when you submit.
            </p>
          )}

          {results.length > 0 && (
            <ul className="py-0.5">
              {results.map((u) => {
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
                <li className="px-3 py-1 text-[10px] text-muted-foreground">
                  Loading…
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
