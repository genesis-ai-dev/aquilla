import { useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Check, ChevronsUpDown } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"
import { isOrgScopedRoute } from "./org-route-scope"
import { OrgCreateDialog } from "./OrgCreateDialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export function OrgSwitcher() {
  const { orgs, activeOrg, activeOrgId, isAllOrgs, setActiveOrg, setAllOrgs, refresh } = useActiveOrg()
  const location = useLocation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  if (!activeOrg && !isAllOrgs) return null

  const showAllOrgs = orgs.length > 1
  const title = isAllOrgs ? "All organizations" : activeOrg?.name ?? "Workspace"
  const subtitle = isAllOrgs ? `${orgs.length} organizations` : activeOrg?.role.name ?? ""

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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
            />
          }
        >
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{title}</span>
            <span className="block text-xs text-muted-foreground">{subtitle}</span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent side="bottom" align="start" sideOffset={4} className="w-(--anchor-width) p-0">
          <ul className="max-h-60 overflow-y-auto">
            {showAllOrgs && (
              <li>
                <button
                  type="button"
                  onClick={handleAllOrgs}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="min-w-0">
                    <span className="block truncate">All organizations</span>
                    <span className="block text-xs text-muted-foreground">All projects</span>
                  </span>
                  {isAllOrgs && <Check className="size-3.5 shrink-0" aria-hidden />}
                </button>
              </li>
            )}
            {orgs.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => handleActiveOrg(o.id)}
                  className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <span className="min-w-0">
                    <span className="block truncate">{o.name ?? "Workspace"}</span>
                    <span className="block text-xs text-muted-foreground">{o.role.name}</span>
                  </span>
                  {activeOrgId === o.id && <Check className="size-3.5 shrink-0" aria-hidden />}
                </button>
              </li>
            ))}
          </ul>

          <div className="border-t px-2 py-1.5">
            <button
              type="button"
              onClick={openCreateDialog}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              + Create org
            </button>
          </div>
        </PopoverContent>
      </Popover>

      <OrgCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreated={(orgId) => void handleCreated(orgId)}
      />
    </>
  )
}
