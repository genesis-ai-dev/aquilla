import { GitBranch, MoreVertical, PauseCircle, Trash2, Undo2 } from "lucide-react"
import type { ProjectRecord } from "@/lib/parsers/types"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MembershipAvatars } from "./MembershipAvatars"
import { HealthRing } from "./HealthRing"
import { useProjectMembers } from "@/hooks/useProjectMembers"
import { useProjectHealth } from "@/hooks/useProjectHealth"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { roleName } from "@/lib/frontier/roles"

/**
 * Has this project ever lived server-side? Two signals:
 *   - syncRole was cached after a /sync-token round-trip (proof of access)
 *   - origin.kind === "git" (cloned from a remote, server-side by default)
 *
 * When neither holds, the project exists only in IndexedDB and any call
 * to /api/v2/projects/:id/members will return 404/403 — noisy console
 * errors with no value. Skip the fetch for those.
 */
function hasServerSideExistence(project: ProjectRecord): boolean {
  if (project.syncRole) return true
  if (project.origin?.kind === "git") return true
  return false
}

interface ProjectCardProps {
  project: ProjectRecord
  onClick: () => void
  /** Show the overflow menu with "Move to Trash". Hidden when the user
   * doesn't own the project. */
  canTrash?: boolean
  onTrash?: () => void
  /** Render a trashed-state card instead of the normal one. The click handler
   * is swapped for a Restore button. */
  variant?: "active" | "trashed"
  onRestore?: () => void
  /** Show the Mark Inactive / Reactivate action in the overflow menu.
   * Only shown to callers with project_lead+ role. */
  canToggleLifecycle?: boolean
  onToggleLifecycle?: () => void
}

export function ProjectCard({
  project,
  onClick,
  canTrash,
  onTrash,
  variant = "active",
  onRestore,
  canToggleLifecycle,
  onToggleLifecycle,
}: ProjectCardProps) {
  const isGit = project.origin?.kind === "git"
  const isTrashed = variant === "trashed"
  // isActive absent or true → active; explicit false → inactive (frozen)
  const isInactive = project.isActive === false
  // Skip the fetch entirely for trashed cards (irrelevant) and for local-only
  // projects that have never been server-side (would 403/404 every time).
  const fetchKey = !isTrashed && hasServerSideExistence(project) ? project.id : null
  const { members } = useProjectMembers(fetchKey)
  const { projectHealth } = useProjectHealth(fetchKey)
  const { session } = useFrontierSession()

  // First member with role >= MAINTAINER level is the canonical maintainer for
  // empty-state copy. We sort descending so OWNER (highest) sorts first; the
  // top entry is the best person to name. Returns null while still fetching.
  const maintainerLabel = (() => {
    if (members.length === 0) return null
    const sorted = [...members].sort((a, b) => b.role.level - a.role.level)
    const top = sorted[0]
    if (!top) return null
    return top.username
  })()

  // Derive my role on this project. Prefer the live members fetch (freshest),
  // fall back to the syncRole cache (still useful when offline). Local-only
  // projects with no server-side existence get no badge — ownership is
  // implicit and showing a label adds nothing.
  const myMember = session?.username
    ? members.find((m) => m.username === session.username)
    : undefined
  const myRoleLabel: string | null =
    myMember?.role.name ??
    (project.syncRole ? roleName(project.syncRole.level) : null)

  return (
    <Card
      className={`${isTrashed ? "opacity-70" : "cursor-pointer hover:shadow-neu-lg"} ${isInactive && !isTrashed ? "opacity-60" : ""} transition-shadow`}
      onClick={isTrashed ? undefined : onClick}
      data-testid={isInactive && !isTrashed ? "inactive-project-card" : undefined}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-lg">{project.name}</CardTitle>
          <div className="flex items-center gap-1.5">
            {!isTrashed && projectHealth !== null && (
              <HealthRing
                health={projectHealth}
                size={22}
                strokeWidth={2.5}
                className="shrink-0"
                style={{ color: "var(--muted-foreground)" }}
              >
                <span
                  className="text-[6px] font-bold leading-none"
                  style={{ color: projectHealth <= 33 ? "#ef4444" : projectHealth <= 66 ? "#f59e0b" : "#22c55e" }}
                >
                  {projectHealth}
                </span>
              </HealthRing>
            )}
            {!isTrashed && isInactive && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 px-2 py-0.5 text-[10px] font-medium"
                title="This project is inactive and cannot be edited until reactivated"
                data-testid="inactive-badge"
              >
                <PauseCircle className="h-3 w-3" aria-hidden />
                Inactive
              </span>
            )}
            {!isTrashed && myRoleLabel && (
              <span
                className="inline-flex items-center rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px] font-medium capitalize"
                title="Your role on this project"
              >
                {myRoleLabel.replace(/_/g, " ")}
              </span>
            )}
            {isGit && (
              <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground shadow-neu-inset">
                <GitBranch className="h-3 w-3" /> git
              </span>
            )}
            {!isTrashed && (canTrash || canToggleLifecycle) && (
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      aria-label="Project actions"
                      onClick={(e) => e.stopPropagation()}
                    />
                  }
                >
                  <MoreVertical className="h-4 w-4" />
                </PopoverTrigger>
                <PopoverContent
                  className="w-48 p-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  {canToggleLifecycle && onToggleLifecycle && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted"
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggleLifecycle()
                      }}
                      data-testid="toggle-lifecycle-button"
                    >
                      <PauseCircle className="h-4 w-4" />
                      {isInactive ? "Mark as Active" : "Mark as Inactive"}
                    </button>
                  )}
                  {canTrash && onTrash && (
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-sm text-destructive hover:bg-destructive/10"
                      onClick={(e) => {
                        e.stopPropagation()
                        onTrash()
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                      Move to Trash
                    </button>
                  )}
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {project.sourceLanguage || project.targetLanguage ? (
          <p className="text-sm text-muted-foreground">
            {project.sourceLanguage || "?"} → {project.targetLanguage || "?"}
          </p>
        ) : hasServerSideExistence(project) ? (
          <p className="text-sm text-muted-foreground italic">
            Awaiting setup{maintainerLabel ? ` by ${maintainerLabel}` : ""}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            Languages not set
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          {project.files.length} file{project.files.length !== 1 ? "s" : ""}
        </p>
        {!isTrashed && members.length > 0 && (
          <div className="mt-2">
            <MembershipAvatars members={members} maxVisible={4} />
          </div>
        )}
        {isTrashed && (
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              Deleted
              {project.deletedBy ? ` by ${project.deletedBy}` : ""}
              {project.deletedAt ? ` · ${formatDate(project.deletedAt)}` : ""}
            </span>
            {onRestore && (
              <Button size="sm" variant="outline" onClick={onRestore}>
                <Undo2 className="mr-1 h-3.5 w-3.5" />
                Restore
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })
  } catch {
    return iso
  }
}
