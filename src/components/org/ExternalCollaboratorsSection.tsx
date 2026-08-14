import { useCallback, useEffect, useState } from "react"
import { ShieldOff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/page"
import { AppTooltip } from "@/components/ui/tooltip"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchOrgMembersMatrix, removeProjectMember } from "@/lib/frontier/members"
import { fetchAccessibleProjects } from "@/lib/sync/cloud-projects"
import {
  deriveExternalCollaborators,
  type ExternalCollaborator,
} from "@/lib/frontier/external-collaborators"
import { RoleLabel } from "@/components/RoleLabel"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { toUserFacingError } from "@/lib/errors/user-error"

/**
 * AQU-326: org-level governance view of everyone who reaches this org's
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
    <Section
      data-testid="external-collaborators"
      title="External collaborators"
      description="People outside this organization with access to specific projects (via invite links, direct adds, or teams). Revoking removes their access to that project only."
      contentClassName="space-y-2"
    >
      {error && <p className="text-xs text-destructive">{error}</p>}

      <ul className="divide-y rounded-lg border">
        {externals.map((e) => (
          <li key={e.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <UsernameWithAvatar username={e.username} />
            <Badge className="border-transparent bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300">
              external
            </Badge>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {e.grants.map((g) => (
                <Badge
                  key={`${g.projectId}:${e.userId}`}
                  variant="outline"
                  className="gap-1 font-normal"
                >
                  <span className="max-w-40 truncate">{g.projectName}</span>
                  <span className="text-muted-foreground">· <RoleLabel name={g.roleName} /></span>
                  {g.source === "override" ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-4 text-muted-foreground hover:text-destructive"
                      aria-label={`Revoke ${e.username}'s access to ${g.projectName}`}
                      disabled={busyGrant === `${g.projectId}:${e.userId}`}
                      onClick={() => void revoke(g.projectId, e.userId)}
                    >
                      <ShieldOff className="size-3" />
                    </Button>
                  ) : (
                    <AppTooltip
                      content={
                        g.source === "group"
                          ? "Access via a team: detach the team or remove them from it to revoke"
                          : "Project creator"
                      }
                      className="max-w-xs"
                    >
                      <span className="text-[10px] text-muted-foreground">
                        via {g.source}
                      </span>
                    </AppTooltip>
                  )}
                </Badge>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
