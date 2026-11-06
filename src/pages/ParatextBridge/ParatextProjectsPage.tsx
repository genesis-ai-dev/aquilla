import { useNavigate } from "react-router-dom"
import { BookOpen, FolderPlus, RefreshCw, X } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ThisComputerSidebar } from "@/components/this-computer/ThisComputerSidebar"
import { ThisComputerBreadcrumb } from "@/components/this-computer/ThisComputerBreadcrumb"
import { Page, PageHeader } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { EmptyState } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { useParatextDiscovery, type BridgeProject } from "@/lib/paratext-bridge/use-paratext-discovery"
import { pickFolder } from "@/lib/paratext-bridge/tauri"
import { getBookName } from "@/lib/file-labeling/bible-book-names"

const PARATEXT_DOCS_URL =
  `${(import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() || "https://help.aquilla.app"}/projects/paratext-projects/`

function paratextBookPath(project: BridgeProject, fileName: string): string {
  const q = new URLSearchParams({ project: project.path, file: fileName })
  return `/paratext/book?${q.toString()}`
}

/** Desktop-only: Paratext projects found on this computer. One click opens a
 *  book; edits are written straight into the Paratext project folder. */
export function ParatextProjectsPage() {
  const t = useT()
  const navigate = useNavigate()
  const d = useParatextDiscovery()

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
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {d.projects.map((p) => (
                    <Card key={p.path} data-testid="paratext-project">
                      <CardHeader>
                        <CardTitle className="flex items-center justify-between gap-2">
                          <span className="truncate">{p.settings.fullName}</span>
                          <Badge variant="outline">{p.settings.name}</Badge>
                        </CardTitle>
                        <CardDescription>
                          {t("paratextBridge.booksCount", { count: p.books.length })}
                          {p.settings.language ? ` · ${p.settings.language}` : ""}
                          {!p.utf8 ? ` · ${t("paratextBridge.notUtf8")}` : ""}
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <div className="flex flex-wrap gap-1">
                          {p.books.map((b) => (
                            <Button
                              key={b.fileName}
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 font-mono text-xs"
                              title={getBookName(b.code) ?? b.code}
                              disabled={!p.utf8}
                              onClick={() => navigate(paratextBookPath(p, b.fileName))}
                            >
                              {b.code}
                            </Button>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
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
