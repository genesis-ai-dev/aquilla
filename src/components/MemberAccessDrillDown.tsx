/**
 * MemberAccessDrillDown — panel/sheet showing which projects a member can
 * access, with the grant path (direct / group / org / creator) and the
 * resolved max-wins role (AD-12).
 *
 * Opened by clicking a member's name in MembersMatrixView (or any surface
 * that passes orgId + a selected member). Self-contained so it doesn't
 * collide with the AQU-170 org-vs-project legibility redesign.
 */
import { X, FolderX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { EmptyState } from "@/components/ui/page"
import { AppTooltip } from "@/components/ui/tooltip"
import { useMemberAccess } from "@/hooks/useMemberAccess"
import type { ProjectAccessBreakdown } from "@/lib/frontier/orgs"
import { roleName, roleDisplayText } from "@/lib/frontier/roles"
import { RoleLevelLabel } from "@/components/RoleLabel"

interface Props {
  orgId: number
  userId: number
  username: string
  onClose: () => void
}

export function MemberAccessDrillDown({ orgId, userId, username, onClose }: Props) {
  const state = useMemberAccess(orgId, userId)

  return (
    <div className="flex flex-col h-full border-s bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <p className="text-sm font-semibold">{username}</p>
          <p className="text-xs text-muted-foreground">Project access breakdown</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Close"
          className="text-muted-foreground"
        >
          <X />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {state.kind === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading access…
          </div>
        )}

        {state.kind === "error" && (
          <p className="text-sm text-destructive">{state.error}</p>
        )}

        {state.kind === "success" && (
          <>
            {/* Org-level baseline */}
            {state.data.orgRole != null && (
              <div className="rounded-md border bg-muted/30 px-3 py-2">
                <p className="text-xs text-muted-foreground">Org-level baseline</p>
                <p className="text-sm font-medium">
                  <RoleLevelLabel level={state.data.orgRole} />
                </p>
              </div>
            )}

            {/* Project list */}
            {state.data.projects.length === 0 ? (
              <EmptyState
                variant="inline"
                className="bg-muted/30 py-8"
                icon={FolderX}
                title={`${username} has no access to any project in this org.`}
              />
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  {state.data.projects.length} project
                  {state.data.projects.length !== 1 ? "s" : ""} accessible
                </p>
                {state.data.projects.map((p) => (
                  <ProjectRow key={p.projectId} breakdown={p} />
                ))}
              </div>
            )}
          </>
        )}

        {state.kind === "idle" && null}
      </div>
    </div>
  )
}

function ProjectRow({ breakdown }: { breakdown: ProjectAccessBreakdown }) {
  const resolvedRole = roleDisplayText(roleName(breakdown.resolved))
  const paths = grantPaths(breakdown)

  return (
    <div className="rounded-md border px-3 py-2 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <AppTooltip content={breakdown.projectName}>
          <span className="text-sm font-medium truncate">
            {breakdown.projectName}
          </span>
        </AppTooltip>
        <span className="shrink-0 text-xs rounded bg-primary/10 text-primary px-1.5 py-0.5 font-medium">
          {resolvedRole}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {paths.map((p, i) => (
          <AppTooltip key={i} content={p.detail}>
            <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
              {p.label}
            </span>
          </AppTooltip>
        ))}
      </div>
    </div>
  )
}

/** Enumerate the contributing grant paths for a project breakdown row. */
function grantPaths(b: ProjectAccessBreakdown): { label: string; detail: string }[] {
  const paths: { label: string; detail: string }[] = []

  if (b.direct != null) {
    paths.push({
      label: `direct · ${roleDisplayText(roleName(b.direct))}`,
      detail: "Explicitly added to this project (direct grant / override)",
    })
  }
  for (const g of b.groups) {
    paths.push({
      label: `group "${g.name}" · ${roleDisplayText(roleName(g.roleLevel))}`,
      detail: `Member of group "${g.name}" which has a project grant`,
    })
  }
  if (b.org != null) {
    paths.push({
      label: `org-level · ${roleDisplayText(roleName(b.org))}`,
      detail: "Org-level membership applies to all projects in this org",
    })
  }
  if (b.creator) {
    paths.push({
      label: "creator · owner",
      detail: "Created this project — permanent owner grant",
    })
  }
  return paths
}
