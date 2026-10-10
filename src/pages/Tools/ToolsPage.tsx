/**
 * /project/:id/extensions — Smart Extensions.
 *
 * One prompt box to build a tool; starters one click away; installed
 * extensions as quiet rows with everything secondary (permissions, activity
 * and revert, copy, code review, remove) behind a "…" menu.
 */

import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, ArrowUpRight, Blocks, CircleHelp, LayoutGrid, PanelLeft, PenLine, Plus, ShieldCheck, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { AppTooltip } from "@/components/ui/tooltip"
import { OverflowMenu, type OverflowMenuItem } from "@/components/OverflowMenu"
import { BuildToolCard, type BuiltTool } from "@/components/tools/BuildToolCard"
import { ActivityDialog, CopyDialog, PermissionsDialog, ReviewCodeDialog, useScopeSentence } from "@/components/tools/ExtensionDialogs"
import { useToolsMount } from "@/components/tools/ToolsMountContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProject } from "@/hooks/useProject"
import { useT } from "@/lib/i18n/I18nProvider"
import { grantableAtInstall } from "@/lib/tools/permissions"
import { STARTER_EXTENSIONS } from "@/lib/tools/starters"
import { installTool, listTools, removeTool, setToolGrant, type SaveToolInput, type ToolSummary } from "@/lib/tools/tools-api"
import { cn } from "@/lib/utils"
import type { ToolManifest, ToolMount, ToolScope } from "../../../shared/tools/manifest"

interface Candidate {
  input: Omit<SaveToolInput, "grant">
  manifest: ToolManifest
}

type Sheet = { kind: "permissions" | "activity" | "copy" | "review"; toolId: string } | null

/** The one icon that says where an extension lives. */
function ExtIcon({ mounts, className }: { mounts: readonly ToolMount[]; className?: string }) {
  return (
    <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg border bg-muted/40 text-muted-foreground", className)}>
      {mounts.includes("editor") ? (
        <PenLine className="size-4" aria-hidden />
      ) : mounts.includes("panel") || mounts.includes("inline") ? (
        <PanelLeft className="size-4" aria-hidden />
      ) : (
        <LayoutGrid className="size-4" aria-hidden />
      )}
    </span>
  )
}

export function ToolsPage() {
  const t = useT()
  const navigate = useNavigate()
  const sentence = useScopeSentence()
  const { id: projectId = "" } = useParams<{ id: string }>()
  const { session } = useFrontierSession()
  const { project, roleLevel } = useProject(projectId)
  const [tools, setTools] = useState<ToolSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)
  const [sheet, setSheet] = useState<Sheet>(null)
  const jwt = session?.jwt ?? null
  const mounts = useToolsMount()

  const refresh = useCallback(async () => {
    if (!jwt || !projectId) return
    try {
      setTools(await listTools(jwt, projectId))
      setError(null)
      mounts?.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mounts.refresh is stable per project
  }, [jwt, projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const where = (m: ToolMount): string =>
    m === "editor" ? t("extensions.where.editor") : m === "panel" ? t("extensions.where.panel") : m === "inline" ? t("extensions.where.inline") : t("extensions.where.page")

  /** One-click install: reads are granted now, writes ask the first time. */
  const install = async (c: Candidate) => {
    if (!jwt) return
    setInstalling(c.manifest.name)
    try {
      const grant = grantableAtInstall(c.manifest.scopes, roleLevel ?? null).grantable.filter((s) => s.startsWith("read:"))
      const tool = await installTool(jwt, projectId, { ...c.input, grant })
      setCandidate(null)
      await refresh()
      navigate(tool.manifest.mounts.includes("editor") ? `/project/${projectId}/editor` : `/project/${projectId}/extensions/${tool.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(null)
    }
  }

  const onBuilt = ({ request, result }: BuiltTool) => {
    if (!result.ok || !result.source || !result.manifest) return
    setCandidate({
      manifest: result.manifest,
      input: {
        source: result.source,
        manifest: result.manifest,
        origin: "builder",
        buildMeta: { request, model: result.model, attempts: result.attempts, cost: result.cost },
      },
    })
  }

  const setGrant = async (tool: ToolSummary, scopes: ToolScope[]) => {
    if (!jwt) return
    await setToolGrant(jwt, projectId, tool.id, scopes)
    await refresh()
  }

  const remove = async (tool: ToolSummary) => {
    if (!jwt) return
    await removeTool(jwt, projectId, tool.id)
    await refresh()
  }

  if (!session) return <Spinner className="m-8" />
  const sheetTool = sheet ? tools?.find((x) => x.id === sheet.toolId) ?? null : null

  const menuFor = (tool: ToolSummary): OverflowMenuItem[] => [
    { id: "permissions", label: t("extensions.menu.permissions"), onClick: () => setSheet({ kind: "permissions", toolId: tool.id }), testId: "tool-menu-permissions" },
    { id: "activity", label: t("extensions.activity.heading"), onClick: () => setSheet({ kind: "activity", toolId: tool.id }), testId: "tool-menu-activity" },
    ...(tool.manifest.mounts.includes("panel") && mounts
      ? [{ id: "pin", label: mounts.pinned.includes(tool.id) ? t("extensions.unpin") : t("extensions.pin"), onClick: () => mounts.togglePin(tool.id) }]
      : []),
    { id: "copy", label: t("extensions.copy.pick"), onClick: () => setSheet({ kind: "copy", toolId: tool.id }) },
    ...(tool.upstreamToolId ? [{ id: "review", label: t("extensions.review.button"), onClick: () => setSheet({ kind: "review", toolId: tool.id }) }] : []),
    { id: "sep", type: "separator" as const },
    { id: "remove", label: t("extensions.remove"), destructive: true, onClick: () => void remove(tool), testId: "tool-menu-remove" },
  ]

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label={t("extensions.backToEditor")} render={<Link to={`/project/${projectId}/editor`} />}>
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <h1 className="flex min-w-0 items-baseline gap-2 text-lg font-semibold tracking-tight">
            {t("extensions.title")}
            {project && <span className="truncate text-sm font-normal text-muted-foreground">{project.name}</span>}
          </h1>
          <Popover>
            <PopoverTrigger
              render={
                <Button variant="ghost" size="sm" className="ms-auto gap-1.5 text-muted-foreground">
                  <CircleHelp className="size-3.5" aria-hidden />
                  <span className="hidden sm:inline">{t("extensions.how.title")}</span>
                </Button>
              }
            />
            <PopoverContent align="end" className="w-80 p-4 text-sm">
              <ul className="space-y-2 text-muted-foreground">
                <li>{t("extensions.how.sandbox")}</li>
                <li>{t("extensions.how.permissions")}</li>
                <li>{t("extensions.how.revert")}</li>
              </ul>
            </PopoverContent>
          </Popover>
        </div>
        <p className="ps-9 text-sm text-muted-foreground">{t("extensions.subtitle")}</p>
      </header>

      {error && (
        <p role="alert" className="flex items-center gap-2 rounded-lg bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <Button size="icon-xs" variant="ghost" aria-label={t("common.dismiss")} onClick={() => setError(null)}>
            <X className="size-3.5" />
          </Button>
        </p>
      )}

      <div className="flex flex-col gap-3">
        {jwt && <BuildToolCard projectId={projectId} jwt={jwt} onBuilt={onBuilt} />}

        {candidate && (
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 sm:flex-row sm:items-center" data-testid="built-candidate">
            <ExtIcon mounts={candidate.manifest.mounts} />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{t("extensions.ready.title", { name: candidate.manifest.name })}</p>
              <p className="line-clamp-2 text-sm text-muted-foreground">{candidate.manifest.description}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {candidate.manifest.scopes.map(sentence).join(" · ")}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setCandidate(null)} disabled={installing !== null}>
                {t("extensions.ready.discard")}
              </Button>
              <Button size="sm" onClick={() => void install(candidate)} disabled={installing !== null}>
                {installing === candidate.manifest.name && <Spinner className="size-3.5" />}
                {t("extensions.install")}
              </Button>
            </div>
          </div>
        )}

        <section aria-label={t("extensions.starters.heading")} className="mt-1">
          <h2 className="mb-2 text-xs font-medium text-muted-foreground">{t("extensions.starters.heading")}</h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {STARTER_EXTENSIONS.map((s) => {
              const busy = installing === s.manifest.name
              return (
                <button
                  key={s.manifest.name}
                  type="button"
                  aria-label={`${t("extensions.install")}: ${s.manifest.name}`}
                  disabled={installing !== null}
                  onClick={() => void install({ manifest: s.manifest, input: { source: s.source, manifest: s.manifest, origin: "starter" } })}
                  className="group flex w-full min-w-0 items-center gap-3 rounded-xl border bg-card p-3 text-start transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none disabled:opacity-60"
                >
                  <ExtIcon mounts={s.manifest.mounts} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{s.manifest.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{s.manifest.description}</span>
                  </span>
                  {busy ? <Spinner className="size-4" /> : <Plus className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />}
                </button>
              )
            })}
          </div>
        </section>
      </div>

      <section aria-label={t("extensions.installed.heading")}>
        <h2 className="mb-2 text-xs font-medium text-muted-foreground">{t("extensions.installed.heading")}</h2>
        {tools === null ? (
          <Spinner />
        ) : tools.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            <Blocks className="size-5" aria-hidden />
            {t("extensions.installed.empty")}
          </div>
        ) : (
          <ul className="divide-y rounded-xl border bg-card">
            {tools.map((tool) => (
              <li key={tool.id} className="flex items-center gap-3 px-3 py-2.5" data-testid="installed-tool" data-tool-name={tool.name}>
                <ExtIcon mounts={tool.manifest.mounts} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <Link to={`/project/${projectId}/extensions/${tool.id}`} className="truncate text-sm font-medium hover:underline">
                      {tool.name}
                    </Link>
                    {tool.firstParty && (
                      <AppTooltip content={t("extensions.firstParty.badge")}>
                        <span data-testid="first-party-badge" aria-label={t("extensions.firstParty.badge")} className="inline-flex">
                          <ShieldCheck className="size-3.5 text-emerald-600" aria-hidden />
                        </span>
                      </AppTooltip>
                    )}
                    {tool.upstreamToolId && (
                      <span className="rounded bg-amber-500/10 px-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">{t("extensions.review.badgeShort")}</span>
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {tool.manifest.mounts.filter((m) => m !== "page" || tool.manifest.mounts.length === 1).map(where).join(" · ")}
                    <span className="hidden sm:inline"> · {t("extensions.version", { version: tool.currentVersion })}</span>
                  </p>
                </div>
                <AppTooltip content={t("extensions.open")}>
                  <Button size="icon-sm" variant="ghost" aria-label={`${t("extensions.open")}: ${tool.name}`} render={<Link to={`/project/${projectId}/extensions/${tool.id}`} />}>
                    <ArrowUpRight className="size-4" aria-hidden />
                  </Button>
                </AppTooltip>
                <OverflowMenu items={menuFor(tool)} ariaLabel={t("extensions.menu.label", { name: tool.name })} triggerSize="icon-sm" testId="tool-menu" />
              </li>
            ))}
          </ul>
        )}
      </section>

      {sheet && sheetTool && jwt && sheet.kind === "permissions" && (
        <PermissionsDialog tool={sheetTool} roleLevel={roleLevel ?? null} onChange={(scopes) => setGrant(sheetTool, scopes)} onClose={() => setSheet(null)} />
      )}
      {sheet && sheetTool && jwt && sheet.kind === "activity" && (
        <ActivityDialog projectId={projectId} tool={sheetTool} jwt={jwt} author={session.username} onClose={() => setSheet(null)} />
      )}
      {sheet && sheetTool && jwt && sheet.kind === "copy" && <CopyDialog projectId={projectId} tool={sheetTool} jwt={jwt} onClose={() => setSheet(null)} />}
      {sheet && sheetTool && jwt && sheet.kind === "review" && <ReviewCodeDialog projectId={projectId} tool={sheetTool} jwt={jwt} onClose={() => setSheet(null)} />}
    </div>
  )
}
