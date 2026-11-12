// Org settings → Airtable → "Next: link your projects" (AQU-804), as Monday's
// (OrgMondayProjectLinks): one row per project with its table (Sync paused,
// table changed or a failed push called out), or "Not linked yet" with the
// same setup steps as project settings. Everything else about a link lives in
// project settings.

import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowRight } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { AirtableSetupWizard } from "@/components/ProjectSettings/AirtableSetupWizard"
import { useI18n } from "@/lib/i18n/I18nProvider"
import { ROLE } from "@/lib/frontier/roles"
import { fetchAirtableOrgLinks, type AirtableOrgProjectLink } from "@/lib/airtable/api"

interface ProjectRow {
  id: string
  name: string
  role: { level: number }
}

export function OrgAirtableProjectLinks({
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
  const [links, setLinks] = useState<Map<string, AirtableOrgProjectLink> | null>(null)
  const [linksFailed, setLinksFailed] = useState(false)
  const [setupFor, setSetupFor] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!jwt || !canManageOrg) return
    try {
      const got = await fetchAirtableOrgLinks(jwt, orgId)
      setLinks(new Map(got.map((link) => [link.projectId, link])))
      setLinksFailed(false)
    } catch {
      setLinksFailed(true)
    }
  }, [jwt, canManageOrg, orgId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <>
      {canManageOrg && !links && !linksFailed && (
        <p className="text-sm text-muted-foreground" role="status">
          {t("projectSettings.monday.orgProjectLinksLoading")}
        </p>
      )}
      {linksFailed && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 text-sm text-destructive">
          <span>{t("projectSettings.airtable.orgProjectLinksFailed")}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            {t("common.retry")}
          </Button>
        </div>
      )}
      {projects.map((project) => {
        const link = links?.get(project.id)
        const canSetUp = project.role.level >= ROLE.MAINTAINER
        return (
          <div
            key={project.id}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border p-3"
            data-testid={`org-airtable-project-${project.id}`}
          >
            <div className="min-w-0 space-y-1">
              <p className="font-medium">{project.name}</p>
              {links && (
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {link
                    ? t("projectSettings.airtable.orgProjectLinkedTo", { table: link.tableName ?? link.tableId })
                    : t("projectSettings.monday.orgProjectNotLinked")}
                  {link && !link.enabled && (
                    <Badge variant="secondary">{t("projectSettings.monday.orgProjectSyncPaused")}</Badge>
                  )}
                  {link?.structureStale && (
                    <Badge variant="outline">{t("projectSettings.airtable.orgProjectTableChanged")}</Badge>
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
                to={`/project/${project.id}/settings/integrations#section-airtable`}
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
        <AirtableSetupWizard
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
