import { useState } from "react"
import { ChevronsUpDown } from "lucide-react"
import { useActiveOrg } from "@/context/OrgContext"

export function OrgSwitcher() {
  const { orgs, activeOrg, setActiveOrg } = useActiveOrg()
  const [open, setOpen] = useState(false)
  if (!activeOrg) return null
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
        <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border bg-popover shadow-md">
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
          <li className="border-t">
            <span className="block px-2 py-1.5 text-xs text-muted-foreground">Create org — coming soon</span>
          </li>
        </ul>
      )}
    </div>
  )
}
