import { useMemo, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Building2, Check, ChevronDown, Plus, Search } from "lucide-react"
import { useActiveOrg, type GuestOrg } from "@/context/OrgContext"
import { isOrgScopedRoute } from "./org-route-scope"
import { OrgCreateDialog } from "./OrgCreateDialog"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { RoleLabel } from "@/components/RoleLabel"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

const ORG_MENU_ITEM_CLASS =
  "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-0 gap-x-2 px-2 py-1.5"

// AQU-759: below this many switchable orgs (members + guests) a search box is
// clutter; at or above it the list is long enough that type-to-filter helps.
const ORG_SEARCH_MIN = 6

function byName(a: { name: string | null }, b: { name: string | null }) {
  return (a.name ?? "").localeCompare(b.name ?? "")
}

function OrgMark({
  name,
  allOrgs = false,
  create = false,
}: {
  name: string
  allOrgs?: boolean
  create?: boolean
}) {
  if (create) {
    return (
      <InitialsAvatar
        name={name}
        size="xs"
        shape="square"
        menuSafe
        menuSafeColor="var(--muted-foreground)"
        fallbackClassName="bg-muted"
      >
        <Plus className="size-3" />
      </InitialsAvatar>
    )
  }
  if (allOrgs) {
    return (
      <InitialsAvatar
        name={name}
        size="xs"
        shape="square"
        menuSafe
        menuSafeColor="var(--primary-foreground)"
        fallbackClassName="bg-primary"
      >
        <Building2 className="size-3" />
      </InitialsAvatar>
    )
  }
  return (
    <InitialsAvatar name={name} size="xs" shape="square" menuSafe />
  )
}

export function OrgSwitcher() {
  const { orgs, activeOrg, activeOrgId, isAllOrgs, guestOrgs, setActiveOrg, setAllOrgs, refresh } = useActiveOrg()
  const location = useLocation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [query, setQuery] = useState("")

  // AQU-759: keep both member and guest lists alphabetical regardless of the
  // order the backend returned them in (Joel: "Keep it alphabetical").
  const sortedOrgs = useMemo(() => [...orgs].sort(byName), [orgs])
  const sortedGuestOrgs = useMemo(() => [...guestOrgs].sort(byName), [guestOrgs])

  // AQU-759: a search box for long org lists. Filter member + guest orgs by a
  // case-insensitive substring of their display name; "All organizations" is
  // itself matchable so it disappears once the query no longer matches it.
  const q = query.trim().toLowerCase()
  const nameMatches = (name: string) => q === "" || name.toLowerCase().includes(q)
  const visibleOrgs = sortedOrgs.filter((o) => nameMatches(o.name ?? "Workspace"))
  const visibleGuestOrgs = sortedGuestOrgs.filter((g) => nameMatches(g.name ?? `Org #${g.id}`))
  const showSearch = orgs.length + guestOrgs.length >= ORG_SEARCH_MIN

  // AQU-473: a project-only invitee has zero member orgs but may still have
  // guest orgs to switch into — don't hide the whole switcher for them.
  if (!activeOrg && !isAllOrgs && guestOrgs.length === 0) return null

  // AQU-624: a guest org isn't a membership, so it can't become the `activeOrg`
  // without misrepresenting the caller's role (AQU-473). Instead we treat the
  // scoped shared-projects route (`/shared?org=<id>`) as the guest org's
  // "selected" state: derive it from the URL so it survives reload/back-forward
  // and drives the checkmark + trigger label below.
  const guestScopeParam =
    location.pathname === "/shared"
      ? new URLSearchParams(location.search).get("org")
      : null
  const selectedGuestOrgId =
    guestScopeParam != null && Number.isFinite(Number(guestScopeParam))
      ? Number(guestScopeParam)
      : null
  const selectedGuest = guestOrgs.find((g) => g.id === selectedGuestOrgId) ?? null
  const guestSelected = selectedGuest != null

  const showAllOrgs = orgs.length > 1
  // AQU-759: the "All organizations" row is filtered by the search too.
  const showAllOrgsRow = showAllOrgs && nameMatches("All organizations")
  const noMatches =
    !showAllOrgsRow && visibleOrgs.length === 0 && visibleGuestOrgs.length === 0
  const title = guestSelected
    ? selectedGuest.name ?? `Org #${selectedGuest.id}`
    : isAllOrgs
      ? "All organizations"
      : activeOrg?.name ?? "Workspace"

  function handleAllOrgs() {
    setAllOrgs()
    setOpen(false)
    navigate({ pathname: "/", search: "?org=all" })
  }

  function handleActiveOrg(orgId: number) {
    setActiveOrg(orgId)
    setOpen(false)
    // `|| guestSelected`: returning to a member org from a guest's scoped
    // shared view (`/shared?org=<id>`) must navigate to that org's overview,
    // symmetric with picking a guest org (AQU-624).
    if (isOrgScopedRoute(location.pathname) || location.pathname === "/" || guestSelected) {
      navigate({ pathname: "/", search: `?org=${orgId}` })
    }
  }

  // AQU-473/AQU-624: guest orgs are not activatable (no org membership, so
  // setActiveOrg/org:active would misrepresent the caller's role) — clicking
  // one navigates to that org's scoped shared-projects overview
  // (`/shared?org=<id>`), which also drives the switcher's selected state.
  function handleGuestOrg(org: GuestOrg) {
    setOpen(false)
    navigate({ pathname: "/shared", search: `?org=${org.id}` })
  }

  async function handleCreated(orgId: number) {
    await refresh()
    setActiveOrg(orgId)
    if (isOrgScopedRoute(location.pathname) || location.pathname === "/") {
      navigate({ pathname: "/", search: `?org=${orgId}` })
    }
  }

  function openCreateDialog() {
    setOpen(false)
    setCreateDialogOpen(true)
  }

  // AQU-759: clear the filter whenever the menu closes so it reopens showing
  // the full list rather than a stale query.
  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) setQuery("")
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Organization switcher: ${title}`}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent"
            />
          }
        >
          <OrgMark name={title} allOrgs={!guestSelected && isAllOrgs} />
          <span className="truncate font-medium">{title}</span>
          <ChevronDown className="ml-auto size-4 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72 rounded-lg" align="start" side="bottom" sideOffset={4}>
          {showSearch && (
            <div className="px-1 pt-1 pb-0.5">
              <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  // Keep printable keystrokes in the field: base-ui's menu
                  // typeahead would otherwise swallow them to move the highlight.
                  onKeyDown={(e) => {
                    if (e.key !== "Escape" && e.key !== "ArrowDown" && e.key !== "ArrowUp") {
                      e.stopPropagation()
                    }
                  }}
                  aria-label="Search organizations"
                  placeholder="Search organizations…"
                  autoFocus
                  className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>
            </div>
          )}
          {/* AQU-141: cap the list height so long org lists stay scrollable while
              the search box and Create action remain pinned in view. */}
          <div className="max-h-72 overflow-x-hidden overflow-y-auto">
            <DropdownMenuGroup>
              {showAllOrgsRow && (
                <DropdownMenuItem className={ORG_MENU_ITEM_CLASS} onClick={handleAllOrgs}>
                  <OrgMark name="All organizations" allOrgs />
                  <span className="truncate">All organizations</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">All projects</span>
                    {!guestSelected && isAllOrgs && <Check className="size-4 opacity-60" />}
                  </span>
                </DropdownMenuItem>
              )}
              {visibleOrgs.map((o) => {
                const name = o.name ?? "Workspace"
                const selected = !guestSelected && activeOrgId === o.id
                return (
                  <DropdownMenuItem
                    key={o.id}
                    className={ORG_MENU_ITEM_CLASS}
                    onClick={() => handleActiveOrg(o.id)}
                  >
                    <OrgMark name={name} />
                    <span className="truncate">{name}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      <RoleLabel name={o.role.name} className="text-xs text-muted-foreground" />
                      {selected && <Check className="size-4 opacity-60" />}
                    </span>
                  </DropdownMenuItem>
                )
              })}
            </DropdownMenuGroup>
            {visibleGuestOrgs.length > 0 && (
              <>
                <DropdownMenuSeparator className="mx-0 my-1" />
                <DropdownMenuGroup data-testid="guest-orgs">
                  {visibleGuestOrgs.map((g) => (
                    <DropdownMenuItem
                      key={g.id}
                      className={ORG_MENU_ITEM_CLASS}
                      onClick={() => handleGuestOrg(g)}
                    >
                      <OrgMark name={g.name ?? `Org #${g.id}`} />
                      <span className="truncate">{g.name ?? `Org #${g.id}`}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <RoleLabel name="guest" className="text-xs text-muted-foreground" />
                        {selectedGuestOrgId === g.id && <Check className="size-4 opacity-60" />}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </>
            )}
            {noMatches && (
              <div className="px-2 py-1.5 text-sm text-muted-foreground">
                No organizations found
              </div>
            )}
          </div>
          <DropdownMenuSeparator className="mx-0 my-1" />
          <DropdownMenuItem className={ORG_MENU_ITEM_CLASS} onClick={openCreateDialog}>
            <OrgMark name="Create" create />
            <span className="truncate text-muted-foreground">Create</span>
            <span aria-hidden />
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <OrgCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={(orgId) => void handleCreated(orgId)}
      />
    </>
  )
}
