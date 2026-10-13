// Org settings → Monday.com → "Next: link your projects" (AQU-1770).
//
// One row per project: which board it's linked to (with Sync paused, board
// changed or a failed push called out), or "Not linked yet". An unlinked
// project is set up right here, in the same setup steps as project settings,
// so org settings isn't left behind. Everything else about a link (mapping,
// Sync, Sync now) lives in project settings, and the link there says so.

import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { MondaySetupWizard } from "@/components/ProjectSettings/MondaySetupWizard"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { ROLE } from "@/lib/frontier/roles"
import { fetchMondayOrgLinks, type MondayOrgProjectLink } from "@/lib/monday/api"

interface ProjectRow {
  id: string
  name: string
  role: { level: number }
}

export function OrgMondayProjectLinks({
  orgId,
  jwt,
  canManageOrg,
  projects,
}: {
  orgId: number
  jwt: string | null
  /** Org maintainers see each project's link; the list is theirs to read. */
  canManageOrg: boolean
  projects: ProjectRow[]
}) {
  const { t } = useI18n()
  const [links, setLinks] = useState<Map<string, MondayOrgProjectLink> | null>(null)
  const [setupFor, setSetupFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!jwt || !canManageOrg) return
    try {
      const got = await fetchMondayOrgLinks(jwt, orgId)
      setLinks(new Map(got.map((link) => [link.projectId, link])))
    } catch {
      // The rows still work without their status.
      setLinks(null)
    }
  }, [jwt, canManageOrg, orgId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      {projects.map((project) => {
        const link = links?.get(project.id)
        const canSetUp = project.role.level >= ROLE.MAINTAINER
        return (
          <div
            key={project.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border p-3"
            data-testid={`org-monday-project-${project.id}`}
          >
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{project.name}</p>
              {links && (
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {link
                    ? t("projectSettings.monday.orgProjectLinkedTo", { board: link.boardName ?? link.boardId })
                    : t("projectSettings.monday.orgProjectNotLinked")}
                  {link && !link.enabled && (
                    <Badge variant="secondary">{t("projectSettings.monday.orgProjectSyncPaused")}</Badge>
                  )}
                  {link?.structureStale && (
                    <Badge variant="outline">{t("projectSettings.monday.orgProjectBoardChanged")}</Badge>
                  )}
                  {link?.lastPushStatus === "error" && (
                    <Badge variant="destructive">{t("projectSettings.monday.orgProjectPushFailed")}</Badge>
                  )}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {links && !link && canSetUp && (
                <Button size="sm" onClick={() => setSetupFor(project.id)}>
                  {t("projectSettings.monday.orgProjectSetUp")}
                </Button>
              )}
              <Link
                to={`/project/${project.id}/settings/integrations#section-monday`}
                className={buttonVariants({ variant: "ghost", size: "sm" })}
              >
                {canSetUp
                  ? t("projectSettings.monday.orgProjectManageInSettings")
                  : t("projectSettings.monday.orgProjectViewInSettings")}
                <ArrowRight data-icon="inline-end" />
              </Link>
            </div>
          </div>
        )
      })}

      {setupFor && (
        <MondaySetupWizard
          open
          onOpenChange={(open) => {
            if (!open) setSetupFor(null)
          }}
          projectId={setupFor}
          orgId={orgId}
          jwt={jwt}
          orgConnected
          onLinked={() => void load()}
          onUnlinked={() => void load()}
          onConnected={() => void load()}
        />
      )}
    </>
  )
}
