/**
 * /project/:id/extensions/:toolId — one extension's page.
 *
 * One compact header row: what it is, where it lives, tabs (Use · Permissions
 * · Changes · Share) and "Change with AI". Use keeps the sandboxed frame
 * mounted, so its state survives tab switches.
 */

import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, History, Play, Quote, Share2, ShieldCheck, ShieldHalf, Wand2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/toast"
import { AppTooltip } from "@/components/ui/tooltip"
import { CopyList, PermissionsList } from "@/components/tools/ExtensionDialogs"
import { ToolActivityPanel } from "@/components/tools/ToolActivityPanel"
import { ToolFrame } from "@/components/tools/ToolFrame"
import { useEditTool } from "@/components/tools/useEditTool"
import { ChangeWithAi } from "@/components/tools/builder/ChangeWithAi"
import { MOUNT_LABEL, MountIcon } from "@/components/tools/builder/ExtensionFacts"
import { VersionList } from "@/components/tools/builder/VersionList"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProject } from "@/hooks/useProject"
import { useT } from "@/lib/i18n/I18nProvider"
import { primaryMount, versionRequest } from "@/lib/tools/builder-model"
import { getTool, listToolVersions, setToolGrant, type ToolDetail } from "@/lib/tools/tools-api"
import type { ToolScope } from "../../../shared/tools/manifest"

type Tab = "use" | "permissions" | "changes" | "share"

export function ToolRunPage() {
  const t = useT()
  const { id: projectId = "", toolId = "" } = useParams<{ id: string; toolId: string }>()
  const { session } = useFrontierSession()
  const { project, roleLevel } = useProject(projectId)
  const [tool, setTool] = useState<ToolDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const [tab, setTab] = useState<Tab>("use")
  const [changeOpen, setChangeOpen] = useState(false)
  const [builtFrom, setBuiltFrom] = useState<string | null>(null)
  const jwt = session?.jwt ?? null
  const edit = useEditTool(projectId, jwt)

  const applyEdit = async (request: string): Promise<boolean> => {
    if (!tool) return false
    const next = await edit.run(tool, request)
    if (!next) return false
    setTool(next)
    setTab("use")
    setChangeOpen(false)
    toast.add({ title: next.name, description: t("extensions.heal.done", { version: next.currentVersion }) })
    return true
  }

  useEffect(() => {
    if (!jwt) return
    let cancelled = false
    getTool(jwt, projectId, toolId)
      .then((next) => {
        if (!cancelled) setTool(next)
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, toolId])

  // "Built from": the first description a person gave (the original build).
  const toolKey = tool?.id
  const firstParty = Boolean(tool?.firstParty)
  useEffect(() => {
    if (!jwt || !toolKey || firstParty) return
    let cancelled = false
    listToolVersions(jwt, projectId, toolKey)
      .then((versions) => {
        const first = [...versions].sort((a, b) => a.version - b.version).find((v) => v.origin === "builder" && versionRequest(v))
        if (!cancelled) setBuiltFrom(first ? versionRequest(first) : null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, toolKey, firstParty])

  const setGrant = async (scopes: ToolScope[]) => {
    if (!jwt || !tool) return
    const granted = await setToolGrant(jwt, projectId, tool.id, scopes)
    setTool({ ...tool, grantedScopes: granted })
  }

  const tabs = [
    { value: "use", icon: Play, label: t("extensions.detail.tabUse") },
    { value: "permissions", icon: ShieldHalf, label: t("extensions.menu.permissions") },
    { value: "changes", icon: History, label: t("extensions.activity.heading") },
    { value: "share", icon: Share2, label: t("extensions.detail.tabShare") },
  ] as const

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="solid-primary flex h-dvh flex-col gap-0">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2.5 sm:px-4">
        <Button variant="ghost" size="icon-sm" aria-label={t("extensions.backToList")} render={<Link to={`/project/${projectId}/extensions`} />}>
          <ArrowLeft className="size-4" aria-hidden />
        </Button>
        {tool && (
          <>
            <MountIcon mounts={tool.manifest.mounts} className="size-8 rounded-lg" />
            <div className="min-w-0 flex-1 sm:flex-none">
              <div className="flex items-center gap-1.5">
                <h1 className="truncate text-sm font-semibold">{tool.name}</h1>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{t("extensions.version", { version: tool.currentVersion })}</span>
                {tool.firstParty && (
                  <AppTooltip content={t("extensions.firstParty.badge")}>
                    <span data-testid="first-party-badge" aria-label={t("extensions.firstParty.badge")} className="inline-flex">
                      <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    </span>
                  </AppTooltip>
                )}
                {builtFrom && (
                  <AppTooltip content={t("extensions.detail.builtFrom", { request: builtFrom })}>
                    <span tabIndex={0} aria-label={t("extensions.detail.builtFrom", { request: builtFrom })} className="inline-flex text-muted-foreground" data-testid="built-from">
                      <Quote className="size-3.5" aria-hidden />
                    </span>
                  </AppTooltip>
                )}
              </div>
              <p className="truncate text-xs text-muted-foreground" title={tool.description}>{t(MOUNT_LABEL[primaryMount(tool.manifest.mounts)])}</p>
            </div>
            <TabsList className="order-last w-full sm:order-none sm:ms-auto sm:w-fit" aria-label={tool.name}>
              {tabs.map((x) => (
                <TabsTrigger key={x.value} value={x.value} className="gap-1.5 px-2.5">
                  <x.icon className="size-3.5" aria-hidden />
                  {x.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {!changeOpen && (
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => setChangeOpen(true)} disabled={edit.busy}>
                <Wand2 className="size-3.5" aria-hidden />
                {t("extensions.detail.change")}
              </Button>
            )}
          </>
        )}
      </header>
      {tool && changeOpen && (
        <ChangeWithAi busy={edit.busy} error={edit.error} onSubmit={applyEdit} onClose={() => setChangeOpen(false)} />
      )}

      {missing ? (
        <p className="p-6 text-sm text-muted-foreground">{t("extensions.run.notFound")}</p>
      ) : !tool || !session || !project || !jwt ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Spinner />
          {t("extensions.run.loading")}
        </div>
      ) : (
        <>
          <TabsContent value="use" keepMounted className="flex min-h-0 flex-1 flex-col">
            <ToolFrame
              project={{ id: project.id, name: project.name }}
              tool={tool}
              session={session}
              roleLevel={roleLevel ?? null}
              onGrantChange={(scopes) => setTool((prev) => (prev ? { ...prev, grantedScopes: scopes } : prev))}
              onHeal={(request) => void applyEdit(request)}
              healing={edit.busy}
            />
          </TabsContent>
          <TabsContent value="permissions" className="min-h-0 overflow-y-auto">
            <div className="mx-auto max-w-xl px-4 py-8">
              <PermissionsList tool={tool} roleLevel={roleLevel ?? null} onChange={setGrant} />
            </div>
          </TabsContent>
          <TabsContent value="changes" className="min-h-0 overflow-y-auto">
            <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-8">
              <ToolActivityPanel projectId={projectId} tool={tool} jwt={jwt} author={session.username} />
              <VersionList
                projectId={projectId}
                jwt={jwt}
                tool={tool}
                onRestored={(next, from) => {
                  setTool(next)
                  toast.add({ title: next.name, description: t("extensions.versions.restored", { version: from, current: next.currentVersion }) })
                }}
              />
            </div>
          </TabsContent>
          <TabsContent value="share" className="min-h-0 overflow-y-auto">
            <div className="mx-auto flex max-w-xl flex-col gap-3 px-4 py-8">
              <p className="text-sm text-muted-foreground">{t("extensions.copy.hint")}</p>
              <CopyList projectId={projectId} tool={tool} jwt={jwt} />
            </div>
          </TabsContent>
        </>
      )}
    </Tabs>
  )
}
