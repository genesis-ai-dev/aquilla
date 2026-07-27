import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { getMemberAccess, type MemberEffectiveAccess, type ProjectAccessBreakdown } from "@/lib/frontier/orgs"
import { removeProjectMember } from "@/lib/frontier/members"
import { ROLE } from "@/lib/frontier/roles"
import { RoleLevelLabel } from "@/components/RoleLabel"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { denialMessage } from "@/lib/permissions/denial"

/**
 * AD-12 effective-access panel for one org member. Expands to show, per project,
 * every contributing grant path (direct / team / org / creator) with the
 * resolved max — the "why does X have access?" debugger that makes max-wins
 * workable for managers. The DIRECT grant is revocable here (clean, project-
 * scoped); org/group/creator paths are shown with their blast radius and a
 * pointer to where they're managed, never auto-revoked (that would over-reach).
 */
export function MemberAccessRow({
  orgId,
  userId,
  username,
  callerOrgRoleLevel,
}: {
  orgId: number
  userId: number
  username: string
  /**
   * AQU-427: The current user's org-level role. When provided, the "Revoke
   * direct grant" button is disabled with an explanation for callers who lack
   * MAINTAINER (600) — instead of a silent no-op or a raw server 403. The
   * server requires MAINTAINER (600) to remove a project member
   * (projects.ts DELETE /members), so the client gate must match.
   * When omitted the button remains enabled (fail-open; server is still
   * authoritative).
   */
  callerOrgRoleLevel?: number | null
}) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<MemberEffectiveAccess | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  // AQU-427: callers with role < MAINTAINER (600) cannot revoke direct grants
  // (matches the server gate in projects.ts DELETE /members).
  const canRevoke =
    callerOrgRoleLevel == null ? true : callerOrgRoleLevel >= ROLE.MAINTAINER

  const fetchAccess = useCallback(async () => {
    if (!jwt) return
    setLoading(true)
    setError(null)
    try {
      setData(await getMemberAccess(jwt, orgId, userId))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [jwt, orgId, userId])

  useEffect(() => {
    if (open && data === null) void fetchAccess()
  }, [open, data, fetchAccess])

  async function revokeDirect(projectId: string) {
    if (!jwt) return
    setRevoking(projectId)
    setError(null)
    try {
      await removeProjectMember(jwt, projectId, userId)
      setData(null)
      await fetchAccess()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRevoking(null)
    }
  }

  return (
    <li className="py-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-muted"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <span className="font-medium">{username}</span>
        {data && (
          <span className="text-[10px] text-muted-foreground">
            {data.projects.length > 0
              ? `${data.projects.length} project${data.projects.length === 1 ? "" : "s"} with explicit access`
              : "org-role only; no project overrides"}
          </span>
        )}
      </button>

      {open && (
        <div className="ml-4 mt-1 space-y-2">
          {loading && (
            <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <Spinner className="size-3" />
              Loading…
            </span>
          )}
          {error && <p className="text-[10px] text-destructive">{error}</p>}
          {data && !loading && (
            <>
              <p className="text-[10px] text-muted-foreground">
                {data.orgRole != null ? (
                  <>
                    Org role: <RoleLevelLabel level={data.orgRole} as="strong" /> — applies to every project in this org.
                  </>
                ) : (
                  "No org-wide role."
                )}
              </p>
              {data.projects.length === 0 ? (
                <p className="text-[10px] text-muted-foreground">
                  No direct, team, or creator grants on any project.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {data.projects.map((p) => (
                    <AccessProjectRow
                      key={p.projectId}
                      p={p}
                      revoking={revoking === p.projectId}
                      canRevoke={canRevoke}
                      callerOrgRoleLevel={callerOrgRoleLevel ?? null}
                      onRevokeDirect={() => revokeDirect(p.projectId)}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </li>
  )
}

function AccessProjectRow({
  p,
  revoking,
  canRevoke,
  callerOrgRoleLevel,
  onRevokeDirect,
}: {
  p: ProjectAccessBreakdown
  revoking: boolean
  /** AQU-427: whether the current user may revoke direct grants. */
  canRevoke: boolean
  callerOrgRoleLevel: number | null
  onRevokeDirect: () => void
}) {
  const otherPaths = [
    ...p.groups.map((g) => `team "${g.name}"`),
    ...(p.org != null ? ["org role"] : []),
    ...(p.creator ? ["project creator"] : []),
  ]
  return (
    <li className="rounded border bg-background p-2">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium">{p.projectName}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground">
          resolved: <RoleLevelLabel level={p.resolved} as="strong" />
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {p.direct != null && <Chip>direct: <RoleLevelLabel level={p.direct} /></Chip>}
        {p.groups.map((g) => (
          <Chip key={g.groupId}>team {g.name}: <RoleLevelLabel level={g.roleLevel} /></Chip>
        ))}
        {p.org != null && <Chip>org: <RoleLevelLabel level={p.org} /></Chip>}
        {p.creator && <Chip>creator</Chip>}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        {p.direct != null && (
          <button
            type="button"
            onClick={canRevoke ? onRevokeDirect : undefined}
            disabled={revoking || !canRevoke}
            title={
              !canRevoke
                ? denialMessage(ROLE.MAINTAINER, callerOrgRoleLevel)
                : undefined
            }
            data-testid="revoke-direct-grant"
            className="rounded border px-2 py-0.5 text-[10px] hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
          >
            {revoking ? "Revoking…" : "Revoke direct grant"}
          </button>
        )}
        {otherPaths.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            Also via {otherPaths.join(", ")} — manage in Teams / Members.
          </span>
        )}
      </div>
    </li>
  )
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-lg border bg-muted px-2 py-0.5 text-[10px]">
      {children}
    </span>
  )
}
