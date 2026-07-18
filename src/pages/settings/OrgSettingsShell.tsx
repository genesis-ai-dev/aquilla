import type { ReactNode } from "react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { Page, EmptyState } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"

export function OrgSettingsShell({
  header,
  children,
}: {
  header: ReactNode
  children: ReactNode
}) {
  const { activeOrg, isLoading } = useActiveOrg()

  let body: ReactNode
  if (isLoading) {
    body = (
      <div className="space-y-6">
        <div className="h-28 animate-pulse rounded-2xl border bg-card" />
        <div className="h-40 animate-pulse rounded-2xl border bg-card" />
      </div>
    )
  } else if (!activeOrg) {
    body = (
      <EmptyState
        title="Select an organization"
        description="Organization settings are managed within a single organization. Choose one from the switcher to continue."
      />
    )
  } else {
    body = children
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={header}
      statusBar={null}
      main={<Page>{body}</Page>}
    />
  )
}
