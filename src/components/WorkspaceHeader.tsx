import type { ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { X } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"

interface Props {
  project: ProjectRecord
  onBack: () => void
  children?: ReactNode
  extraMenuItems?: OverflowMenuItem[]
  /**
   * FRO-428: When provided, the project name in the breadcrumb becomes a
   * clickable link to the project overview page (`/projects/:id`), giving
   * project-only invitees (and all users) a direct path back to the overview
   * without having to navigate through the full dashboard.
   */
  overviewHref?: string
}

export function WorkspaceHeader({ project, onBack, children, extraMenuItems, overviewHref }: Props) {
  const navigate = useNavigate()
  const items: OverflowMenuItem[] = [
    ...(extraMenuItems ?? []),
    { id: "sep-close", type: "separator" },
    { id: "close", label: "Close project", icon: X, onClick: onBack },
  ]
  return (
    <header className="relative z-30 flex items-center gap-3 px-4 py-2">
      <nav className="flex items-center gap-1.5 text-sm min-w-0">
        <button
          className="rounded-full px-2.5 py-1 text-muted-foreground transition-all hover:bg-card hover:text-foreground hover:shadow-neu-xs truncate"
          onClick={onBack}
        >
          Dashboard
        </button>
        <span className="text-muted-foreground/60">/</span>
        {overviewHref ? (
          <button
            className="rounded-full px-2.5 py-1 font-medium truncate hover:bg-card hover:shadow-neu-xs transition-all"
            onClick={() => navigate(overviewHref)}
            aria-label={`Open project overview for ${project.name}`}
          >
            {project.name}
          </button>
        ) : (
          <span className="rounded-full px-2.5 py-1 font-medium truncate">{project.name}</span>
        )}
      </nav>
      <div className="flex-1" />
      <div className="flex items-center gap-1 shrink-0">
        {children}
        <OverflowMenu items={items} />
      </div>
    </header>
  )
}
