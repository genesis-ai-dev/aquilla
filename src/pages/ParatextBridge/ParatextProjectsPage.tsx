import { useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { BookOpen, ChevronRight, FolderPlus, RefreshCw, X } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ThisComputerSidebar } from "@/components/this-computer/ThisComputerSidebar"
import { ThisComputerBreadcrumb } from "@/components/this-computer/ThisComputerBreadcrumb"
import { Page, PageHeader } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { useParatextDiscovery, type BridgeProject } from "@/lib/paratext-bridge/use-paratext-discovery"
import { pickFolder } from "@/lib/paratext-bridge/tauri"
import { bridgeStore } from "@/lib/paratext-bridge/store"

const PARATEXT_DOCS_URL =
  `${(import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() || "https://help.aquilla.app"}/projects/paratext-projects/`

const paratextProjectPath = (project: BridgeProject) => `/paratext/project?${new URLSearchParams({ project: project.path }).toString()}`

/** GUIDs of the projects already mirrored into Aquilla. */
function useLinkedGuids(projects: readonly BridgeProject[]): Set<string> {
  const [guids, setGuids] = useState<Set<string>>(new Set())
  const key = projects.map((p) => p.guid).join("|")
  useEffect(() => {
    let cancelled = false
    void Promise.all(projects.map(async (p) => ((await bridgeStore.link(p.guid).catch(() => null)) ? p.guid : null)))
      .then((found) => { if (!cancelled) setGuids(new Set(found.filter((g): g is string => !!g))) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return guids
}

/** Desktop-only: Paratext projects found on this computer. One click opens a
 *  book; edits are written straight into the Paratext project folder. */
export function ParatextProjectsPage() {
  const t = useT()
  const d = useParatextDiscovery()
  const linked = useLinkedGuids(d.projects)

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
                <ul className="divide-y rounded-lg border bg-card" data-testid="paratext-project-list">
                  {d.projects.map((p) => (
                    <li key={p.path} data-testid="paratext-project">
                      <Link to={paratextProjectPath(p)} className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50">
                        <BookOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{p.settings.fullName}</span>
                            <Badge variant="outline">{p.settings.name}</Badge>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {t("paratextBridge.booksCount", { count: p.books.length })}
                            {p.settings.language ? ` · ${p.settings.language}` : ""}
                            {!p.utf8 ? ` · ${t("paratextBridge.notUtf8")}` : ""}
                          </div>
                        </div>
                        <Badge variant={linked.has(p.guid) ? "default" : "outline"}>
                          {linked.has(p.guid) ? t("paratextBridge.project.inAquilla") : t("paratextBridge.project.notInAquilla")}
                        </Badge>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      </Link>
                    </li>
                  ))}
                </ul>
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
