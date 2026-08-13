import type { ReactNode } from "react"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { PageHeader } from "@/components/ui/page"
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
      <div className="flex flex-col gap-12">
        <PageHeader title={title} description={description} className="mb-0" />
        {children}
      </div>
    </OrgSettingsShell>
  )
}
