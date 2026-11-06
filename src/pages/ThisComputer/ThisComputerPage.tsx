import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { BookOpen, FolderPlus, FolderSearch, Laptop, RefreshCw, ShieldCheck, X } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ThisComputerSidebar } from "@/components/this-computer/ThisComputerSidebar"
import { PARATEXT_PATH } from "@/components/this-computer/routes"
import { ThisComputerBreadcrumb } from "@/components/this-computer/ThisComputerBreadcrumb"
import { Page, PageHeader, Section } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { useT } from "@/lib/i18n/I18nProvider"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { paratextTauri } from "@/lib/paratext-bridge/tauri"
import { useParatextDiscovery } from "@/lib/paratext-bridge/use-paratext-discovery"
import { setParatextScanReady, useParatextScanReady } from "@/lib/store/paratext-scan-pref"

const PARATEXT_DOCS_URL =
  `${(import.meta.env.VITE_DOCS_URL as string | undefined)?.trim() || "https://help.aquilla.app"}/projects/paratext-projects/`

/** Linked folders before any scan: `paratext_user_roots` reads only Aquilla's
 *  own roots file, never the folders, so the permission prep stays honest. */
function useLinkedFolders(supported: boolean) {
  const [folders, setFolders] = useState<string[] | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    if (!supported) return
    let cancelled = false
    paratextTauri.userRoots()
      .then((r) => { if (!cancelled) setFolders(r) })
      .catch(() => { if (!cancelled) setFolders([]) })
    return () => { cancelled = true }
  }, [supported, version])
  return { folders, reload }
}

/** Desktop-only workspace for what lives on this machine: linked folders and
 *  the Paratext projects found in them and in Paratext's usual locations. */
export function ThisComputerPage() {
  const t = useT()
  const supported = isTauriRuntime()
  const scanReady = useParatextScanReady()
  const d = useParatextDiscovery({ autoStart: supported && scanReady })
  const linked = useLinkedFolders(supported)

  // Discovery is the fresher source once it has run (add/remove go through it).
  const linkedFolders = d.discovery
    ? d.discovery.roots.filter((r) => r.source === "user").map((r) => r.path)
    : linked.folders

  // A scan that completed without error means any OS access prompt has been
  // answered, so the prep step is not shown again on this device.
  useEffect(() => {
    if (d.discovery && !d.error && !d.loading) setParatextScanReady(true)
  }, [d.discovery, d.error, d.loading])

  const linkFolder = async () => {
    const path = window.prompt(t("paratextBridge.addFolderPrompt"))
    if (!path?.trim()) return
    await d.addRoot(path.trim())
    linked.reload()
  }
  const unlinkFolder = async (path: string) => {
    await d.removeRoot(path)
    linked.reload()
  }

  return (
    <AppShell
      sidebar={<ThisComputerSidebar />}
      header={<ThisComputerBreadcrumb />}
      statusBar={null}
      main={
        <Page>
          <PageHeader title={t("paratextBridge.thisComputer.title")} description={t("paratextBridge.thisComputer.description")} />
          {!supported ? (
            <EmptyState
              icon={Laptop}
              title={t("paratextBridge.thisComputer.title")}
              description={t("paratextBridge.notDesktop")}
              action={
                <Button variant="outline" size="sm" nativeButton={false} render={<a href={PARATEXT_DOCS_URL} target="_blank" rel="noreferrer" />}>
                  <BookOpen />{t("paratextBridge.browser.docs")}
                </Button>
              }
            />
          ) : (
            <div className="space-y-6">
              <Section
                title={t("paratextBridge.thisComputer.linkedFolders")}
                description={t("paratextBridge.thisComputer.linkedFoldersHint")}
                action={<Button variant="outline" size="sm" onClick={() => void linkFolder()}><FolderPlus />{t("paratextBridge.thisComputer.linkFolder")}</Button>}
                data-testid="linked-folders"
              >
                {linkedFolders === null ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("common.loading")}</div>
                ) : linkedFolders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("paratextBridge.thisComputer.noLinkedFolders")}</p>
                ) : (
                  <ul className="space-y-1 text-sm">
                    {linkedFolders.map((path) => (
                      <li key={path} className="flex items-center gap-2" data-testid="linked-folder">
                        <code className="truncate text-xs">{path}</code>
                        <Button variant="ghost" size="icon-sm" aria-label={t("paratextBridge.thisComputer.unlinkFolder")} onClick={() => void unlinkFolder(path)}><X /></Button>
                      </li>
                    ))}
                  </ul>
                )}
              </Section>

              <Section
                title={t("paratextBridge.thisComputer.paratextSection")}
                action={
                  d.discovery || scanReady ? (
                    <Button variant="outline" size="sm" onClick={() => void d.refresh()} disabled={d.loading}><RefreshCw />{t("paratextBridge.rescan")}</Button>
                  ) : null
                }
                data-testid="paratext-section"
              >
                {!scanReady && !d.discovery && !d.loading ? (
                  <div className="space-y-3" data-testid="paratext-scan-prep">
                    <div className="flex items-start gap-3">
                      <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                      <div className="space-y-1 text-sm">
                        <p className="font-medium">{t("paratextBridge.thisComputer.prep.title")}</p>
                        <p className="text-muted-foreground">{t("paratextBridge.thisComputer.prep.body")}</p>
                        <p className="text-muted-foreground">{t("paratextBridge.thisComputer.prep.permission")}</p>
                        <p className="text-muted-foreground">{t("paratextBridge.thisComputer.prep.private")}</p>
                      </div>
                    </div>
                    {d.error ? <p className="text-sm text-destructive">{t("paratextBridge.thisComputer.scanFailed", { error: d.error })}</p> : null}
                    <Button onClick={() => void d.refresh()}><FolderSearch />{t("paratextBridge.thisComputer.find")}</Button>
                  </div>
                ) : d.loading && !d.discovery ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("paratextBridge.scanning")}</div>
                ) : (
                  <div className="space-y-4" data-testid="paratext-scan-results">
                    {d.error ? <p className="text-sm text-destructive">{t("paratextBridge.thisComputer.scanFailed", { error: d.error })}</p> : null}
                    {d.discovery ? (
                      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                        <span>{t("paratextBridge.thisComputer.found", { count: d.projects.length })}</span>
                        <Badge variant={d.discovery.paratextRunning ? "default" : "outline"}>
                          {d.discovery.paratextRunning ? t("paratextBridge.paratextRunning") : t("paratextBridge.paratextNotRunning")}
                        </Badge>
                        {d.discovery.registeredUser ? <span>{t("paratextBridge.registeredAs", { name: d.discovery.registeredUser.name })}</span> : null}
                      </div>
                    ) : null}
                    {d.projects.length === 0 && d.discovery ? (
                      <p className="text-sm text-muted-foreground">{t("paratextBridge.noProjectsHint")}</p>
                    ) : (
                      <ul className="divide-y rounded-md border">
                        {d.projects.map((p) => (
                          <li key={p.path} className="flex items-center gap-3 px-3 py-2 text-sm" data-testid="paratext-found-project">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="truncate font-medium">{p.settings.fullName}</span>
                                <Badge variant="outline">{p.settings.name}</Badge>
                              </div>
                              <div className="truncate text-xs text-muted-foreground">
                                {t("paratextBridge.booksCount", { count: p.books.length })} · <code>{p.path}</code>
                              </div>
                            </div>
                            <Button variant="outline" size="sm" nativeButton={false} render={<Link to={PARATEXT_PATH} />}>
                              {t("org.overviewLaneTable.openAction")}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {d.discovery && d.discovery.roots.length > 0 ? (
                      <div className="space-y-1">
                        <h3 className="text-xs font-medium text-muted-foreground">{t("paratextBridge.roots")}</h3>
                        <ul className="space-y-0.5 text-xs text-muted-foreground">
                          {d.discovery.roots.map((r) => (
                            <li key={r.path} className="flex items-center gap-2">
                              <code className="truncate">{r.path}</code>
                              <span>{t(`paratextBridge.rootSource.${r.source}`)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    <Button variant="outline" size="sm" nativeButton={false} render={<Link to={PARATEXT_PATH} />}>
                      <BookOpen />{t("paratextBridge.thisComputer.openAll")}
                    </Button>
                  </div>
                )}
              </Section>
            </div>
          )}
        </Page>
      }
    />
  )
}
