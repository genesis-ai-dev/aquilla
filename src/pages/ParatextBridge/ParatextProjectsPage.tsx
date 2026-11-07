import { useMemo, useState } from "react"
import { BookOpen, FolderPlus, RefreshCw, Search, X } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ThisComputerSidebar } from "@/components/this-computer/ThisComputerSidebar"
import { ThisComputerBreadcrumb } from "@/components/this-computer/ThisComputerBreadcrumb"
import { Page, PageHeader } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { EmptyState } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { useParatextDiscovery } from "@/lib/paratext-bridge/use-paratext-discovery"
import { pickFolder } from "@/lib/paratext-bridge/tauri"
import { ParatextProjectRow, useLinkedGuids } from "@/components/paratext/ParatextProjectRow"

const PARATEXT_DOCS_URL =
  `${(import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() || "https://help.aquilla.app"}/projects/paratext-projects/`

/** Desktop-only: Paratext projects found on this computer. One click opens a
 *  book; edits are written straight into the Paratext project folder. */
export function ParatextProjectsPage() {
  const t = useT()
  const d = useParatextDiscovery()
  const linked = useLinkedGuids(d.projects)
  const [query, setQuery] = useState("")
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return d.projects
    return d.projects.filter((p) => [p.settings.fullName, p.settings.name, p.settings.language].some((v) => v?.toLowerCase().includes(q)))
  }, [d.projects, query])

  const addFolder = async () => {
    const path = await pickFolder(t("paratextBridge.thisComputer.pickFolderTitle"))
    if (path?.trim()) await d.addRoot(path.trim())
  }

  return (
    <AppShell
      sidebar={<ThisComputerSidebar />}
      header={<ThisComputerBreadcrumb trail={[{ label: t("paratextBridge.title") }]} />}
      statusBar={null}
      main={
        <Page>
          <PageHeader
            title={t("paratextBridge.title")}
            description={t("paratextBridge.description")}
            actions={
              d.supported ? (
                <>
                  <Button variant="outline" size="sm" onClick={addFolder}><FolderPlus />{t("paratextBridge.addFolder")}</Button>
                  <Button variant="outline" size="sm" onClick={() => void d.refresh()} disabled={d.loading}><RefreshCw />{t("paratextBridge.rescan")}</Button>
                </>
              ) : null
            }
          />
          {!d.supported ? (
            <section className="max-w-prose space-y-4" data-testid="paratext-browser-explainer">
              <h2 className="text-base font-semibold">{t("paratextBridge.browser.title")}</h2>
              <p className="text-sm text-muted-foreground">{t("paratextBridge.browser.body")}</p>
              <h3 className="text-sm font-medium">{t("paratextBridge.browser.howItWorks")}</h3>
              <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground">
                <li>{t("paratextBridge.browser.point1")}</li>
                <li>{t("paratextBridge.browser.point2")}</li>
                <li>{t("paratextBridge.browser.point3")}</li>
              </ul>
              <p className="text-sm text-muted-foreground">{t("paratextBridge.notDesktop")}</p>
              <Button variant="outline" size="sm" nativeButton={false} render={<a href={PARATEXT_DOCS_URL} target="_blank" rel="noreferrer" />}>
                <BookOpen />{t("paratextBridge.browser.docs")}
              </Button>
            </section>
          ) : d.loading && !d.discovery ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("paratextBridge.scanning")}</div>
          ) : (
            <div className="space-y-8">
              {d.discovery ? (
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <Badge variant={d.discovery.paratextRunning ? "default" : "outline"}>
                    {d.discovery.paratextRunning ? t("paratextBridge.paratextRunning") : t("paratextBridge.paratextNotRunning")}
                  </Badge>
                  <span>
                    {d.discovery.registeredUser
                      ? t("paratextBridge.registeredAs", { name: d.discovery.registeredUser.name })
                      : t("paratextBridge.notRegistered")}
                  </span>
                </div>
              ) : null}
              {d.error ? <p className="text-sm text-destructive">{d.error}</p> : null}

              {d.projects.length === 0 ? (
                <EmptyState icon={BookOpen} title={t("paratextBridge.noProjects")} description={t("paratextBridge.noProjectsHint")} />
              ) : (
                <div className="space-y-3">
                {d.projects.length > 5 ? (
                  <div className="relative max-w-xs">
                    <Search className="pointer-events-none absolute start-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
                    <Input className="ps-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("paratextBridge.project.search")} aria-label={t("paratextBridge.project.search")} data-testid="paratext-project-search" />
                  </div>
                ) : null}
                <ul className="divide-y rounded-lg border bg-card" data-testid="paratext-project-list">
                  {shown.map((p) => <ParatextProjectRow key={p.path} project={p} linked={linked.has(p.guid)} />)}
                </ul>
                </div>
              )}

              {d.discovery && d.discovery.roots.length > 0 ? (
                <section className="space-y-2">
                  <h2 className="text-sm font-medium text-muted-foreground">{t("paratextBridge.roots")}</h2>
                  <ul className="space-y-1 text-sm">
                    {d.discovery.roots.map((r) => (
                      <li key={r.path} className="flex items-center gap-2">
                        <code className="truncate text-xs">{r.path}</code>
                        <span className="text-muted-foreground">{t(`paratextBridge.rootSource.${r.source}`)}</span>
                        {r.source === "user" ? (
                          <Button variant="ghost" size="icon-sm" aria-label={t("paratextBridge.removeFolder")} onClick={() => void d.removeRoot(r.path)}><X /></Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          )}
        </Page>
      }
    />
  )
}
