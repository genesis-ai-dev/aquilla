import type { ReactNode } from "react"
import { X } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"
import { SourceProjectBadge } from "./SourceProjectBadge"

interface Props {
  project: ProjectRecord
  onBack: () => void
  children?: ReactNode
  extraMenuItems?: OverflowMenuItem[]
  /** AD-9 (Phase 5): when this project is a linked-target, the upstream
   *  source project's id and (optional) name. The header renders a small
   *  badge next to the language pair. Null → renders nothing.
   *
   *  Threaded as a prop rather than derived inside the header so the
   *  workspace owner decides when the link state is "ready" (after the
   *  /api/v2/projects fetch settles) and avoids a flash of unstyled
   *  state during initial hydrate. */
  sourceProjectId?: string | null
  sourceProjectName?: string
}

export function WorkspaceHeader({
  project,
  onBack,
  children,
  extraMenuItems,
  sourceProjectId,
  sourceProjectName,
}: Props) {
  const items: OverflowMenuItem[] = [
    { id: "close", label: "Close project", icon: X, onClick: onBack },
    ...(extraMenuItems ?? []),
  ]
  return (
    <header className="flex items-center gap-3 border-b bg-background px-4 py-2">
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
        {(sourceProjectId ?? project.sourceProjectId) && (
          <>
            <span className="text-muted-foreground">·</span>
            <SourceProjectBadge
              sourceProjectId={sourceProjectId ?? project.sourceProjectId ?? null}
              sourceProjectName={sourceProjectName ?? project.sourceProjectName}
            />
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
