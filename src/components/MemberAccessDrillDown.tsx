/**
 * MemberAccessDrillDown — panel/sheet showing which projects a member can
 * access, with the grant path (direct / group / org / creator) and the
 * resolved max-wins role (AD-12).
 *
 * Opened by clicking a member's name in MembersMatrixView (or any surface
 * that passes orgId + a selected member). Self-contained so it doesn't
 * collide with the FRO-170 org-vs-project legibility redesign.
 */
import { X } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { useMemberAccess } from "@/hooks/useMemberAccess"
import type { ProjectAccessBreakdown } from "@/lib/frontier/orgs"
import { roleName } from "@/lib/frontier/roles"

interface Props {
  orgId: number
  userId: number
  username: string
  onClose: () => void
}

export function MemberAccessDrillDown({ orgId, userId, username, onClose }: Props) {
  const state = useMemberAccess(orgId, userId)

  return (
    <div className="flex flex-col h-full border-l bg-background">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b">
        <div>
          <p className="text-sm font-semibold">{username}</p>
          <p className="text-xs text-muted-foreground">Project access breakdown</p>
        </div>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded p-1 hover:bg-muted"
        >
          <X className="h-4 w-4" />
        </button>
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
                <p className="text-sm font-medium capitalize">
                  {roleName(state.data.orgRole).replace(/_/g, " ")}
                </p>
              </div>
            )}

            {/* Project list */}
            {state.data.projects.length === 0 ? (
              <div className="rounded-md border bg-muted/30 p-6 text-center">
                <p className="text-sm text-muted-foreground">
                  {username} has no access to any project in this org.
                </p>
              </div>
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
  const resolvedRole = roleName(breakdown.resolved).replace(/_/g, " ")
  const paths = grantPaths(breakdown)

  return (
    <div className="rounded-md border px-3 py-2 space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium truncate" title={breakdown.projectName}>
          {breakdown.projectName}
        </span>
        <span className="shrink-0 text-xs rounded bg-primary/10 text-primary px-1.5 py-0.5 capitalize font-medium">
          {resolvedRole}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {paths.map((p, i) => (
          <span
            key={i}
            title={p.detail}
            className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground"
          >
            {p.label}
          </span>
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
      label: `direct · ${roleName(b.direct).replace(/_/g, " ")}`,
      detail: "Explicitly added to this project (direct grant / override)",
    })
  }
  for (const g of b.groups) {
    paths.push({
      label: `group "${g.name}" · ${roleName(g.roleLevel).replace(/_/g, " ")}`,
      detail: `Member of group "${g.name}" which has a project grant`,
    })
  }
  if (b.org != null) {
    paths.push({
      label: `org-level · ${roleName(b.org).replace(/_/g, " ")}`,
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
