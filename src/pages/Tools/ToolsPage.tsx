/**
 * /project/:id/extensions — Smart Extensions.
 *
 * A guided flow a first-time user understands without docs:
 *   1 Describe (plain words, translation examples, where it should appear)
 *   2 Review & try (their own words quoted back, the extension running in a
 *     sandboxed preview on sample verses, where it appears, what it may do)
 *   3 Add to project.
 * Ready-made starters open the same review. Installed extensions are listed
 * below with everything secondary behind "…".
 */

import { useCallback, useEffect, useRef, useState } from "react"
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
import { ReviewStep, type ReviewCandidate } from "@/components/tools/builder/ReviewStep"
import { StarterGallery } from "@/components/tools/builder/StarterGallery"
import { useBuildRunner } from "@/components/tools/builder/useBuildRunner"
import { useToolsMount } from "@/components/tools/ToolsMountContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProject } from "@/hooks/useProject"
import { useT } from "@/lib/i18n/I18nProvider"
import { composeRequest, parseWhere, stepFor, type WhereChoice } from "@/lib/tools/builder-model"
import { grantableAtInstall } from "@/lib/tools/permissions"
import { installTool, listTools, removeTool, setToolGrant, type ToolSummary } from "@/lib/tools/tools-api"
import type { ToolScope } from "../../../shared/tools/manifest"

type Sheet = { kind: "permissions" | "activity" | "copy" | "review"; toolId: string } | null

interface Candidate extends ReviewCandidate {
  buildMeta?: { request: string; model: string | null; attempts: number; cost: number }
}

export function ToolsPage() {
  const t = useT()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { id: projectId = "" } = useParams<{ id: string }>()
  const { session } = useFrontierSession()
  const { project, roleLevel } = useProject(projectId)
  const jwt = session?.jwt ?? null
  const mounts = useToolsMount()
  const builder = useBuildRunner(projectId, jwt)

  const [tools, setTools] = useState<ToolSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [request, setRequest] = useState("")
  const [where, setWhere] = useState<WhereChoice>(() => parseWhere(params.get("where")))
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [changing, setChanging] = useState(false)
  const [adding, setAdding] = useState(false)
  const [sheet, setSheet] = useState<Sheet>(null)
  const topRef = useRef<HTMLDivElement | null>(null)

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

  const build = async () => {
    const words = request.trim()
    if (!words) return
    const result = await builder.run(composeRequest(words, where))
    if (!result?.source || !result.manifest) return
    setCandidate({
      request: words,
      source: result.source,
      manifest: result.manifest,
      origin: "builder",
      buildMeta: { request: words, model: result.model, attempts: result.attempts, cost: result.cost },
    })
  }

  /** "Change it…" on the review: rebuild from the current candidate. */
  const changeCandidate = async (change: string) => {
    if (!candidate) return
    setChanging(true)
    try {
      const result = await builder.run(change, { source: candidate.source, manifest: candidate.manifest })
      if (result?.source && result.manifest) {
        const words = `${candidate.request ?? ""}\n${change}`.trim()
        setCandidate({ ...candidate, source: result.source, manifest: result.manifest, request: words, buildMeta: { request: words, model: result.model, attempts: result.attempts, cost: result.cost } })
      }
    } finally {
      setChanging(false)
    }
  }

  /** Add to project: reads are granted now, anything else asks the first time. */
  const add = async (c: Candidate) => {
    if (!jwt) return
    setAdding(true)
    try {
      const grant = grantableAtInstall(c.manifest.scopes, roleLevel ?? null).grantable.filter((s) => s.startsWith("read:"))
      const tool = await installTool(jwt, projectId, {
        source: c.source,
        manifest: c.manifest,
        origin: c.origin,
        ...(c.buildMeta ? { buildMeta: c.buildMeta } : {}),
        grant,
      })
      setCandidate(null)
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
  const building = builder.running && !changing

  const menuFor = (tool: ToolSummary): OverflowMenuItem[] => [
    { id: "permissions", label: t("extensions.menu.permissions"), onClick: () => setSheet({ kind: "permissions", toolId: tool.id }), testId: "tool-menu-permissions" },
    { id: "activity", label: t("extensions.detail.tabChanges"), onClick: () => setSheet({ kind: "activity", toolId: tool.id }), testId: "tool-menu-activity" },
    ...(tool.manifest.mounts.includes("panel") && mounts
      ? [{ id: "pin", label: mounts.pinned.includes(tool.id) ? t("extensions.unpin") : t("extensions.pin"), onClick: () => mounts.togglePin(tool.id) }]
      : []),
    { id: "copy", label: t("extensions.copy.pick"), onClick: () => setSheet({ kind: "copy", toolId: tool.id }) },
    ...(tool.upstreamToolId ? [{ id: "review", label: t("extensions.review.button"), onClick: () => setSheet({ kind: "review", toolId: tool.id }) }] : []),
    { id: "sep", type: "separator" as const },
    { id: "remove", label: t("extensions.remove"), destructive: true, onClick: () => void remove(tool), testId: "tool-menu-remove" },
  ]

  return (
    <div ref={topRef} className="solid-primary mx-auto flex w-full max-w-4xl flex-col gap-7 px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label={t("extensions.backToEditor")} render={<Link to={`/project/${projectId}/editor`} />}>
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <h1 className="flex min-w-0 items-baseline gap-2 text-xl font-semibold tracking-tight">
            {t("extensions.title")}
            {project && <span className="truncate text-sm font-normal text-muted-foreground">{project.name}</span>}
          </h1>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground sm:ps-9">{t("extensions.subtitle")}</p>
      </header>

      <BuilderStepper current={stepFor({ building, hasCandidate: candidate !== null })} />

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
          candidate={candidate}
          adding={adding}
          changing={changing}
          onAdd={() => void add(candidate)}
          onChange={(change) => void changeCandidate(change)}
          onDiscard={() => setCandidate(null)}
        />
      ) : building && builder.request ? (
        <BuildProgressCard request={request.trim() || builder.request} phase={builder.phase} startedAt={builder.startedAt} onCancel={builder.cancel} />
      ) : (
        <>
          {builder.failure !== null && (
            <BuildFailureCard failure={builder.failure} onEdit={builder.clearFailure} onRetry={() => void build()} />
          )}
          <DescribeStep value={request} onChange={setRequest} where={where} onWhereChange={setWhere} onBuild={() => void build()} disabled={builder.running} />
        </>
      )}
      {candidate && changing && builder.request && (
        <BuildProgressCard request={builder.request} phase={builder.phase} startedAt={builder.startedAt} onCancel={() => { builder.cancel(); setChanging(false) }} />
      )}

      {!candidate && !building && (
        <StarterGallery disabled={builder.running} onPick={(s) => setCandidate({ request: null, source: s.source, manifest: s.manifest, origin: "starter" })} />
      )}

      <InstalledList projectId={projectId} tools={tools} menuFor={menuFor} />

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
