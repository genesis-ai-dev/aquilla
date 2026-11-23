/**
 * AQU-2320: the three blanks of "Give [person] the role [role] at [place]".
 * Each is a button that opens a shadcn Command list, so Tab walks the
 * sentence blank by blank and each list is searchable by keyboard.
 */
import { useState, type ReactNode } from "react"
import { ChevronDown, UserPlus } from "lucide-react"

import { PLACE_ICON } from "@/components/access/place-icons"
import { RoleBadge } from "@/components/access/RoleBadge"
import { ScopeBreadcrumb } from "@/components/access/ScopeBreadcrumb"
import { Badge } from "@/components/ui/badge"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { inviteEmail, placeBlock, type PersonChoice, type PlaceRow } from "@/lib/access/give-access"
import { useT } from "@/lib/i18n/I18nProvider"
import { cn } from "@/lib/utils"

import type { OrgAccessPerson } from "./org-access-data"

function Blank({
  label,
  filled,
  children,
  list,
  testId,
}: {
  label: string
  filled: boolean
  children: ReactNode
  list: (close: () => void) => ReactNode
  testId: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        data-testid={testId}
        className={cn(
          "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border px-2 py-1 text-sm",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          filled ? "border-border bg-card" : "border-dashed text-muted-foreground",
        )}
      >
        <span className="min-w-0 truncate">{children}</span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)] p-0">
        {open && list(() => setOpen(false))}
      </PopoverContent>
    </Popover>
  )
}

export function PersonBlank({
  people,
  value,
  onChange,
}: {
  people: readonly OrgAccessPerson[]
  value: PersonChoice | null
  onChange: (next: PersonChoice) => void
}) {
  const t = useT()
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const accounts = people.filter((p) => !p.pendingInvite)
  const matches = q
    ? accounts.filter((p) => p.displayName.toLowerCase().includes(q) || p.email?.toLowerCase().includes(q))
    : accounts
  const email = inviteEmail(query)
  // An address that is already someone's is that person, not an invite.
  const offerInvite = email != null && !accounts.some((p) => p.email?.toLowerCase() === email)
  const shown = value?.kind === "invite" ? value.email : value?.displayName
  return (
    <Blank label={t("org.access.give.personLabel")} filled={value != null} testId="give-person" list={(close) => (
      <Command shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery} placeholder={t("org.access.give.personSearch")} aria-label={t("org.access.give.personSearch")} />
        <CommandList>
          {matches.length === 0 && !offerInvite && <CommandEmpty>{t("org.access.give.noPeople")}</CommandEmpty>}
          {offerInvite && (
            <CommandItem value={`invite:${email}`} onSelect={() => { onChange({ kind: "invite", email }); close() }}>
              <UserPlus aria-hidden />
              {t("org.access.give.inviteEmail", { email })}
            </CommandItem>
          )}
          {matches.map((p) => (
            <CommandItem
              key={p.userId}
              value={`person:${p.userId}`}
              onSelect={() => {
                onChange({ kind: "account", userId: p.userId, displayName: p.displayName, email: p.email ?? null, isGuest: p.isGuest })
                close()
              }}
            >
              <span className="min-w-0 flex-1 truncate">{p.displayName}</span>
              {p.email && p.email !== p.displayName && <span className="truncate text-xs text-muted-foreground">{p.email}</span>}
              {p.isGuest && <Badge variant="outline">{t("org.access.inspector.guest")}</Badge>}
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    )}>
      {shown ?? t("org.access.give.personBlank")}
    </Blank>
  )
}

export function RoleBlank({
  options,
  value,
  onChange,
}: {
  options: readonly number[]
  value: number | null
  onChange: (next: number) => void
}) {
  const t = useT()
  return (
    <Blank label={t("org.access.give.roleLabel")} filled={value != null} testId="give-role" list={(close) => (
      <Command>
        <CommandList>
          {options.length === 0 && <CommandEmpty>{t("org.access.give.noRoles")}</CommandEmpty>}
          {options.map((level) => (
            <CommandItem key={level} value={`role:${level}`} data-role-level={level} onSelect={() => { onChange(level); close() }}>
              <RoleBadge roleLevel={level} origin={{ kind: "direct" }} />
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    )}>
      {value == null ? t("org.access.give.roleBlank") : <RoleBadge roleLevel={value} origin={{ kind: "direct" }} />}
    </Blank>
  )
}

export function PlaceBlank({
  rows,
  value,
  person,
  personPlaceKeys,
  onChange,
}: {
  rows: readonly PlaceRow[]
  value: PlaceRow | null
  person: PersonChoice | null
  /** Places the chosen person already holds a grant at: the quick way to a narrower place. */
  personPlaceKeys: ReadonlySet<string>
  onChange: (next: PlaceRow) => void
}) {
  const t = useT()
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const matches = q ? rows.filter((r) => r.path.some((s) => s.name.toLowerCase().includes(q))) : rows
  const theirs = person?.kind === "account" ? matches.filter((r) => personPlaceKeys.has(r.key)) : []
  const item = (row: PlaceRow, group: string, indent: boolean, close: () => void) => {
    const block = placeBlock(row, person)
    const Icon = PLACE_ICON[row.scope.type]
    return (
      <CommandItem
        key={`${group}:${row.key}`}
        value={`${group}:${row.key}`}
        disabled={block != null}
        data-testid={`give-place-${group}-${row.key}`}
        onSelect={() => { onChange(row); close() }}
        className="items-start"
      >
        <span className="flex min-w-0 flex-1 flex-col" style={indent ? { paddingInlineStart: `${row.depth * 0.75}rem` } : undefined}>
          <span className="flex min-w-0 items-center gap-1.5">
            <Icon className="size-3.5 text-muted-foreground" aria-hidden data-place-icon={row.scope.type} />
            <span className="truncate">{row.scope.name}</span>
          </span>
          {block && <span className="text-xs text-muted-foreground" data-testid="give-place-reason">{t(`org.access.give.denied.${block}`)}</span>}
        </span>
      </CommandItem>
    )
  }
  return (
    <Blank label={t("org.access.give.placeLabel")} filled={value != null} testId="give-place" list={(close) => (
      <Command shouldFilter={false}>
        <CommandInput value={query} onValueChange={setQuery} placeholder={t("org.access.give.placeSearch")} aria-label={t("org.access.give.placeSearch")} />
        <CommandList>
          {matches.length === 0 && <CommandEmpty>{t("org.access.give.noPlaces")}</CommandEmpty>}
          {theirs.length > 0 && person?.kind === "account" && (
            <CommandGroup heading={t("org.access.give.theirPlaces", { name: person.displayName })}>
              {theirs.map((row) => item(row, "theirs", false, close))}
            </CommandGroup>
          )}
          {matches.length > 0 && (
            <CommandGroup heading={t("org.access.give.allPlaces")}>
              {matches.map((row) => item(row, "all", true, close))}
            </CommandGroup>
          )}
        </CommandList>
      </Command>
    )}>
      {value == null ? t("org.access.give.placeBlank") : <ScopeBreadcrumb path={value.path} icons />}
    </Blank>
  )
}
