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
    <header className="neu-flat relative z-10 flex items-center gap-3 px-4 py-2">
      <nav className="flex items-center gap-1 text-sm min-w-0">
        <button
          className="text-muted-foreground hover:text-foreground truncate"
          onClick={onBack}
        >
          Dashboard
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium truncate">{project.name}</span>
        {(project.sourceLanguage || project.targetLanguage) && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="text-muted-foreground truncate">
              {project.sourceLanguage || "?"} → {project.targetLanguage || "?"}
            </span>
          </>
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
