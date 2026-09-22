import { useCallback, useEffect, useRef, useState } from "react"
import { ShieldOff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/page"
import { AppTooltip } from "@/components/ui/tooltip"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { fetchOrgMembersMatrix, removeProjectMember } from "@/lib/frontier/members"
import {
  fetchAccessibleProjectsResult,
  projectsResultError,
} from "@/lib/sync/cloud-projects"
import {
  deriveExternalCollaborators,
  type ExternalCollaborator,
} from "@/lib/frontier/external-collaborators"
import { RoleLabel } from "@/components/RoleLabel"
import { UsernameWithAvatar } from "@/components/UsernameWithAvatar"
import { toUserFacingError, UserError } from "@/lib/errors/user-error"
import { useT } from "@/lib/i18n/I18nProvider"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"

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
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [externals, setExternals] = useState<ExternalCollaborator[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busyGrant, setBusyGrant] = useState<string | null>(null)
  const loadRequestRef = useRef(0)
  const loadScopeKey = `${jwt ?? ""}\u0000${orgId}\u0000${orgMemberIds.join(",")}`
  const loadScopeRef = useRef(loadScopeKey)
  loadScopeRef.current = loadScopeKey

  // A dependency list entry has to be a simple expression (react-hooks/use-memo),
  // so the content key is computed here rather than inline in the deps array.
  const orgMemberIdsKey = orgMemberIds.join(",")

  const load = useCallback(async () => {
    const request = ++loadRequestRef.current
    if (!jwt) return
    try {
      const [matrix, projectsResult] = await Promise.all([
        fetchOrgMembersMatrix(jwt, orgId),
        fetchAccessibleProjectsResult(jwt, orgId),
      ])
      if (loadRequestRef.current !== request || loadScopeRef.current !== loadScopeKey) return
      if (!projectsResult.ok) {
        if (projectsResult.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt)
        throw projectsResultError(projectsResult)
      }
      const projects = projectsResult.projects
      const names = new Map(projects.map((p) => [p.id, p.name]))
      setExternals(deriveExternalCollaborators(matrix, new Set(orgMemberIds), names))
      setError(null)
    } catch (e) {
      if (loadRequestRef.current !== request || loadScopeRef.current !== loadScopeKey) return
      if (e instanceof UserError && e.category === "session-expired") {
        void notifySessionExpiredIfCurrent(jwt)
      }
      setError(toUserFacingError(e, "org").message)
    }
    // orgMemberIds is a fresh array each render; key on its contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jwt, orgId, loadScopeKey, orgMemberIdsKey])

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
      title={t("org.externalCollaborators.title")}
      description={t("org.externalCollaborators.description")}
      contentClassName="space-y-2"
    >
      {error && <p className="text-xs text-destructive">{error}</p>}

      <ul className="divide-y rounded-lg border">
        {externals.map((e) => (
          <li key={e.userId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <UsernameWithAvatar username={e.username} />
            <Badge className="border-transparent bg-amber-500/15 text-[10px] text-amber-700 dark:text-amber-300">
              {t("org.externalCollaborators.badge")}
            </Badge>
            <div className="ms-auto flex flex-wrap items-center gap-1.5">
              {e.grants.map((g) => (
                <span key={`${g.projectId}:${e.userId}`} className="inline-flex items-center gap-1">
                  <Badge
                    variant="outline"
                    className="max-w-40 truncate font-normal"
                  >
                    {g.projectName}
                  </Badge>
                  <RoleLabel name={g.roleName} />
                  {g.source === "override" ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-4 text-muted-foreground hover:text-destructive"
                      aria-label={t("org.externalCollaborators.revokeAriaLabel", {
                        username: e.username,
                        project: g.projectName,
                      })}
                      disabled={busyGrant === `${g.projectId}:${e.userId}`}
                      onClick={() => void revoke(g.projectId, e.userId)}
                    >
                      <ShieldOff className="size-3" />
                    </Button>
                  ) : (
                    <AppTooltip
                      content={
                        g.source === "group"
                          ? t("org.externalCollaborators.viaTeamTooltip")
                          : t("projectSettings.share.lockedHintCreator")
                      }
                      className="max-w-xs"
                    >
                      <span className="text-[10px] text-muted-foreground">
                        {t("org.externalCollaborators.viaSourceLabel", { source: g.source })}
                      </span>
                    </AppTooltip>
                  )}
                </span>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}
