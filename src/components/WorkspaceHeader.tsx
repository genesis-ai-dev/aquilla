import type { ReactNode } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"

interface Props {
  project: ProjectRecord
  onBack: () => void
  children?: ReactNode
}

export function WorkspaceHeader({ project, onBack, children }: Props) {
  return (
    <header className="relative z-30 flex items-center gap-3 border-b bg-background px-4 py-2">
      <nav className="flex items-center gap-1 text-sm min-w-0">
        <button
          className="text-muted-foreground hover:text-foreground truncate"
          onClick={onBack}
        >
          Dashboard
        </button>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium truncate">{project.name}</span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground truncate">
          {project.sourceLanguage} → {project.targetLanguage}
        </span>
      </nav>
      <div className="flex-1" />
      <div className="flex items-center gap-1 shrink-0">
        {children}
      </div>
    </header>
  )
}
