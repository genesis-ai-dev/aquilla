import { useState } from "react"
import { useLocation, useNavigate } from "react-router-dom"
import { Check, ChevronsUpDown } from "lucide-react"
import { useActiveOrg, type GuestOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { createOrg, renameOrg } from "@/lib/frontier/orgs"
import { fetchAccessibleProjects } from "@/lib/sync/cloud-projects"
import { isOrgScopedRoute } from "./org-route-scope"
import posthog from "@/lib/posthog"
import { ORG_CREATED } from "@/lib/event-names"

export function OrgSwitcher() {
  const { orgs, activeOrg, activeOrgId, isAllOrgs, guestOrgs, setActiveOrg, setAllOrgs, refresh } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const location = useLocation()
  const navigate = useNavigate()

  const [open, setOpen] = useState(false)

  // Create-org form state
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState("")
  const [creating, setCreating] = useState(false)

  // Rename-org form state
  const [showRename, setShowRename] = useState(false)
  const [renameName, setRenameName] = useState("")
  const [renaming, setRenaming] = useState(false)

  // FRO-473: a project-only invitee has zero member orgs but may still have
  // guest orgs to switch into — don't hide the whole switcher for them.
  if (!activeOrg && !isAllOrgs && guestOrgs.length === 0) return null

  const showAllOrgs = orgs.length > 1
  const canRename = !isAllOrgs && (activeOrg?.role.level ?? 0) >= 600
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

  // FRO-473: guest orgs are not activatable (no org membership, so
  // setActiveOrg/org:active would misrepresent the user's role) — clicking
  // one just navigates. Single accessible project in that org → straight to
  // it; multiple → the all-orgs overview, which surfaces "Shared with you".
  async function handleGuestOrg(org: GuestOrg) {
    setOpen(false)
    if (jwt) {
      const projects = await fetchAccessibleProjects(jwt, org.id)
      if (projects.length === 1) {
        navigate(`/projects/${projects[0].id}`)
        return
      }
    }
    navigate({ pathname: "/", search: "?org=all" })
  }

  async function handleCreate() {
    if (!jwt || !createName.trim()) return
    setCreating(true)
    try {
      const o = await createOrg(jwt, createName.trim())
      // High-value funnel signal: a non-personal org means an incoming
      // multi-person project. Consent-gated at the posthog module level.
      posthog.capture(ORG_CREATED, { org_id: o.id })
      await refresh()
      setActiveOrg(o.id)
      setOpen(false)
      setShowCreate(false)
      setCreateName("")
    } finally {
      setCreating(false)
    }
  }

  async function handleRename() {
    if (!jwt || !renameName.trim() || !activeOrg) return
    setRenaming(true)
    try {
      await renameOrg(jwt, activeOrg.id, renameName.trim())
      await refresh()
      setShowRename(false)
    } finally {
      setRenaming(false)
    }
  }

  function handleOpenOrgSwitcher() {
    setOpen((o) => !o)
    if (!open) {
      setShowCreate(false)
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => handleOpenOrgSwitcher()}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{subtitle}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md">
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

          {guestOrgs.length > 0 && (
            <ul className="max-h-60 overflow-y-auto border-t" data-testid="guest-orgs">
              {guestOrgs.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    onClick={() => void handleGuestOrg(g)}
                    className="flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{g.name ?? `Org #${g.id}`}</span>
                      <span className="block text-xs text-muted-foreground">Guest</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {canRename && (
            <div className="border-t px-2 py-1.5">
              {showRename ? (
                <div className="flex gap-1">
                  <input
                    className="flex-1 rounded border px-1.5 py-0.5 text-xs"
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    placeholder="New name"
                    aria-label="Rename org"
                    autoFocus
                  />
                  <button
                    type="button"
                    disabled={renaming}
                    onClick={handleRename}
                    className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-50"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { setRenameName(activeOrg?.name ?? ""); setShowRename(true) }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Rename
                </button>
              )}
            </div>
          )}

          <div className="border-t px-2 py-1.5">
            {showCreate ? (
              <div className="flex flex-col gap-1">
                <input
                  className="flex-1 rounded border px-1.5 py-0.5 text-xs"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="Org name"
                  aria-label="New org name"
                  autoFocus
                />
                <button
                  type="button"
                  disabled={creating}
                  onClick={handleCreate}
                  className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-50"
                >
                  Create
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowCreate(true)}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                + Create org
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
