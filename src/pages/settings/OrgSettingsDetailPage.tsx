import type { ReactNode } from "react"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { PageHeader } from "@/components/ui/page"
import { BackLink } from "@/components/ui/nav-list"
import { useActiveOrg } from "@/context/OrgContext"
import { orgSettingsPath } from "@/lib/navigation/org-paths"
import { OrgSettingsShell } from "./OrgSettingsShell"

export function OrgSettingsDetailPage({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  const { activeOrgId } = useActiveOrg()
  const settingsIndex = activeOrgId != null ? orgSettingsPath(activeOrgId) : "/orgs/all"

  return (
    <OrgSettingsShell
      header={
        <OrgBreadcrumb parent={{ label: "Settings", to: settingsIndex }} section={title} />
      }
    >
      <div className="space-y-6">
        <BackLink to={settingsIndex} label="Settings" />
        <PageHeader title={title} description={description} />
        {children}
      </div>
    </OrgSettingsShell>
  )
}
