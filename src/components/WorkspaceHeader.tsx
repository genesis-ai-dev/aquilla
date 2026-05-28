import type { ReactNode } from "react"
import { X } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"

interface Props {
  project: ProjectRecord
  onBack: () => void
  children?: ReactNode
  extraMenuItems?: OverflowMenuItem[]
}

export function WorkspaceHeader({ project, onBack, children, extraMenuItems }: Props) {
  const items: OverflowMenuItem[] = [
    { id: "close", label: "Close project", icon: X, onClick: onBack },
    ...(extraMenuItems ?? []),
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
        <span className="rounded-full px-2.5 py-1 font-medium truncate">{project.name}</span>
      </nav>
      <div className="flex-1" />
      <div className="flex items-center gap-1 shrink-0">
        {children}
        <OverflowMenu items={items} />
      </div>
    </header>
  )
}
