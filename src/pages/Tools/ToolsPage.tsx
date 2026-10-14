/**
 * /project/:id/extensions — Smart Extensions.
 *
 * Prompt-first: one composer is the hero, and the page transforms in place —
 * composer → building → Try it (a live preview) → Add to project. A build runs
 * in the app-level build store (src/lib/tools/build-jobs.ts), so the user can
 * leave and come back; a toast says when it's ready. Templates open the same
 * review. Installed extensions sit below.
 */

import { ExtensionMarker } from "@/components/tools/ExtensionMarker"
import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom"
import { ArrowLeft, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { type OverflowMenuItem } from "@/components/OverflowMenu"
import { ActivityDialog, CopyDialog, PermissionsDialog, ReviewCodeDialog } from "@/components/tools/ExtensionDialogs"
import { BuilderStepper } from "@/components/tools/builder/BuilderStepper"
import { BuildFailureCard } from "@/components/tools/builder/BuildFailureCard"
import { BuildProgressCard } from "@/components/tools/builder/BuildProgressCard"
import { DescribeStep } from "@/components/tools/builder/DescribeStep"
import { InstalledList } from "@/components/tools/builder/InstalledList"
import { ShowDataFilesToggle } from "@/components/tools/ShowDataFilesToggle"
import { ReviewStep } from "@/components/tools/builder/ReviewStep"
import { StarterGallery } from "@/components/tools/builder/StarterGallery"
import { useToolsMount } from "@/components/tools/ToolsMountContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProject } from "@/hooks/useProject"
import { useT } from "@/lib/i18n/I18nProvider"
import { cancelBuild, clearJob, setCandidate, startBuild, useBuildState, watchBuilds, type BuildCandidate } from "@/lib/tools/build-jobs"
import { composeRequest, parseWhere, stepFor, type WhereChoice } from "@/lib/tools/builder-model"
import { grantableAtInstall } from "@/lib/tools/permissions"
import { installTool, listTools, removeTool, setToolGrant, type ToolSummary } from "@/lib/tools/tools-api"
import type { ToolScope } from "../../../shared/tools/manifest"

type Sheet = { kind: "permissions" | "activity" | "copy" | "review"; toolId: string } | null

export function ToolsPage() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { id: projectId = "" } = useParams<{ id: string }>()
  const { session } = useFrontierSession()
  const { project, roleLevel } = useProject(projectId)
  const jwt = session?.jwt ?? null
  const mounts = useToolsMount()
  const { job, candidate } = useBuildState(projectId)

  const [tools, setTools] = useState<ToolSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [request, setRequest] = useState(() => job?.words ?? "")
  const [where, setWhere] = useState<WhereChoice>(() => parseWhere(params.get("where")))
  const [adding, setAdding] = useState(false)
  const [sheet, setSheet] = useState<Sheet>(null)

  useEffect(() => watchBuilds(projectId), [projectId])

  const refresh = useCallback(async () => {
    if (!jwt || !projectId) return
    try {
      const next = await listTools(jwt, projectId)
      setTools(next)
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

  const running = job?.status === "running"
  const building = running && !job.change
  const changing = running && job.change

  const build = () => {
    const words = request.trim()
    if (!words || !jwt) return
    void startBuild(projectId, jwt, { words, request: composeRequest(words, where) })
  }

  /** Add to project: reads are granted now, anything else asks the first time. */
  const add = async (c: BuildCandidate) => {
    if (!jwt) return
    setAdding(true)
    try {
      // read:web asks the first time it is used, naming the site — never granted silently at install.
      const grant = grantableAtInstall(c.manifest.scopes, roleLevel ?? null).grantable.filter((s) => s.startsWith("read:") && s !== "read:web")
      const tool = await installTool(jwt, projectId, {
        source: c.source,
        manifest: c.manifest,
        origin: c.origin,
        ...(c.buildMeta ? { buildMeta: c.buildMeta } : {}),
        grant,
      })
      setCandidate(projectId, null)
      clearJob(projectId)
      setRequest("")
      await refresh()
      navigate(tool.manifest.mounts.includes("editor") ? `/project/${projectId}/editor` : `/project/${projectId}/extensions/${tool.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setAdding(false)
    }
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
    <div className="solid-primary mx-auto flex w-full max-w-3xl flex-col gap-12 px-4 pt-5 pb-16 sm:px-6">
      <header className="flex items-center gap-2">
        <Button variant="ghost" size="icon-sm" aria-label={t("extensions.backToEditor")} render={<Link to={`/project/${projectId}/editor`} />}>
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        <h1 className="flex min-w-0 items-baseline gap-2 text-sm font-semibold">
          <ExtensionMarker iconOnly className="self-center" />
          {t("extensions.title")}
          {project && <span className="truncate font-normal text-muted-foreground">{project.name}</span>}
        </h1>
        <div className="ms-auto">
          <BuilderStepper current={stepFor({ building, hasCandidate: candidate !== null })} />
        </div>
      </header>

      <main className="flex flex-col gap-4">
        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-xl bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <span className="min-w-0 flex-1">{error}</span>
            <Button size="icon-xs" variant="ghost" aria-label={t("common.dismiss")} onClick={() => setError(null)}>
              <X className="size-3.5" />
            </Button>
          </p>
        )}
        {candidate ? (
          <ReviewStep
            key={candidate.source}
            candidate={candidate}
            adding={adding}
            changing={changing}
            progress={
              changing && job ? (
                <BuildProgressCard compact request={job.words} phase={job.phase} startedAt={job.startedAt} onCancel={() => cancelBuild(projectId)} />
              ) : job?.status === "failed" ? (
                <BuildFailureCard failure={job.failure ?? ""} onEdit={() => clearJob(projectId)} onRetry={() => clearJob(projectId)} />
              ) : undefined
            }
            onAdd={() => void add(candidate)}
            onChange={(change) => jwt && void startBuild(projectId, jwt, { words: change, request: change, change: true })}
            onDiscard={() => {
              setCandidate(projectId, null)
              clearJob(projectId)
            }}
          />
        ) : building && job ? (
          <div className="flex flex-col items-center gap-5 pt-[52px]">
            <BuildProgressCard request={job.words} phase={job.phase} startedAt={job.startedAt} onCancel={() => cancelBuild(projectId)} />
          </div>
        ) : (
          <>
            <DescribeStep value={request} onChange={setRequest} where={where} onWhereChange={setWhere} onBuild={build} disabled={running} />
            {job?.status === "failed" && (
              <BuildFailureCard failure={job.failure ?? ""} onEdit={() => clearJob(projectId)} onRetry={build} />
            )}
          </>
        )}
      </main>

      {!candidate && !building && (
        <StarterGallery disabled={running} onPick={(s) => setCandidate(projectId, { request: null, source: s.source, manifest: s.manifest, origin: "starter" })} />
      )}

      <InstalledList projectId={projectId} tools={tools} menuFor={menuFor} onRunAction={mounts ? (toolId, actionId) => mounts.runAction(toolId, actionId) : undefined} />
      <ShowDataFilesToggle />

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
