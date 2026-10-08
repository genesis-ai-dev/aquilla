/**
 * AQU-1072: access audit for org Owners and Maintainers. A tree of each
 * person, their teams, and each project at the role resolveProjectRoles
 * returned, plus lane grants by name. CSV download and browser print (PDF).
 */
import { useEffect, useState } from "react"
import { Download, Printer } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { AccessAuditTree } from "@/components/org/access/AccessAuditTree"
import {
  accessAuditCsv,
  accessAuditFilename,
  fetchAccessAudit,
  type AccessAuditReport,
} from "@/components/org/access/access-audit-data"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { Page, PageHeader } from "@/components/ui/page"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { downloadBlob } from "@/lib/export/export-service"
import { formatDateTime } from "@/lib/i18n/format"
import { useI18n, useT } from "@/lib/i18n/I18nProvider"

type LoadState =
  | { status: "loading" }
  | { status: "ready"; report: AccessAuditReport }
  | { status: "forbidden" }
  | { status: "error" }
type KeyedState = { orgId: number | null; state: LoadState }
const LOADING: LoadState = { status: "loading" }

const PRINT_CSS = `
.access-audit-print-head { display: none; }
@media print {
  .access-audit-print-head { display: block; }
  [data-print-hide] { display: none !important; }
  aside,
  [data-slot="app-shell-header"],
  [data-slot="app-shell-sidebar-footer"] { display: none !important; }
  html[data-app-frame],
  html[data-app-frame] body,
  main {
    overflow: visible !important;
    height: auto !important;
  }
  #access-audit-report { position: static; width: 100%; }
  .access-audit-person { break-inside: avoid; }
  @page { margin: 16mm; }
}
`

export function OrgAccessAuditPage() {
  const t = useT()
  const { locale } = useI18n()
  const { activeOrg, activeOrgId } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const [loaded, setLoaded] = useState<KeyedState>({ orgId: null, state: LOADING })

  useEffect(() => {
    if (!jwt || activeOrgId == null) return
    let cancelled = false
    fetchAccessAudit(jwt, activeOrgId).then(
      (result) => {
        if (cancelled) return
        if (!result.ok) {
          setLoaded({ orgId: activeOrgId, state: { status: result.reason === "forbidden" ? "forbidden" : "error" } })
          return
        }
        setLoaded({ orgId: activeOrgId, state: { status: "ready", report: result.report } })
      },
      () => {
        if (!cancelled) setLoaded({ orgId: activeOrgId, state: { status: "error" } })
      },
    )
    return () => { cancelled = true }
  }, [jwt, activeOrgId])

  const state: LoadState = jwt && activeOrgId != null && loaded.orgId === activeOrgId ? loaded.state : LOADING
  const title = t("org.accessAudit.title")
  const report = state.status === "ready" ? state.report : null

  const exportCsv = () => {
    if (!report) return
    const blob = new Blob([accessAuditCsv(t, report)], { type: "text/csv;charset=utf-8" })
    downloadBlob(blob, accessAuditFilename(report.orgName || activeOrg?.name || "org"))
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={title} />}
      statusBar={null}
      main={
        <Page size="wide">
          <style>{PRINT_CSS}</style>
          <div data-print-hide>
            <PageHeader
              title={title}
              description={t("org.accessAudit.description")}
              actions={
                <>
                  <Button variant="outline" size="sm" onClick={() => window.print()} disabled={!report}>
                    <Printer className="size-4" aria-hidden />
                    {t("org.accessAudit.print")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={exportCsv} disabled={!report}>
                    <Download className="size-4" aria-hidden />
                    {t("terminology.editor.exportCsv")}
                  </Button>
                </>
              }
            />
          </div>
          {state.status === "loading" ? (
            <LoadingPanel label={t("common.loading")} />
          ) : state.status === "forbidden" ? (
            <p role="alert" className="text-sm text-muted-foreground">{t("org.accessAudit.roleRequired")}</p>
          ) : state.status === "error" ? (
            <p role="alert" className="text-sm text-muted-foreground">{t("org.accessAudit.loadError")}</p>
          ) : report ? (
            <article id="access-audit-report">
              <header className="access-audit-print-head mb-4">
                <h1 className="font-heading text-xl font-semibold">{title}</h1>
                <p>{report.orgName}</p>
                <p>{t("org.accessAudit.generatedAt", { when: formatDateTime(report.generatedAt, locale) })}</p>
                <p className="mt-2 text-sm">{t("org.accessAudit.description")}</p>
              </header>
              <AccessAuditTree report={report} />
            </article>
          ) : null}
        </Page>
      }
    />
  )
}
