import { useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Building2, Check, ChevronDown, Plus } from "lucide-react"
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

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen}>
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
          <DropdownMenuGroup>
            {showAllOrgs && (
              <DropdownMenuItem className={ORG_MENU_ITEM_CLASS} onClick={handleAllOrgs}>
                <OrgMark name="All organizations" allOrgs />
                <span className="truncate">All organizations</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">All projects</span>
                  {!guestSelected && isAllOrgs && <Check className="size-4 opacity-60" />}
                </span>
              </DropdownMenuItem>
            )}
            {orgs.map((o) => {
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
          {guestOrgs.length > 0 && (
            <>
              <DropdownMenuSeparator className="mx-0 my-1" />
              <DropdownMenuGroup data-testid="guest-orgs">
                {guestOrgs.map((g) => (
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
