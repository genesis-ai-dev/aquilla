/**
 * AQU-1352 §3.6 (AQU-1072): org "People & access" — who can do what, where.
 * Two views of GET /api/v2/orgs/:orgId/access (tree by scope, one row per
 * person) and a CSV export built from the same payload. The read, and the
 * org-switch rule that keeps one org's grants off another org's page, live in
 * `useOrgAccess` (AQU-2317).
 */
import { useState } from "react"
import { Download } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { AccessPeopleView } from "@/components/org/access/AccessPeopleView"
import { AccessTreeView } from "@/components/org/access/AccessTreeView"
import { orgAccessCsv } from "@/components/org/access/org-access-data"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { Page, PageHeader } from "@/components/ui/page"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useActiveOrg } from "@/context/OrgContext"
import { useOrgAccess } from "@/hooks/useOrgAccess"
import { downloadBlob } from "@/lib/export/export-service"
import { useT } from "@/lib/i18n/I18nProvider"

export function OrgAccessPage() {
  const t = useT()
  const { activeOrg } = useActiveOrg()
  const state = useOrgAccess()
  const [view, setView] = useState<"tree" | "people">("tree")

  const title = t("org.access.page.title")
  const exportCsv = () => {
    if (state.status !== "ready") return
    const blob = new Blob([orgAccessCsv(t, state.data.people)], { type: "text/csv;charset=utf-8" })
    downloadBlob(blob, `${(activeOrg?.name ?? "org").replace(/[^\w-]+/g, "-")}-access.csv`)
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={title} />}
      statusBar={null}
      main={
        <Page size="full">
          <PageHeader
            title={title}
            actions={
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={state.status !== "ready"}>
                <Download className="size-4" aria-hidden />
                {t("terminology.editor.exportCsv")}
              </Button>
            }
          />
          {state.status === "loading" ? (
            <LoadingPanel label={t("common.loading")} />
          ) : state.status === "error" ? (
            <p role="alert" className="text-sm text-muted-foreground">{t("org.access.page.loadError")}</p>
          ) : (
            <Tabs value={view} onValueChange={(v) => setView(v === "people" ? "people" : "tree")}>
              <TabsList>
                <TabsTrigger value="tree">{t("org.access.page.treeView")}</TabsTrigger>
                <TabsTrigger value="people">{t("org.overviewLaneTable.peopleColumn")}</TabsTrigger>
              </TabsList>
              <TabsContent value="tree" className="mt-3">
                <AccessTreeView tree={state.data.tree} />
              </TabsContent>
              <TabsContent value="people" className="mt-3">
                {state.org && <AccessPeopleView people={state.data.people} org={state.org} />}
              </TabsContent>
            </Tabs>
          )}
        </Page>
      }
    />
  )
}
