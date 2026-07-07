import type { ReactNode } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { OrgBreadcrumb, type OrgBreadcrumbTrailSegment } from "@/components/org/OrgBreadcrumb"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"

interface Props {
  project: ProjectRecord
  children?: ReactNode
  extraMenuItems?: OverflowMenuItem[]
  /**
   * FRO-428: When provided, the project name in the breadcrumb becomes a
   * clickable link to the project overview page (`/projects/:id`), giving
   * project-only invitees (and all users) a direct path back to the overview
   * without having to navigate through the full dashboard.
   */
  overviewHref?: string
  /** Workspace surface (e.g. "Editor") — shown after the project name. */
  surfaceLabel?: string
  /** Current book/chapter (e.g. "GEN 1") — trailing segment when known. */
  bookLabel?: string | null
}

export function WorkspaceHeader({
  project,
  children,
  extraMenuItems,
  overviewHref,
  surfaceLabel,
  bookLabel,
}: Props) {
  const items = extraMenuItems ?? []
  const trail: OrgBreadcrumbTrailSegment[] = []
  if (surfaceLabel) trail.push({ label: surfaceLabel })
  if (bookLabel) trail.push({ label: bookLabel })
  return (
    <header className="relative z-30 flex items-center justify-between gap-3 pr-4">
      <OrgBreadcrumb
        section={project.name}
        sectionTo={overviewHref}
        workspace
        trail={trail.length > 0 ? trail : undefined}
      />
      <div className="flex shrink-0 items-center gap-1">
        {children}
        {items.length > 0 ? <OverflowMenu items={items} /> : null}
      </div>
    </header>
  )
}
