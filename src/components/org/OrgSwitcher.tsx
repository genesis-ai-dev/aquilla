import { useEffect, useMemo, useRef, useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Building2, Check, ChevronDown, Plus, SearchIcon, X } from "lucide-react"
import { useActiveOrg, type GuestOrg } from "@/context/OrgContext"
import { isOrgScopedRoute } from "./org-route-scope"
import { OrgCreateDialog } from "./OrgCreateDialog"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { RoleLabel } from "@/components/RoleLabel"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import {
  ALL_ORGS_PARAM,
  orgHomePath,
  swapOrgInPath,
} from "@/lib/navigation/org-paths"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"

const ORG_MENU_ITEM_CLASS =
  // hover: only — Base UI highlight-on-hover would steal focus from the search input.
  "grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-0 gap-x-2 px-2 py-1.5 hover:bg-accent"

/** Muted meta (role / "All projects") — `!` beats menu `focus:**:text-accent-foreground`. */
const ORG_MENU_META_CLASS = "text-xs text-muted-foreground!"

/** ~10 org rows (py-1.5 + text-sm ≈ 2rem each). */
const ORG_LIST_MAX_HEIGHT_CLASS = "max-h-80"

function orgMatchesSearch(name: string, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (!normalized) return true
  return name.toLocaleLowerCase().includes(normalized)
}

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
        <Plus className="size-3 text-muted-foreground!" aria-hidden />
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
        menuSafeColor="#000"
        fallbackClassName="bg-primary"
      >
        {/* color on the SVG itself — menu `focus:**:text-accent-foreground` paints
            descendants light on press; parent color alone cannot beat that. */}
        <Building2 className="size-3 text-black!" color="#000" aria-hidden />
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
  const [search, setSearch] = useState("")
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // AQU-759: keep both member and guest lists alphabetical regardless of the
  // order the backend returned them in (Joel: "Keep it alphabetical").
  const sortedOrgs = useMemo(() => [...orgs].sort(byName), [orgs])
  const sortedGuestOrgs = useMemo(() => [...guestOrgs].sort(byName), [guestOrgs])

  useEffect(() => {
    if (!open) return
    // Keep typing in the filter; menu open otherwise focuses the first item.
    queueMicrotask(() => searchInputRef.current?.focus())
  }, [open])

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
  const title = guestSelected
    ? selectedGuest.name ?? `Org #${selectedGuest.id}`
    : isAllOrgs
      ? "All organizations"
      : activeOrg?.name ?? "Workspace"

  const filteredOrgs = useMemo(
    () => sortedOrgs.filter((o) => orgMatchesSearch(o.name ?? "Workspace", search)),
    [sortedOrgs, search],
  )
  const filteredGuestOrgs = useMemo(
    () => sortedGuestOrgs.filter((g) => orgMatchesSearch(g.name ?? `Org #${g.id}`, search)),
    [sortedGuestOrgs, search],
  )
  const showAllOrgsRow = showAllOrgs && search.trim() === ""
  const listEmpty =
    !showAllOrgsRow && filteredOrgs.length === 0 && filteredGuestOrgs.length === 0

  // AQU-473: a project-only invitee has zero member orgs but may still have
  // guest orgs to switch into — don't hide the whole switcher for them.
  if (!activeOrg && !isAllOrgs && guestOrgs.length === 0) return null

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) setSearch("")
  }

  function handleAllOrgs() {
    setAllOrgs()
    setOpen(false)
    navigate(swapOrgInPath(location.pathname, ALL_ORGS_PARAM))
  }

  function handleActiveOrg(orgId: number) {
    setActiveOrg(orgId)
    setOpen(false)
    // `|| guestSelected`: returning to a member org from a guest's scoped
    // shared view (`/shared?org=<id>`) must navigate to that org's overview,
    // symmetric with picking a guest org (AQU-624). swapOrgInPath falls back
    // to the org home when the current path isn't org-scoped (e.g. /shared).
    if (isOrgScopedRoute(location.pathname) || location.pathname === "/" || guestSelected) {
      navigate(swapOrgInPath(location.pathname, orgId))
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
      navigate(swapOrgInPath(location.pathname, orgId))
    } else {
      navigate(orgHomePath(orgId))
    }
  }

  function openCreateDialog() {
    setOpen(false)
    setCreateDialogOpen(true)
  }

  return (
    <>
      <DropdownMenu open={open} onOpenChange={handleOpenChange} highlightItemOnHover={false}>
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
          <span className="truncate">{title}</span>
          <ChevronDown className="ml-auto size-4 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-72 overflow-hidden rounded-lg p-0 flex flex-col"
          align="start"
          side="bottom"
          sideOffset={4}
        >
          {/* Icon column matches list rows: p-1 + px-2 inset, then 1.25rem avatar slot. */}
          <InputGroup className="h-10 w-auto rounded-none border-0 bg-transparent shadow-none outline-none dark:bg-transparent ring-0 hover:border-0! focus-within:border-0! has-[[data-slot=input-group-control]:focus-visible]:border-0! has-[[data-slot=input-group-control]:focus-visible]:ring-0!">
            <InputGroupAddon
              align="inline-start"
              className="ml-3 w-5 justify-center p-0!"
            >
              <SearchIcon className="size-4 text-muted-foreground" />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchInputRef}
              placeholder="Find an organization…"
              aria-label="Find an organization"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  handleOpenChange(false)
                  return
                }
                e.stopPropagation()
              }}
              onClick={(e) => e.stopPropagation()}
            />
            {search ? (
              <InputGroupAddon
                align="inline-end"
                // Match Create row inset (list `p-1` + item `px-2`); kill addon’s
                // default `has-[>button]:mr-[-0.3rem]` that pulls the X flush.
                className="p-0! pr-2! has-[>button]:mr-0!"
              >
                <InputGroupButton
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Clear search"
                  onClick={(e) => {
                    e.stopPropagation()
                    setSearch("")
                    searchInputRef.current?.focus()
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <X />
                </InputGroupButton>
              </InputGroupAddon>
            ) : null}
          </InputGroup>
          <DropdownMenuSeparator className="mx-0 my-0" />
          <div
            role="presentation"
            className={`${ORG_LIST_MAX_HEIGHT_CLASS} overflow-y-auto overscroll-contain p-1 scrollbar-thin flex-1 flex flex-col`}
          >
            {listEmpty ? (
              <Empty className="min-h-32 border-0 p-4 gap-2">
                <EmptyHeader>
                  <EmptyMedia
                    variant="icon"
                    className="mb-0 border border-border bg-transparent text-muted-foreground"
                  >
                    <SearchIcon />
                  </EmptyMedia>
                  <EmptyTitle className="text-muted-foreground font-normal">
                    No organizations found.
                  </EmptyTitle>
                </EmptyHeader>
              </Empty>
            ) : (
              <>
                <DropdownMenuGroup>
                  {showAllOrgsRow && (
                    <DropdownMenuItem
                      className={`${ORG_MENU_ITEM_CLASS} focus:[&_[data-slot=avatar]_svg]:text-black! data-highlighted:[&_[data-slot=avatar]_svg]:text-black!`}
                      onClick={handleAllOrgs}
                    >
                      <OrgMark name="All organizations" allOrgs />
                      <span className="truncate">All organizations</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className={ORG_MENU_META_CLASS}>All projects</span>
                        {!guestSelected && isAllOrgs && <Check className="size-4 opacity-60" />}
                      </span>
                    </DropdownMenuItem>
                  )}
                  {filteredOrgs.map((o) => {
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
                          <RoleLabel name={o.role.name} className={ORG_MENU_META_CLASS} />
                          {selected && <Check className="size-4 opacity-60" />}
                        </span>
                      </DropdownMenuItem>
                    )
                  })}
                </DropdownMenuGroup>
                {filteredGuestOrgs.length > 0 && (
                  <>
                    <DropdownMenuSeparator className="mx-0 my-1" />
                    <DropdownMenuGroup data-testid="guest-orgs">
                      {filteredGuestOrgs.map((g) => (
                        <DropdownMenuItem
                          key={g.id}
                          className={ORG_MENU_ITEM_CLASS}
                          onClick={() => handleGuestOrg(g)}
                        >
                          <OrgMark name={g.name ?? `Org #${g.id}`} />
                          <span className="truncate">{g.name ?? `Org #${g.id}`}</span>
                          <span className="flex shrink-0 items-center gap-1.5">
                            <RoleLabel name="guest" className={ORG_MENU_META_CLASS} />
                            {selectedGuestOrgId === g.id && <Check className="size-4 opacity-60" />}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </>
                )}
              </>
            )}
          </div>
          <DropdownMenuSeparator className="mx-0 my-0" />
          <div role="presentation" className="p-1">
            <DropdownMenuItem className={ORG_MENU_ITEM_CLASS} onClick={openCreateDialog}>
              <OrgMark name="Create" create />
              <span className="truncate text-muted-foreground!">Create</span>
              <span aria-hidden />
            </DropdownMenuItem>
          </div>
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
