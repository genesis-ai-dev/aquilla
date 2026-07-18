import type { ReactNode } from "react"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { PageHeader } from "@/components/ui/page"
import { BackLink } from "@/components/ui/nav-list"
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
  return (
    <OrgSettingsShell
      header={
        <OrgBreadcrumb parent={{ label: "Settings", to: "/settings" }} section={title} />
      }
    >
      <div className="space-y-6">
        <BackLink to="/settings" label="Settings" />
        <PageHeader title={title} description={description} />
        {children}
      </div>
    </OrgSettingsShell>
  )
}
