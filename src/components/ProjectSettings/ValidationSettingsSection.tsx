import { useRef, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { Checkbox } from "@/components/ui/checkbox"
import { Button } from "@/components/ui/button"
import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { DisabledFieldTooltip } from "./DisabledFieldTooltip"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { VALIDATION_FLOOR_ROLE_OPTIONS, roleDisplayText } from "@/lib/frontier/roles"
import type { ProjectRecord } from "@/lib/parsers/types"

type ValidationRoleFloor = NonNullable<ProjectRecord["validationRoleFloor"]>

const NAMED_VALIDATOR_AVATAR_CAP = 3

// Popup search field styling — same strip treatment as ChapterNavigator.
// size={1} on the input kills the native default size=20 (~20ch) that was
// forcing the popover wider than checkbox+avatar+name rows.
const POPUP_SEARCH_CLASS =
  "w-full min-w-0 rounded-none border-0 shadow-none outline-none ring-0 *:data-[slot=input-group-control]:min-w-0 *:data-[slot=input-group-control]:w-full *:data-[slot=input-group-control]:text-sm *:data-[slot=input-group-addon]:pl-3 hover:border-0! focus-within:border-0! has-[[data-slot=input-group-control]:focus-visible]:border-0! has-[[data-slot=input-group-control]:focus-visible]:ring-0!"

const POPUP_CONTENT_CLASS =
  // Hug list content (not trigger / not input size=20). Search stretches to match.
  "w-max! min-w-48! max-w-(--available-width) *:data-[slot=input-group]:w-full *:data-[slot=input-group]:min-w-0 *:data-[slot=input-group]:mx-0! *:data-[slot=input-group]:my-0! *:data-[slot=input-group]:border-0! *:data-[slot=input-group]:bg-transparent! *:data-[slot=input-group]:shadow-none!"

// AQU-352: the minimum-validator-role floor draws its labels from the canonical
// role source (roles.ts) so they read identically to the member / invite /
// share surfaces — no per-surface role-name drift. The offered set is an
// intentional subset (reviewer and up); subsetting is fine, renaming is not.
// `roleName` (the option's `name`) is exactly the ProjectRecord
// `validationRoleFloor` literal, so it doubles as the stored value.
const ROLE_OPTIONS: { value: ValidationRoleFloor; label: string }[] =
  VALIDATION_FLOOR_ROLE_OPTIONS.map((o) => ({
    value: o.name as ValidationRoleFloor,
    label: roleDisplayText(o.name),
  }))

interface Props {
  /** Project id for loading member usernames into the named-validators combobox. */
  projectId?: string | null
  validationCount: number
  validationCountAudio: number
  hasAnyAudioData: boolean
  validationRoleFloor?: ValidationRoleFloor
  /** Named-user allowlist (usernames). Empty = any sufficiently-privileged user. */
  validationNamedUsers?: string[]
  allowSelfValidation?: boolean
  /** When true, all inputs are disabled (role/offline gate). */
  disabled?: boolean
  /** Tooltip shown on hover when disabled is true. */
  disabledTooltip?: string
  onChange: (
    updates: Partial<
      Pick<
        ProjectRecord,
        | "validationCount"
        | "validationCountAudio"
        | "validationRoleFloor"
        | "validationNamedUsers"
        | "allowSelfValidation"
      >
    >
  ) => void
}

/**
 * shadcn Combobox Popup + multiple + custom items:
 *   ComboboxTrigger → avatar stack + comma-separated names
 *   ComboboxContent → search input, then Checkbox + Avatar rows
 *
 * Keyboard:
 *   - autoHighlight keeps the first/matching row ready for Enter
 *   - Enter toggles the highlighted member and closes
 *   - Shift+Enter toggles and keeps the popup open
 *   - Space with an empty query toggles the auto-highlighted (first) member
 *   - After typing, ArrowDown locks Space-as-typing; Space then toggles the
 *     highlighted member (popup stays open). ArrowUp on the top item — or
 *     typing again — unlocks Space-as-typing (highlight wrap left unchanged)
 *   - Other keys still type while navigating
 */
function NamedValidatorsCombobox({
  items,
  value,
  disabled,
  onValueChange,
}: {
  items: string[]
  value: string[]
  disabled: boolean
  onValueChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const highlightedRef = useRef<string | null>(null)
  // After ArrowDown with a non-empty query, Space is locked until ArrowUp on top.
  const spacesLockedRef = useRef(false)

  function toggleUsername(username: string) {
    onValueChange(
      value.includes(username)
        ? value.filter((u) => u !== username)
        : [...value, username],
    )
  }

  function resolveHighlightedUsername(): string | null {
    if (highlightedRef.current) return highlightedRef.current
    // Prefer the Base UI highlighted row; fall back to the first option when
    // autoHighlight hasn't stamped data-highlighted yet (common in happy-dom).
    const el =
      document.querySelector<HTMLElement>('[data-slot="combobox-item"][data-highlighted]') ??
      document.querySelector<HTMLElement>('[data-slot="combobox-item"]')
    return el?.getAttribute("aria-label")?.trim() || null
  }

  function isOnTopItem(): boolean {
    const rows = document.querySelectorAll<HTMLElement>('[data-slot="combobox-item"]')
    if (rows.length === 0) return false
    const highlighted =
      document.querySelector<HTMLElement>('[data-slot="combobox-item"][data-highlighted]') ??
      rows[0]
    return highlighted === rows[0]
  }

  function readSearchValue(event: { target: EventTarget | null }): string {
    return event.target instanceof HTMLInputElement ? event.target.value : ""
  }

  return (
    <Combobox
      multiple
      autoHighlight
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) spacesLockedRef.current = false
      }}
      disabled={disabled}
      items={items}
      value={value}
      onItemHighlighted={(item) => {
        highlightedRef.current = typeof item === "string" ? item : null
      }}
      onValueChange={(next) => {
        onValueChange(
          Array.isArray(next) ? next.filter((u): u is string => typeof u === "string") : [],
        )
      }}
      onInputValueChange={() => {
        // Resume Space-as-typing whenever the query is edited again.
        spacesLockedRef.current = false
      }}
    >
      <ComboboxTrigger
        id="validation-named-users"
        disabled={disabled}
        render={
          <Button
            variant="outline"
            className="h-auto min-h-9 w-full max-w-md justify-between gap-2 px-2.5 py-1.5 font-normal [&>svg:last-child]:shrink-0"
          />
        }
      >
        <ComboboxValue>
          {(selected) => {
            const names = Array.isArray(selected)
              ? selected.filter((u): u is string => typeof u === "string")
              : value
            if (names.length === 0) {
              return <span className="text-muted-foreground">Select project members…</span>
            }
            const shown = names.slice(0, NAMED_VALIDATOR_AVATAR_CAP)
            const overflow = names.length - shown.length
            return (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {/* Same AvatarGroup + square InitialsAvatar stack as MembershipAvatars. */}
                <AvatarGroup
                  className="-space-x-1.5 *:data-[slot=avatar]:ring-background"
                  aria-hidden
                >
                  {shown.map((username) => (
                    <InitialsAvatar
                      key={username}
                      name={username}
                      size="sm"
                      singleInitial
                    />
                  ))}
                  {overflow > 0 && (
                    <AvatarGroupCount className="size-6 text-[10px] font-semibold">
                      +{overflow}
                    </AvatarGroupCount>
                  )}
                </AvatarGroup>
                <span className="truncate text-left">{names.join(", ")}</span>
              </span>
            )
          }}
        </ComboboxValue>
      </ComboboxTrigger>

      <ComboboxContent
        className={POPUP_CONTENT_CLASS}
        style={{ width: "max-content", minWidth: "12rem" }}
        // Capture before ComboboxInput handlers (Enter / Space / space-lock).
        onKeyDownCapture={(event) => {
          if (disabled) return

          // ArrowDown after typing → lock Space (list navigation). Do not
          // preventDefault — Base UI still moves the highlight / wraps.
          if (event.key === "ArrowDown") {
            if (readSearchValue(event).trim().length > 0) {
              spacesLockedRef.current = true
            }
            return
          }

          // Extra step: ArrowUp on the top item unlocks Space without changing
          // wrap rules — consume this keypress so highlight stays; the next
          // ArrowUp wraps as usual.
          if (event.key === "ArrowUp") {
            if (spacesLockedRef.current && isOnTopItem()) {
              event.preventDefault()
              event.stopPropagation()
              spacesLockedRef.current = false
            }
            return
          }

          // Space: empty query or list-nav lock → toggle highlighted (keep open).
          // Otherwise allow Space into the search field.
          if (event.key === " ") {
            const typed = readSearchValue(event)
            if (typed.trim().length === 0 || spacesLockedRef.current) {
              const highlighted = resolveHighlightedUsername()
              if (!highlighted) return
              event.preventDefault()
              event.stopPropagation()
              toggleUsername(highlighted)
              return
            }
          }

          if (event.key !== "Enter") return
          const highlighted = resolveHighlightedUsername()
          if (!highlighted) return
          event.preventDefault()
          event.stopPropagation()
          toggleUsername(highlighted)
          if (!event.shiftKey) {
            setOpen(false)
          }
        }}
      >
        <ComboboxInput
          showTrigger={false}
          showSearchIcon
          placeholder="Search members…"
          aria-label="Search members"
          disabled={disabled}
          // Native default size=20 (~20ch) was wider than short member rows.
          size={1}
          className={POPUP_SEARCH_CLASS}
        />
        <ComboboxSeparator className="mx-0 my-0" />
        <ComboboxEmpty>No members found.</ComboboxEmpty>
        <ComboboxList>
          {(item: string) => {
            const selected = value.includes(item)
            return (
              <ComboboxItem
                key={item}
                value={item}
                aria-label={item}
                // Checkbox owns selection chrome — don't mount the trailing check
                // (avoids CSS hacks that previously hid the username when unselected).
                showIndicator={false}
              >
                <Checkbox
                  checked={selected}
                  tabIndex={-1}
                  aria-hidden
                  className="pointer-events-none"
                />
                {/* Match MembersSection / MembershipAvatars: square InitialsAvatar. */}
                <span aria-hidden className="shrink-0">
                  <InitialsAvatar name={item} size="sm" singleInitial menuSafe />
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {item}
                </span>
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

/**
 * Settings card for validation rules.
 * Controls:
 *  - Required validator counts (text / audio)
 *  - Role floor (minimum role that can validate)
 *  - Allow self-validation toggle
 *  - Named-user allowlist (multi-select Combobox of project members)
 *
 * Server enforcement of role floor, named-user, and self-validation is
 * deferred — see SWARM-TODOs in src/lib/parsers/types.ts (validationRoleFloor,
 * validationNamedUsers, allowSelfValidation fields).
 */
export function ValidationSettingsSection({
  projectId = null,
  validationCount,
  validationCountAudio,
  hasAnyAudioData,
  validationRoleFloor = "reviewer",
  validationNamedUsers = [],
  allowSelfValidation = true,
  disabled = false,
  disabledTooltip,
  onChange,
}: Props) {
  const { members } = useProjectMembers(projectId)

  // Offer project members, and keep any already-saved names that left the roster
  // so they remain selectable / visible in the trigger.
  const namedUserItems = Array.from(
    new Set([
      ...members.map((m) => m.username),
      ...validationNamedUsers,
    ]),
  ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))

  function clamp(raw: string): number {
    const n = Math.floor(Number(raw))
    if (!Number.isFinite(n)) return 1
    if (n < 1) return 1
    if (n > 15) return 15
    return n
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Validation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* ── Count thresholds ── */}
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="validation-count">Required validators (text)</FieldLabel>
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Input
              id="validation-count"
              type="number"
              min={1}
              max={15}
              disabled={disabled}
              value={validationCount}
              onChange={(e) => onChange({ validationCount: clamp(e.target.value) })}
              className="w-24"
            />
          </DisabledFieldTooltip>
          <p className="text-xs text-muted-foreground">
            Cells need this many distinct validators to count as fully validated.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="validation-count-audio">Required validators (audio)</FieldLabel>
          <DisabledFieldTooltip
            disabled={disabled || !hasAnyAudioData}
            tooltip={disabled ? (disabledTooltip ?? null) : null}
          >
            <Input
              id="validation-count-audio"
              type="number"
              min={1}
              max={15}
              disabled={disabled || !hasAnyAudioData}
              value={validationCountAudio}
              onChange={(e) => onChange({ validationCountAudio: clamp(e.target.value) })}
              className="w-24"
            />
          </DisabledFieldTooltip>
          <p className="text-xs text-muted-foreground">
            {hasAnyAudioData
              ? "Applies to audio translations."
              : "Enabled once audio translations exist."}
          </p>
        </div>

        {/* ── Role floor ── */}
        <div className="flex flex-col gap-2">
          <FieldLabel htmlFor="validation-role-floor">Minimum validator role</FieldLabel>
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Select
              items={ROLE_OPTIONS}
              disabled={disabled}
              value={validationRoleFloor}
              onValueChange={(v) =>
                onChange({
                  validationRoleFloor: (v ?? validationRoleFloor) as ValidationRoleFloor,
                })
              }
            >
              <SelectTrigger id="validation-role-floor" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {ROLE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </DisabledFieldTooltip>
          <p className="text-xs text-muted-foreground">
            Only users with at least this role can cast a validation vote. Defaults to reviewer.
            {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch */}
          </p>
        </div>

        {/* ── Allow self-validation ── */}
        <div className="flex items-center gap-3">
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <Switch
              id="allow-self-validation"
              disabled={disabled}
              checked={allowSelfValidation}
              onCheckedChange={(checked) => onChange({ allowSelfValidation: checked })}
            />
          </DisabledFieldTooltip>
          <div className="flex flex-col gap-0.5">
            <FieldLabel htmlFor="allow-self-validation">Allow self-validation</FieldLabel>
            <p className="text-xs text-muted-foreground">
              When off, a contributor&apos;s vote on their own commit is ignored.
              {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch */}
            </p>
          </div>
        </div>

        {/* ── Named-user allowlist ── */}
        <Field data-disabled={disabled || undefined}>
          <FieldLabel htmlFor="validation-named-users">Named validators (optional)</FieldLabel>
          <DisabledFieldTooltip disabled={disabled} tooltip={disabledTooltip ?? null}>
            <NamedValidatorsCombobox
              items={namedUserItems}
              value={validationNamedUsers}
              disabled={disabled}
              onValueChange={(next) => onChange({ validationNamedUsers: next })}
            />
          </DisabledFieldTooltip>
          <FieldDescription>
            When set, only these users&apos; votes count toward the threshold (AND&apos;d with
            the role floor). Leave empty to allow any sufficiently-privileged user.
            {/* SWARM-TODO(server-enforcement): enforce in sync-worker cell.validate branch. */}
          </FieldDescription>
        </Field>
      </CardContent>
    </Card>
  )
}
