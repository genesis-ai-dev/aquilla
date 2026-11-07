import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router-dom"
import { ExternalLink, FolderOpen, RefreshCw } from "lucide-react"
import { AppShell } from "@/components/AppShell"
import { ThisComputerSidebar } from "@/components/this-computer/ThisComputerSidebar"
import { ThisComputerBreadcrumb } from "@/components/this-computer/ThisComputerBreadcrumb"
import { PARATEXT_PATH } from "@/components/this-computer/routes"
import { Page } from "@/components/ui/page"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { StatBar, StatTile } from "@/components/progress/StatTiles"
import { useT } from "@/lib/i18n/I18nProvider"
import { useParatextDiscovery, type BridgeProject } from "@/lib/paratext-bridge/use-paratext-discovery"
import { useParatextProgress, type BookProgress, type BookStatus } from "@/lib/paratext-bridge/use-paratext-progress"
import { bridgeStore, type MirrorLink } from "@/lib/paratext-bridge/store"
import type { UserAccess } from "@/lib/paratext-bridge/access"
import { getBookName } from "@/lib/file-labeling/bible-book-names"

const STATUSES: BookStatus[] = ["not-started", "in-progress", "complete"]

function bookPath(project: BridgeProject, fileName: string): string {
  return `/paratext/book?${new URLSearchParams({ project: project.path, file: fileName }).toString()}`
}

/** Where "Open project" goes: a mirrored project's editor, else the import flow. */
function openTarget(project: BridgeProject, link: MirrorLink | null): string {
  if (link) {
    const first = project.books.map((b) => link.books[b.code]?.fileId).find(Boolean)
    return first ? `/project/${link.projectId}/editor/file/${first}` : `/project/${link.projectId}/editor`
  }
  return `/paratext/open?${new URLSearchParams({ project: project.path }).toString()}`
}

function Card({ title, hint, children, testId }: { title: string; hint?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-lg border bg-card p-5" data-testid={testId}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  )
}

function TeamRow({ user, t }: { user: UserAccess; t: ReturnType<typeof useT> }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="truncate font-medium">{user.userName}</span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
        {user.allBooks ? t("paratextBridge.project.allBooks") : t("paratextBridge.project.someBooks", { count: user.books.length })}
        <Badge variant="outline">{user.role}</Badge>
      </span>
    </li>
  )
}

/** One Paratext project on this computer, laid out like a cloud project's
 *  overview: a header card, a progress card, the work (books by status), the
 *  team, and what is specific to a project that lives in a folder. */
export function ParatextProjectPage() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const projectPath = params.get("project")
  const d = useParatextDiscovery()
  const project = useMemo(() => d.projects.find((p) => p.path === projectPath) ?? null, [d.projects, projectPath])
  const progress = useParatextProgress(project)
  const [link, setLink] = useState<MirrorLink | null>(null)
  const guid = project?.guid ?? null

  useEffect(() => {
    if (!guid) return
    let cancelled = false
    void bridgeStore.link(guid).then((l) => { if (!cancelled) setLink(l) }).catch(() => undefined)
    return () => { cancelled = true }
  }, [guid])

  const byStatus = useMemo(() => {
    const out: Record<BookStatus, BookProgress[]> = { "not-started": [], "in-progress": [], complete: [] }
    for (const b of progress?.books ?? []) out[b.status].push(b)
    return out
  }, [progress])

  const title = project?.settings.fullName || project?.settings.name || ""
  const language = project?.settings.language || ""
  const canOpen = !!project && project.utf8 && project.books.length > 0

  const copyPath = async () => {
    if (!project) return
    try {
      await navigator.clipboard.writeText(project.path)
      toast.add({ type: "success", title: t("paratextBridge.project.copied") })
    } catch { /* clipboard unavailable: the path is on screen */ }
  }

  let body: React.ReactNode
  if (!d.supported) {
    body = <p className="text-sm text-muted-foreground">{t("paratextBridge.notDesktop")}</p>
  } else if (d.loading && !d.discovery) {
    body = <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("paratextBridge.scanning")}</div>
  } else if (!project) {
    body = <p className="text-sm text-muted-foreground" data-testid="paratext-project-missing">{d.error ?? t("paratextBridge.project.notFound")}</p>
  } else {
    body = (
      <div className="max-w-5xl space-y-4">
        <div className="rounded-lg border bg-card p-6" data-testid="paratext-project-header">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="truncate text-xl font-semibold leading-tight">{title}</h1>
                <Badge variant="outline">{project.settings.name}</Badge>
                <Badge variant="secondary">{t("paratextBridge.project.onThisComputer")}</Badge>
                <Badge variant={link ? "default" : "outline"} data-testid="paratext-link-badge">
                  {link ? t("paratextBridge.project.inAquilla") : t("paratextBridge.project.notInAquilla")}
                </Badge>
                {d.discovery ? (
                  <Badge variant="outline">
                    {d.discovery.paratextRunning ? t("paratextBridge.paratextRunning") : t("paratextBridge.paratextNotRunning")}
                  </Badge>
                ) : null}
              </div>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {[language, t("paratextBridge.booksCount", { count: project.books.length })].filter(Boolean).join(" · ")}
              </p>
              {d.discovery ? (
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {d.discovery.registeredUser
                    ? t("paratextBridge.registeredAs", { name: d.discovery.registeredUser.name })
                    : t("paratextBridge.notRegistered")}
                </p>
              ) : null}
              {!project.utf8 ? <p className="mt-2 text-sm text-destructive">{t("paratextBridge.notUtf8")}</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button disabled={!canOpen} data-testid="paratext-open-in-aquilla" onClick={() => navigate(openTarget(project, link))}>
                <ExternalLink />{t("paratextBridge.project.open")}
              </Button>
              <Button variant="outline" size="icon-sm" aria-label={t("paratextBridge.rescan")} disabled={d.loading} onClick={() => void d.refresh()}>
                <RefreshCw />
              </Button>
            </div>
          </div>
        </div>

        <Card title={t("paratextBridge.project.progress")} testId="paratext-progress-card">
          {!project.utf8 ? null : !progress ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("paratextBridge.project.reading")}</div>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap gap-3">
                <StatTile label={t("paratextBridge.project.versesWritten")} pct={progress.verses ? progress.written / progress.verses : 0} tone="textTranslated" />
                <StatTile label={t("paratextBridge.project.booksStarted")} pct={progress.books.length ? (progress.books.length - byStatus["not-started"].length) / progress.books.length : 0} tone="textAi" />
                <StatTile label={t("paratextBridge.project.booksComplete")} pct={progress.books.length ? byStatus.complete.length / progress.books.length : 0} tone="textValidated" />
              </div>
              <div className="space-y-2">
                <StatBar label={t("paratextBridge.project.versesWritten")} value={progress.written} total={progress.verses} tone="textTranslated" />
                <StatBar label={t("paratextBridge.project.booksStarted")} value={progress.books.length - byStatus["not-started"].length} total={progress.books.length} tone="textAi" />
                <StatBar label={t("paratextBridge.project.booksComplete")} value={byStatus.complete.length} total={progress.books.length} tone="textValidated" />
              </div>
            </>
          )}
        </Card>

        <Card title={t("paratextBridge.project.books")} testId="paratext-books-card">
          {!project.utf8 ? null : !progress ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />{t("paratextBridge.project.reading")}</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-3">
              {STATUSES.map((status) => (
                <div key={status} data-testid={`paratext-books-${status}`}>
                  <h3 className="mb-2 text-xs font-medium text-muted-foreground">
                    {t(`paratextBridge.project.status.${status}`)} · {byStatus[status].length}
                  </h3>
                  <ul className="space-y-1">
                    {byStatus[status].map((b) => (
                      <li key={b.fileName}>
                        <Link
                          to={bookPath(project, b.fileName)}
                          className="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent"
                          title={b.unreadable ? t("paratextBridge.project.unreadable") : undefined}
                        >
                          <span className="truncate"><span className="font-mono text-xs text-muted-foreground">{b.code}</span> {getBookName(b.code) ?? b.code}</span>
                          {status === "in-progress" ? (
                            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                              {t("paratextBridge.project.versesOf", { written: b.written, total: b.verses })}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title={t("paratextBridge.project.team")} hint={t("paratextBridge.project.teamHint")} testId="paratext-team-card">
          {project.access && project.access.users.length > 0 ? (
            <ul className="divide-y">{project.access.users.map((u) => <TeamRow key={u.userName} user={u} t={t} />)}</ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("paratextBridge.project.noTeam")}</p>
          )}
        </Card>

        <Card title={t("paratextBridge.project.location")} hint={t("paratextBridge.project.sendReceive")} testId="paratext-location-card">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("paratextBridge.project.folder")}</span>
            <code className="min-w-0 flex-1 truncate text-xs">{project.path}</code>
            <Button variant="outline" size="sm" onClick={() => void copyPath()}><FolderOpen />{t("paratextBridge.project.reveal")}</Button>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <AppShell
      sidebar={<ThisComputerSidebar />}
      header={<ThisComputerBreadcrumb trail={[{ label: t("paratextBridge.title"), to: PARATEXT_PATH }, { label: title || t("paratextBridge.project.onThisComputer") }]} />}
      statusBar={null}
      main={<Page size="full">{body}</Page>}
    />
  )
}
