import { useCallback, useEffect, useState } from "react"
import { ShieldOff, UserX } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchOrgMembersMatrix, removeProjectMember } from "@/lib/frontier/members"
import { fetchAccessibleProjects } from "@/lib/sync/cloud-projects"
import {
  deriveExternalCollaborators,
  type ExternalCollaborator,
} from "@/lib/frontier/external-collaborators"
import { toUserFacingError } from "@/lib/errors/user-error"

/**
 * FRO-326: org-level governance view of everyone who reaches this org's
 * projects WITHOUT being an org member (invite-link redeem, bulk-add,
 * group). Derived on read from the members matrix — see
 * lib/frontier/external-collaborators.ts for why this is never a stored
 * org_members variant.
 *
 * Direct grants are revocable inline (the org owns its projects, so org
 * admins may revoke grants a project maintainer created). Group grants
 * point at the group instead — revoking those means detaching the group
 * or removing the user from it.
 */
export function ExternalCollaboratorsSection({
  orgId,
  orgMemberIds,
}: {
  orgId: number
  orgMemberIds: number[]
}) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [externals, setExternals] = useState<ExternalCollaborator[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyGrant, setBusyGrant] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!jwt) return
    try {
      const [matrix, projects] = await Promise.all([
        fetchOrgMembersMatrix(jwt, orgId),
        fetchAccessibleProjects(jwt, orgId),
      ])
      const names = new Map(projects.map((p) => [p.id, p.name]))
      setExternals(deriveExternalCollaborators(matrix, new Set(orgMemberIds), names))
      setError(null)
    } catch (e) {
      setError(toUserFacingError(e, "org").message)
    }
    // orgMemberIds is a fresh array each render; key on its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, orgId, orgMemberIds.join(",")])

  useEffect(() => { void load() }, [load])

  async function revoke(projectId: string, userId: number) {
    if (!jwt) return
    const key = `${projectId}:${userId}`
    setBusyGrant(key)
    setError(null)
    try {
      await removeProjectMember(jwt, projectId, userId)
      await load()
    } catch (e) {
      setError(toUserFacingError(e, "project").message)
    } finally {
      setBusyGrant(null)
    }
  }

  if (externals.length === 0 && !error) return null

  return (
    <section data-testid="external-collaborators" className="space-y-2">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <UserX className="h-4 w-4 text-muted-foreground" aria-hidden />
          External collaborators
        </h2>
        <p className="text-xs text-muted-foreground">
          People outside this organization with access to specific projects
          (via invite links, direct adds, or teams). Revoking removes their
          access to that project only.
        </p>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <ul className="divide-y rounded border">
        {externals.map((e) => (
          <li key={e.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="font-medium">{e.username}</span>
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
              external
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {e.grants.map((g) => (
                <span
                  key={`${g.projectId}:${e.userId}`}
                  className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                >
                  <span className="max-w-40 truncate">{g.projectName}</span>
                  <span className="text-muted-foreground">· {g.roleName}</span>
                  {g.source === "override" ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-4 w-4 text-muted-foreground hover:text-destructive"
                      aria-label={`Revoke ${e.username}'s access to ${g.projectName}`}
                      disabled={busyGrant === `${g.projectId}:${e.userId}`}
                      onClick={() => void revoke(g.projectId, e.userId)}
                    >
                      <ShieldOff className="h-3 w-3" />
                    </Button>
                  ) : (
                    <span
                      className="text-[10px] text-muted-foreground"
                      title={
                        g.source === "group"
                          ? "Access via a team — detach the team or remove them from it to revoke"
                          : "Project creator"
                      }
                    >
                      via {g.source}
                    </span>
                  )}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
