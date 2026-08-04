import { AvatarGroup, AvatarGroupCount } from "@/components/ui/avatar"
import {
  MultiSelectCombobox,
  MultiSelectComboboxContent,
  MultiSelectComboboxEmpty,
  MultiSelectComboboxList,
  MultiSelectComboboxOption,
  MultiSelectComboboxSearch,
  MultiSelectComboboxTrigger,
  MultiSelectComboboxValue,
} from "@/components/ui/multi-select-combobox"
import { InitialsAvatar } from "@/components/InitialsAvatar"

const DEFAULT_AVATAR_CAP = 3

interface MemberMultiSelectProps {
  /** Usernames offered in the popup. */
  members: string[]
  /** Selected usernames. */
  value: string[]
  onValueChange: (next: string[]) => void
  /** Set this to pair the trigger with a FieldLabel `htmlFor`. */
  id?: string
  disabled?: boolean
  placeholder?: string
  searchPlaceholder?: string
  /** Accessible name for the popup search input. */
  searchLabel?: string
  emptyMessage?: string
  /** Trigger avatars shown before the rest collapse into a +N count. */
  avatarCap?: number
  size?: "default" | "sm"
  className?: string
}

/**
 * Multi-select of project members: avatar stack + comma-separated names in the
 * trigger, checkbox + avatar + username rows in the popup. Selection chrome and
 * the keyboard contract come from MultiSelectCombobox.
 */
export function MemberMultiSelect({
  members,
  value,
  onValueChange,
  id,
  disabled = false,
  placeholder = "Select members…",
  searchPlaceholder = "Search members…",
  searchLabel = "Search members",
  emptyMessage = "No members found.",
  avatarCap = DEFAULT_AVATAR_CAP,
  size,
  className,
}: MemberMultiSelectProps) {
  return (
    <MultiSelectCombobox
      items={members}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
    >
      <MultiSelectComboboxTrigger id={id} size={size} className={className}>
        <MultiSelectComboboxValue placeholder={placeholder}>
          {(names) => {
            const shown = names.slice(0, avatarCap)
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
        </MultiSelectComboboxValue>
      </MultiSelectComboboxTrigger>

      <MultiSelectComboboxContent>
        <MultiSelectComboboxSearch
          placeholder={searchPlaceholder}
          aria-label={searchLabel}
        />
        <MultiSelectComboboxEmpty>{emptyMessage}</MultiSelectComboboxEmpty>
        <MultiSelectComboboxList>
          {(username: string) => (
            <MultiSelectComboboxOption key={username} value={username}>
              {/* Match MembersSection / MembershipAvatars: square InitialsAvatar. */}
              <span aria-hidden className="shrink-0">
                <InitialsAvatar name={username} size="sm" singleInitial menuSafe />
              </span>
              <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                {username}
              </span>
            </MultiSelectComboboxOption>
          )}
        </MultiSelectComboboxList>
      </MultiSelectComboboxContent>
    </MultiSelectCombobox>
  )
}
