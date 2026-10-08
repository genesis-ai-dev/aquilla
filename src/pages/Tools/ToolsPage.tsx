/**
 * /project/:id/tools — Aquilla Tools (prototype).
 *
 * Build a tool from a prompt, install a reviewed starter, manage each tool's
 * standing grant, see what it changed and revert it.
 */

import { useCallback, useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "react-router-dom"
import { ArrowLeft, Blocks, History, Pin, PinOff, Play, Trash2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { BuildToolCard, type BuiltTool } from "@/components/tools/BuildToolCard"
import { InstallToolDialog } from "@/components/tools/InstallToolDialog"
import { ToolActivityPanel } from "@/components/tools/ToolActivityPanel"
import { useScopeLabel } from "@/components/tools/scope-label"
import { useToolsMount } from "@/components/tools/ToolsMountContext"
import { CopyExtension, ReviewCopiedExtension } from "@/components/tools/ShareExtension"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProject } from "@/hooks/useProject"
import { useT } from "@/lib/i18n/I18nProvider"
import { revokeScope } from "@/lib/tools/permissions"
import { STARTER_EXTENSIONS } from "@/lib/tools/starters"
import {
  installTool,
  listTools,
  removeTool,
  setToolGrant,
  type SaveToolInput,
  type ToolSummary,
} from "@/lib/tools/tools-api"
import type { ToolManifest, ToolScope } from "../../../shared/tools/manifest"

interface Candidate {
  input: Omit<SaveToolInput, "grant">
  manifest: ToolManifest
}

const STARTERS = STARTER_EXTENSIONS

export function ToolsPage() {
  const t = useT()
  const navigate = useNavigate()
  const scopeLabel = useScopeLabel()
  const { id: projectId = "" } = useParams<{ id: string }>()
  const { session } = useFrontierSession()
  const { project, roleLevel } = useProject(projectId)
  const [tools, setTools] = useState<ToolSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [installing, setInstalling] = useState(false)
  const [activityFor, setActivityFor] = useState<string | null>(null)
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
  }, [jwt, projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const install = async (grant: ToolScope[]) => {
    if (!candidate || !jwt) return
    setInstalling(true)
    try {
      const tool = await installTool(jwt, projectId, { ...candidate.input, grant })
      setCandidate(null)
      await refresh()
      // Editor extensions surface in the editor's switcher; everything else
      // opens on its own page first.
      navigate(
        tool.manifest.mounts.includes("editor")
          ? `/project/${projectId}/editor`
          : `/project/${projectId}/extensions/${tool.id}`,
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInstalling(false)
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

  const revoke = async (tool: ToolSummary, scope: ToolScope) => {
    if (!jwt) return
    await setToolGrant(jwt, projectId, tool.id, revokeScope(tool.grantedScopes, scope))
    await refresh()
  }

  const remove = async (tool: ToolSummary) => {
    if (!jwt) return
    await removeTool(jwt, projectId, tool.id)
    await refresh()
  }

  if (!session) return <Spinner className="m-8" />

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" render={<Link to={`/project/${projectId}/editor`} />}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("extensions.backToEditor")}
        </Button>
      </div>
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <Blocks className="size-5" aria-hidden />
          {t("extensions.title")}
          {project && <span className="text-muted-foreground">· {project.name}</span>}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("extensions.subtitle")}</p>
      </header>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      {jwt && <BuildToolCard projectId={projectId} jwt={jwt} onBuilt={onBuilt} />}

      <section aria-label={t("extensions.starters.heading")}>
        <h2 className="mb-2 text-sm font-semibold">{t("extensions.starters.heading")}</h2>
        {STARTERS.map((s) => (
          <div key={s.manifest.name} className="flex items-center gap-3 rounded-lg border bg-card p-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 font-medium">
                {s.manifest.name}
                <Badge variant="secondary">{t("extensions.starters.badge")}</Badge>
              </div>
              <p className="text-sm text-muted-foreground">{s.manifest.description}</p>
            </div>
            <Button
              aria-label={`${t("extensions.install")}: ${s.manifest.name}`}
              onClick={() => setCandidate({ manifest: s.manifest, input: { source: s.source, manifest: s.manifest, origin: "starter" } })}
            >
              {t("extensions.install")}
            </Button>
          </div>
        ))}
      </section>

      <section aria-label={t("extensions.installed.heading")}>
        <h2 className="mb-2 text-sm font-semibold">{t("extensions.installed.heading")}</h2>
        {tools === null ? (
          <Spinner />
        ) : tools.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("extensions.installed.empty")}</p>
        ) : (
          <ul className="space-y-3">
            {tools.map((tool) => (
              <li key={tool.id} className="rounded-lg border bg-card p-3" data-testid="installed-tool" data-tool-name={tool.name}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{tool.name}</span>
                  <Badge variant="outline">{t("extensions.version", { version: tool.currentVersion })}</Badge>
                  <Badge variant="outline" className="font-mono">{t("extensions.codeHash", { hash: tool.codeHash.slice(0, 8) })}</Badge>
                  {jwt && <ReviewCopiedExtension projectId={projectId} tool={tool} jwt={jwt} />}
                  <div className="ml-auto flex gap-2">
                    <Button size="sm" render={<Link to={`/project/${projectId}/extensions/${tool.id}`} />}>
                      <Play className="size-3.5" aria-hidden />
                      {t("extensions.open")}
                    </Button>
                    <Button size="sm" variant="outline" aria-pressed={activityFor === tool.id} onClick={() => setActivityFor(activityFor === tool.id ? null : tool.id)}>
                      <History className="size-3.5" aria-hidden />
                      {t("extensions.activity.heading")}
                    </Button>
                    {tool.manifest.mounts.includes("panel") && mounts && (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-pressed={mounts.pinned.includes(tool.id)}
                        aria-label={`${mounts.pinned.includes(tool.id) ? t("extensions.unpin") : t("extensions.pin")}: ${tool.name}`}
                        onClick={() => mounts.togglePin(tool.id)}
                      >
                        {mounts.pinned.includes(tool.id) ? <PinOff className="size-3.5" aria-hidden /> : <Pin className="size-3.5" aria-hidden />}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" aria-label={`${t("extensions.remove")}: ${tool.name}`} onClick={() => void remove(tool)}>
                      <Trash2 className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{tool.description}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("extensions.mounts.label")}:{" "}
                  {tool.manifest.mounts
                    .map((m) => (m === "page" ? t("extensions.mounts.page") : m === "panel" ? t("extensions.mounts.panel") : m === "inline" ? t("extensions.mounts.inline") : t("extensions.mounts.editor")))
                    .join(" · ")}
                </p>
                {jwt && (
                  <div className="mt-1">
                    <CopyExtension projectId={projectId} tool={tool} jwt={jwt} />
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{t("extensions.grants.label")}:</span>
                  {tool.grantedScopes.length === 0 && <span className="text-muted-foreground">{t("extensions.grants.none")}</span>}
                  {tool.grantedScopes.map((scope) => (
                    <Badge key={scope} variant="secondary" className="gap-1" data-testid="tool-grant">
                      {scopeLabel(scope)}
                      <button type="button" aria-label={t("extensions.grants.revoke", { scope: scopeLabel(scope) })} onClick={() => void revoke(tool, scope)}>
                        <X className="size-3" aria-hidden />
                      </button>
                    </Badge>
                  ))}
                </div>
                {activityFor === tool.id && jwt && session && (
                  <ToolActivityPanel projectId={projectId} tool={tool} jwt={jwt} author={session.username} />
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {candidate && (
        <InstallToolDialog
          manifest={candidate.manifest}
          roleLevel={roleLevel ?? null}
          busy={installing}
          onInstall={(grant) => void install(grant)}
          onCancel={() => setCandidate(null)}
        />
      )}
    </div>
  )
}
