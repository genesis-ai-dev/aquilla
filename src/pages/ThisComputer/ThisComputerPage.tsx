import { useCallback, useEffect, useMemo, useState } from "react"
import { Link } from "react-router-dom"
import { BookOpen, Folder, FolderPlus, FolderSearch, Laptop, RefreshCw, ShieldCheck, X } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ParatextProjectRow, useLinkedProjects } from "@/components/paratext/ParatextProjectRow"
import { ThisComputerSidebar } from "@/components/this-computer/ThisComputerSidebar"
import { PARATEXT_PATH } from "@/components/this-computer/routes"
import { ThisComputerBreadcrumb } from "@/components/this-computer/ThisComputerBreadcrumb"
import { Page, PageHeader, Section } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { useT } from "@/lib/i18n/I18nProvider"
import type { MessageKey } from "@/lib/i18n/messages/en"
import { isTauriRuntime } from "@/lib/offline/is-tauri"
import { paratextTauri, pickFolder, type RootSource } from "@/lib/paratext-bridge/tauri"
import { useParatextDiscovery, type BridgeProject } from "@/lib/paratext-bridge/use-paratext-discovery"
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

interface FolderRow {
  path: string
  source: RootSource
  projects: BridgeProject[]
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") || root.endsWith("\\") ? root : root + (root.includes("\\") ? "\\" : "/"))

/** One row per folder Aquilla looks in (yours first, then Paratext's own
 *  locations), each with the projects found inside it. */
function groupByFolder(roots: readonly { path: string; source: RootSource }[], projects: readonly BridgeProject[]): { rows: FolderRow[]; other: BridgeProject[] } {
  // Longest root first so a project lands in the most specific folder.
  const ordered = [...roots].sort((a, b) => b.path.length - a.path.length)
  const byRoot = new Map<string, BridgeProject[]>(roots.map((r) => [r.path, []]))
  const other: BridgeProject[] = []
  for (const p of projects) {
    const root = ordered.find((r) => under(p.path, r.path))
    if (root) byRoot.get(root.path)!.push(p)
    else other.push(p)
  }
  const rank = (s: RootSource) => (s === "user" ? 0 : s === "registry" ? 1 : s === "wine" ? 2 : 3)
  const rows = [...roots]
    .sort((a, b) => rank(a.source) - rank(b.source) || a.path.localeCompare(b.path))
    .map((r) => ({ path: r.path, source: r.source, projects: byRoot.get(r.path) ?? [] }))
  return { rows, other }
}

/** Desktop-only workspace for what lives on this machine: a folder list, each
 *  folder with the Paratext projects found in it. Folders are added with the
 *  OS folder picker; Paratext's own locations appear once the first scan ran. */
export function ThisComputerPage() {
  const t = useT()
  const supported = isTauriRuntime()
  const scanReady = useParatextScanReady()
  const d = useParatextDiscovery({ autoStart: supported && scanReady })
  const linked = useLinkedFolders(supported)
  const linkedProjects = useLinkedProjects(d.projects)
  const [picking, setPicking] = useState(false)

  // A scan that completed without error means any OS access prompt has been
  // answered, so the prep step is not shown again on this device.
  useEffect(() => {
    if (d.discovery && !d.error && !d.loading) setParatextScanReady(true)
  }, [d.discovery, d.error, d.loading])

  // Before the first scan only the user's own folders are known (unsearched);
  // after it, discovery is the fresher source (add/remove go through it).
  const { rows, other } = useMemo(() => {
    if (d.discovery) return groupByFolder(d.discovery.roots, d.projects)
    return { rows: (linked.folders ?? []).map((path) => ({ path, source: "user" as const, projects: [] })), other: [] }
  }, [d.discovery, d.projects, linked.folders])

  const addFolder = async () => {
    setPicking(true)
    try {
      const path = await pickFolder(t("paratextBridge.thisComputer.pickFolderTitle"))
      if (!path) return
      await d.addRoot(path)
      linked.reload()
    } catch (e) {
      toast.add({ type: "error", title: e instanceof Error ? e.message : String(e) })
    } finally {
      setPicking(false)
    }
  }
  const removeFolder = async (path: string) => {
    await d.removeRoot(path)
    linked.reload()
  }

  const projectRow = (p: BridgeProject) => (
    <ParatextProjectRow key={p.path} project={p} linked={linkedProjects.has(p.stateId)} testId="paratext-found-project" />
  )

  return (
    <AppShell
      sidebar={<ThisComputerSidebar />}
      header={<ThisComputerBreadcrumb />}
      statusBar={null}
      main={
        <Page>
          <PageHeader
            title={t("paratextBridge.thisComputer.title")}
            description={t("paratextBridge.thisComputer.description")}
            actions={
              supported ? (
                <>
                  {d.discovery || scanReady ? (
                    <Button variant="outline" size="sm" onClick={() => void d.refresh()} disabled={d.loading}><RefreshCw />{t("paratextBridge.rescan")}</Button>
                  ) : null}
                  <Button size="sm" onClick={() => void addFolder()} disabled={picking} data-testid="add-folder">
                    {picking ? <Spinner /> : <FolderPlus />}{t("paratextBridge.thisComputer.addFolder")}
                  </Button>
                </>
              ) : null
            }
          />
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
              {!scanReady && !d.discovery && !d.loading ? (
                <div className="space-y-3 rounded-md border border-border bg-muted/30 p-4" data-testid="paratext-scan-prep">
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
              ) : null}

              <Section
                title={t("paratextBridge.thisComputer.folders")}
                description={t("paratextBridge.thisComputer.foldersHint")}
                data-testid="linked-folders"
              >
                {d.error && d.discovery ? <p className="mb-2 text-sm text-destructive">{t("paratextBridge.thisComputer.scanFailed", { error: d.error })}</p> : null}
                {d.discovery ? (
                  <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground" data-testid="paratext-scan-results">
                    <span>{t("paratextBridge.thisComputer.found", { count: d.projects.length })}</span>
                    <Badge variant={d.discovery.paratextRunning ? "default" : "outline"}>
                      {d.discovery.paratextRunning ? t("paratextBridge.paratextRunning") : t("paratextBridge.paratextNotRunning")}
                    </Badge>
                    {d.discovery.registeredUser ? <span>{t("paratextBridge.registeredAs", { name: d.discovery.registeredUser.name })}</span> : null}
                  </div>
                ) : d.loading ? (
                  <div className="mb-3 flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("paratextBridge.scanning")}</div>
                ) : null}

                {linked.folders === null && !d.discovery ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("common.loading")}</div>
                ) : rows.length === 0 && other.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("paratextBridge.thisComputer.noLinkedFolders")}</p>
                ) : (
                  <ul className="divide-y rounded-md border">
                    {rows.map((row) => (
                      <li key={row.path} className="px-3 py-2" data-testid={row.source === "user" ? "linked-folder" : "discovered-folder"}>
                        <div className="flex items-center gap-2 text-sm">
                          <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <code className="min-w-0 flex-1 truncate text-xs" title={row.path}>{row.path}</code>
                          <Badge variant="outline">{t(`paratextBridge.rootSource.${row.source}` as MessageKey)}</Badge>
                          {row.source === "user" ? (
                            <Button variant="ghost" size="icon-sm" aria-label={t("paratextBridge.thisComputer.unlinkFolder")} onClick={() => void removeFolder(row.path)}><X /></Button>
                          ) : null}
                        </div>
                        {row.projects.length > 0 ? (
                          <ul className="ms-6 mt-1 divide-y">{row.projects.map(projectRow)}</ul>
                        ) : (
                          <p className="ms-6 mt-1 text-xs text-muted-foreground">
                            {d.discovery ? t("paratextBridge.thisComputer.noProjectsInFolder") : t("paratextBridge.thisComputer.notSearched")}
                          </p>
                        )}
                      </li>
                    ))}
                    {other.length > 0 ? (
                      <li className="px-3 py-2">
                        <div className="text-sm font-medium">{t("paratextBridge.thisComputer.otherProjects")}</div>
                        <ul className="ms-6 mt-1 divide-y">{other.map(projectRow)}</ul>
                      </li>
                    ) : null}
                  </ul>
                )}
                {d.discovery && d.projects.length === 0 ? (
                  <p className="mt-3 text-sm text-muted-foreground">{t("paratextBridge.noProjectsHint")}</p>
                ) : null}
              </Section>

              {d.discovery && d.projects.length > 0 ? (
                <Button variant="outline" size="sm" nativeButton={false} render={<Link to={PARATEXT_PATH} />}>
                  <BookOpen />{t("paratextBridge.thisComputer.openAll")}
                </Button>
              ) : null}
            </div>
          )}
        </Page>
      }
    />
  )
}
