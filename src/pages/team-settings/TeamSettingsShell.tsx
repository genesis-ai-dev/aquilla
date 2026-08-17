import type { ReactNode } from "react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { Page, EmptyState } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useI18n } from "@/lib/i18n/I18nProvider"

export function TeamSettingsShell({
  header,
  children,
}: {
  header: ReactNode
  children: ReactNode
}) {
  const { t } = useI18n()
  const { activeOrg, isLoading } = useActiveOrg()

  let body: ReactNode
  if (isLoading) {
    body = (
      <div className="flex flex-col gap-12">
        <div className="h-28 animate-pulse rounded-lg border bg-card" />
        <div className="h-40 animate-pulse rounded-lg border bg-card" />
      </div>
    )
  } else if (!activeOrg) {
    body = (
      <EmptyState
        title={t("org.teamsList.selectOrgTitle")}
        description={t("settings.teamSettingsShell.description")}
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
