import type { ReactNode } from "react"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { LockedNote } from "@/components/ui/locked-note"
import { PageHeader } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { resolveRoleName } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"
import { orgSettingsPath } from "@/lib/navigation/org-paths"
import { ORG_SETTINGS_EDIT_FLOOR, canChangeOrgSettingsPage, type OrgSettingsPage } from "./org-settings-access"
import { OrgSettingsShell } from "./OrgSettingsShell"

export function OrgSettingsDetailPage({
  title,
  description,
  page,
  children,
}: {
  title: string
  description?: string
  /** Which page this is, so one you cannot change says who can, once, under
   *  its title (AQU-2260). The page stays readable. */
  page?: OrgSettingsPage
  children: ReactNode
}) {
  const t = useT()
  const { activeOrg, activeOrgId } = useActiveOrg()
  const settingsIndex = activeOrgId != null ? orgSettingsPath(activeOrgId) : "/orgs/all"
  const locked = page != null && activeOrg != null && !canChangeOrgSettingsPage(page, activeOrg.role?.level)

  return (
    <OrgSettingsShell
      header={
        <OrgBreadcrumb parent={{ label: "Settings", to: settingsIndex }} section={title} />
      }
    >
      <div className="flex flex-col gap-12">
        <div className="flex flex-col gap-3">
          <PageHeader title={title} description={description} className="mb-0" />
          {locked ? (
            <LockedNote placement="section" testId="org-settings-locked" className="text-sm">
              {t("settings.locked.page", {
                role: resolveRoleName(t, ORG_SETTINGS_EDIT_FLOOR[page], { plural: true }),
                section: title,
              })}
            </LockedNote>
          ) : null}
        </div>
        {children}
      </div>
    </OrgSettingsShell>
  )
}
