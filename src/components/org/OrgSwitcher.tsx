import { useState } from "react"
import { ChevronsUpDown } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { createOrg, renameOrg } from "@/lib/frontier/orgs"

export function OrgSwitcher() {
  const { orgs, activeOrg, setActiveOrg, refresh } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const [open, setOpen] = useState(false)

  // Create-org form state
  const [showCreate, setShowCreate] = useState(false)
  const [createName, setCreateName] = useState("")
  const [creating, setCreating] = useState(false)

  // Rename-org form state
  const [showRename, setShowRename] = useState(false)
  const [renameName, setRenameName] = useState("")
  const [renaming, setRenaming] = useState(false)

  if (!activeOrg) return null

  const canRename = (activeOrg.role.level ?? 0) >= 600

  async function handleCreate() {
    if (!jwt || !createName.trim()) return
    setCreating(true)
    try {
      const o = await createOrg(jwt, createName.trim())
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

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{activeOrg.name ?? "Workspace"}</span>
          <span className="block text-xs text-muted-foreground">{activeOrg.role.name}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 w-full rounded-md border bg-popover shadow-md">
          <ul className="max-h-60 overflow-y-auto">
          {orgs.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => { setActiveOrg(o.id); setOpen(false) }}
                className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-accent"
              >
                <span className="truncate">{o.name ?? "Workspace"}</span>
                <span className="text-xs text-muted-foreground">{o.role.name}</span>
              </button>
            </li>
          ))}
          </ul>

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
                  onClick={() => { setRenameName(activeOrg.name ?? ""); setShowRename(true) }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Rename
                </button>
              )}
            </div>
          )}

          <div className="border-t px-2 py-1.5">
            {showCreate ? (
              <div className="flex gap-1">
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
