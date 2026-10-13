/**
 * /project/:id/extensions/:toolId — one extension's page.
 *
 * Header: what it is, where it lives, the words it was built from, and
 * "Change it with AI". Tabs: Use (the sandboxed frame, kept mounted so its
 * state survives tab switches) · What it can do (permissions) · Changes &
 * undo (attributed writes + revert, and versions) · Share (copy to project).
 */

import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft, ShieldCheck, Wand2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/components/ui/toast"
import { CopyList, PermissionsList } from "@/components/tools/ExtensionDialogs"
import { ToolActivityPanel } from "@/components/tools/ToolActivityPanel"
import { ToolFrame } from "@/components/tools/ToolFrame"
import { useEditTool } from "@/components/tools/useEditTool"
import { ChangeWithAi } from "@/components/tools/builder/ChangeWithAi"
import { MountIcon, WhereLine } from "@/components/tools/builder/ExtensionFacts"
import { VersionList } from "@/components/tools/builder/VersionList"
import { versionRequest } from "@/lib/tools/builder-model"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProject } from "@/hooks/useProject"
import { useT } from "@/lib/i18n/I18nProvider"
import { getTool, listToolVersions, setToolGrant, type ToolDetail } from "@/lib/tools/tools-api"
import type { ToolScope } from "../../../shared/tools/manifest"

type Tab = "use" | "permissions" | "changes" | "share"

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {children}
    </section>
  )
}

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
  useEffect(() => {
    if (!jwt || !tool || tool.firstParty) return
    let cancelled = false
    listToolVersions(jwt, projectId, tool.id)
      .then((versions) => {
        const first = [...versions].sort((a, b) => a.version - b.version).find((v) => v.origin === "builder" && versionRequest(v))
        if (!cancelled) setBuiltFrom(first ? versionRequest(first) : null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [jwt, projectId, tool?.id, tool?.firstParty, tool])

  const setGrant = async (scopes: ToolScope[]) => {
    if (!jwt || !tool) return
    const granted = await setToolGrant(jwt, projectId, tool.id, scopes)
    setTool({ ...tool, grantedScopes: granted })
  }

  return (
    <div className="solid-primary flex h-dvh flex-col">
      <header className="flex flex-col gap-2 border-b px-3 pt-2 pb-3 sm:px-4">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" render={<Link to={`/project/${projectId}/extensions`} />}>
            <ArrowLeft className="size-4" aria-hidden />
            {t("extensions.backToList")}
          </Button>
          {tool && !changeOpen && (
            <Button size="sm" variant="outline" className="ms-auto" onClick={() => setChangeOpen(true)} disabled={edit.busy}>
              <Wand2 className="size-3.5" aria-hidden />
              {t("extensions.detail.change")}
            </Button>
          )}
        </div>
        {tool && (
          <div className="flex items-start gap-3 px-1">
            <MountIcon mounts={tool.manifest.mounts} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base font-semibold tracking-tight">{tool.name}</h1>
                <Badge variant="outline">{t("extensions.version", { version: tool.currentVersion })}</Badge>
                {tool.firstParty && (
                  <Badge variant="soft" data-testid="first-party-badge">
                    <ShieldCheck className="size-3" aria-hidden />
                    {t("extensions.firstParty.badge")}
                  </Badge>
                )}
              </div>
              {tool.description && <p className="text-sm text-muted-foreground">{tool.description}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground [&_p]:text-xs">
                <WhereLine mounts={tool.manifest.mounts} />
                {builtFrom && (
                  <p className="min-w-0 truncate text-xs" title={builtFrom} data-testid="built-from">
                    {t("extensions.detail.builtFrom", { request: builtFrom })}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}
      </header>
      {tool && changeOpen && (
        <ChangeWithAi name={tool.name} busy={edit.busy} error={edit.error} onSubmit={applyEdit} onClose={() => setChangeOpen(false)} />
      )}

      {missing ? (
        <p className="p-6 text-sm text-muted-foreground">{t("extensions.run.notFound")}</p>
      ) : !tool || !session || !project || !jwt ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Spinner />
          {t("extensions.run.loading")}
        </div>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="min-h-0 flex-1 gap-0">
          <TabsList variant="line" className="w-full justify-start gap-1 border-b px-3 sm:px-4" aria-label={tool.name}>
            <TabsTrigger value="use">{t("extensions.detail.tabUse")}</TabsTrigger>
            <TabsTrigger value="permissions">{t("extensions.detail.tabPermissions")}</TabsTrigger>
            <TabsTrigger value="changes">{t("extensions.detail.tabChanges")}</TabsTrigger>
            <TabsTrigger value="share">{t("extensions.detail.tabShare")}</TabsTrigger>
          </TabsList>
          <TabsContent value="use" keepMounted className="flex min-h-0 flex-1 flex-col data-hidden:hidden">
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
            <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 sm:p-6">
              <Section title={t("extensions.permissions.title", { name: tool.name })} hint={t("extensions.permissions.hint")}>
                <PermissionsList tool={tool} roleLevel={roleLevel ?? null} onChange={setGrant} />
              </Section>
            </div>
          </TabsContent>
          <TabsContent value="changes" className="min-h-0 overflow-y-auto">
            <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 sm:p-6">
              <Section title={t("extensions.activity.title", { name: tool.name })} hint={t("extensions.activity.undoHint")}>
                <ToolActivityPanel projectId={projectId} tool={tool} jwt={jwt} author={session.username} />
              </Section>
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
            <div className="mx-auto flex max-w-2xl flex-col gap-4 p-4 sm:p-6">
              <Section title={t("extensions.copy.title", { name: tool.name })} hint={t("extensions.copy.hint")}>
                <CopyList projectId={projectId} tool={tool} jwt={jwt} />
              </Section>
            </div>
          </TabsContent>
        </Tabs>
      )}
    </div>
  )
}
