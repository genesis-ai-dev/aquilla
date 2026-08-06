import type { ReactNode } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { OrgBreadcrumb, type OrgBreadcrumbTrailSegment } from "@/components/org/OrgBreadcrumb"
import { cn } from "@/lib/utils"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"
import { WorkspaceHeaderActions } from "./WorkspaceHeaderActions"

interface Props {
  project: ProjectRecord
  children?: ReactNode
  extraMenuItems?: OverflowMenuItem[]
  /** When set, renders Import in a button group beside the ⋯ overflow menu. */
  onImport?: () => void
  /**
   * AQU-428: When provided, the project name in the breadcrumb becomes a
   * clickable link to the project overview page (`/projects/:id`), giving
   * project-only invitees (and all users) a direct path back to the overview
   * without having to navigate through the full dashboard.
   */
  overviewHref?: string
  /** Workspace surface (e.g. "Editor") — shown after the project name. */
  surfaceLabel?: string
  /** Current book/chapter (e.g. "GEN 1") — trailing segment when known. */
  bookLabel?: string | null
  /** Use the inspectable compact location control when toolbar space is valuable. */
  compactBreadcrumb?: boolean
}

export function WorkspaceHeader({
  project,
  children,
  extraMenuItems,
  onImport,
  overviewHref,
  surfaceLabel,
  bookLabel,
  compactBreadcrumb = false,
}: Props) {
  const items = extraMenuItems ?? []
  const trail: OrgBreadcrumbTrailSegment[] = []
  if (surfaceLabel) trail.push({ label: surfaceLabel })
  if (bookLabel) trail.push({ label: bookLabel })
  return (
    <header className="relative z-30 flex h-full min-w-0 items-center gap-2 pr-4">
      <div className={cn("min-w-0", compactBreadcrumb ? "shrink-0" : "flex-1")}>
        <OrgBreadcrumb
          section={project.name}
          sectionTo={overviewHref}
          orgId={project.orgId}
          trail={trail.length > 0 ? trail : undefined}
          compact={compactBreadcrumb}
        />
      </div>
      <div className={cn("flex items-center gap-1", compactBreadcrumb ? "min-w-0 flex-1" : "shrink-0")}>
        {children}
        {onImport ? (
          <WorkspaceHeaderActions onImport={onImport} menuItems={items} />
        ) : items.length > 0 ? (
          <OverflowMenu items={items} />
        ) : null}
      </div>
    </header>
  )
}
