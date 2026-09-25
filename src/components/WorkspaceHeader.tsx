import type { ReactNode } from "react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { OrgBreadcrumb, type OrgBreadcrumbTrailSegment } from "@/components/org/OrgBreadcrumb"
import { OverflowMenu, type OverflowMenuItem } from "./OverflowMenu"
import { WorkspaceHeaderActions } from "./WorkspaceHeaderActions"

interface Props {
  project: ProjectRecord
  children?: ReactNode
  extraMenuItems?: OverflowMenuItem[]
  /** When set, renders Import in a button group beside the ⋯ overflow menu. */
  onImport?: () => void
  /**
   * AQU-481: why Import is unavailable to this caller (below the `file.create`
   * PROJECT_LEAD floor), or null when it is allowed. Passed straight through to
   * `WorkspaceHeaderActions`, which renders the button disabled with this as
   * its tooltip rather than opening a dialog the server would refuse.
   */
  importDisabledReason?: string | null
  /** When set, renders a Settings cog beside the Import group. */
  onSettings?: () => void
  /**
   * AQU-428: When provided, the project name in the breadcrumb becomes a
   * clickable link to the project overview page (`/projects/:id`), giving
   * project-only invitees (and all users) a direct path back to the overview
   * without having to navigate through the full dashboard.
   */
  overviewHref?: string
  /** Workspace surface (e.g. "Editor") — shown after the project name. */
  surfaceLabel?: string
  /**
   * When an overlay (Comments, Rules, …) was opened from the editor, link
   * back to that editor URL as a crumb before `surfaceLabel`.
   */
  editorHref?: string
  /** Current book/chapter (e.g. "GEN 1") — trailing segment when known. */
  bookLabel?: string | null
}

export function WorkspaceHeader({
  project,
  children,
  extraMenuItems,
  onImport,
  importDisabledReason,
  onSettings,
  overviewHref,
  surfaceLabel,
  editorHref,
  bookLabel,
}: Props) {
  const items = extraMenuItems ?? []
  const trail: OrgBreadcrumbTrailSegment[] = []
  if (editorHref) trail.push({ label: "Editor", to: editorHref })
  if (surfaceLabel) trail.push({ label: surfaceLabel })
  if (bookLabel) trail.push({ label: bookLabel })
  return (
    <header className="relative z-30 flex h-full min-w-0 items-center justify-between gap-3 pe-4">
      <div className="min-w-0 flex-1">
        <OrgBreadcrumb
          section={project.name}
          sectionTo={overviewHref}
          orgId={project.orgId}
          trail={trail.length > 0 ? trail : undefined}
        />
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {children}
        {onImport ? (
          <WorkspaceHeaderActions
            onImport={onImport}
            importDisabledReason={importDisabledReason}
            onSettings={onSettings}
            menuItems={items}
          />
        ) : items.length > 0 ? (
          <OverflowMenu items={items} />
        ) : null}
      </div>
    </header>
  )
}
