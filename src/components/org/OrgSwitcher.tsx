import { useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Building2, Check, ChevronDown, Plus } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"
import { isOrgScopedRoute } from "./org-route-scope"
import { OrgCreateDialog } from "./OrgCreateDialog"
import { InitialsAvatar } from "@/components/InitialsAvatar"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

function OrgMark({ name, allOrgs = false }: { name: string; allOrgs?: boolean }) {
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
  const { orgs, activeOrg, activeOrgId, isAllOrgs, setActiveOrg, setAllOrgs, refresh } = useActiveOrg()
  const location = useLocation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  if (!activeOrg && !isAllOrgs) return null

  const showAllOrgs = orgs.length > 1
  const title = isAllOrgs ? "All organizations" : activeOrg?.name ?? "Workspace"

  function handleAllOrgs() {
    setAllOrgs()
    setOpen(false)
    navigate({ pathname: "/", search: "?org=all" })
  }

  function handleActiveOrg(orgId: number) {
    setActiveOrg(orgId)
    setOpen(false)
    if (isOrgScopedRoute(location.pathname) || location.pathname === "/") {
      navigate({ pathname: "/", search: `?org=${orgId}` })
    }
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
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent"
            />
          }
        >
          <OrgMark name={title} allOrgs={isAllOrgs} />
          <span className="truncate font-medium">{title}</span>
          <ChevronDown className="ml-auto size-4 opacity-50" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64 rounded-lg" align="start" side="bottom" sideOffset={4}>
          <DropdownMenuGroup>
            {showAllOrgs && (
              <DropdownMenuItem className="gap-2 p-2" onClick={handleAllOrgs}>
                <OrgMark name="All organizations" allOrgs />
                <span className="truncate">All organizations</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">All projects</span>
                  {isAllOrgs && <Check className="size-4 opacity-60" />}
                </span>
              </DropdownMenuItem>
            )}
            {orgs.map((o) => {
              const name = o.name ?? "Workspace"
              const selected = activeOrgId === o.id
              return (
                <DropdownMenuItem
                  key={o.id}
                  className="gap-2 p-2"
                  onClick={() => handleActiveOrg(o.id)}
                >
                  <OrgMark name={name} />
                  <span className="truncate">{name}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{o.role.name}</span>
                    {selected && <Check className="size-4 opacity-60" />}
                  </span>
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2 p-2" onClick={openCreateDialog}>
            <Avatar className="size-5 rounded-md after:rounded-md">
              <AvatarFallback
                className="rounded-md border bg-background"
                style={{ color: "var(--muted-foreground)" }}
              >
                <Plus className="size-3" />
              </AvatarFallback>
            </Avatar>
            <span className="font-medium text-muted-foreground">Create</span>
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
