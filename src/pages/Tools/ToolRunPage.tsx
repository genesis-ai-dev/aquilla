/**
 * /project/:id/tools/:toolId — one tool, full page, in its sandboxed frame.
 */

import { useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { ArrowLeft } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { ToolFrame } from "@/components/tools/ToolFrame"
import { useEditTool } from "@/components/tools/useEditTool"
import { toast } from "@/components/ui/toast"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProject } from "@/hooks/useProject"
import { useT } from "@/lib/i18n/I18nProvider"
import { getTool, type ToolDetail } from "@/lib/tools/tools-api"

export function ToolRunPage() {
  const t = useT()
  const { id: projectId = "", toolId = "" } = useParams<{ id: string; toolId: string }>()
  const { session } = useFrontierSession()
  const { project, roleLevel } = useProject(projectId)
  const [tool, setTool] = useState<ToolDetail | null>(null)
  const [missing, setMissing] = useState(false)
  const jwt = session?.jwt ?? null
  const edit = useEditTool(projectId, jwt)
  const [change, setChange] = useState("")
  const applyEdit = async (request: string) => {
    if (!tool) return
    const next = await edit.run(tool, request)
    if (next) {
      setTool(next)
      setChange("")
      toast.add({ title: next.name, description: t("extensions.heal.done", { version: next.currentVersion }) })
    }
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

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="sm" render={<Link to={`/project/${projectId}/extensions`} />}>
          <ArrowLeft className="size-4" aria-hidden />
          {t("extensions.backToList")}
        </Button>
        {tool && (
          <>
            <h1 className="text-sm font-semibold">{tool.name}</h1>
            <Badge variant="outline">{t("extensions.version", { version: tool.currentVersion })}</Badge>
            <form
              className="ms-auto flex min-w-0 flex-1 items-center justify-end gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (change.trim()) void applyEdit(change.trim())
              }}
            >
              <input
                aria-label={t("extensions.change.placeholder")}
                placeholder={t("extensions.change.placeholder")}
                className="w-full max-w-sm rounded border bg-background px-2 py-1 text-xs"
                value={change}
                disabled={edit.busy}
                onChange={(e) => setChange(e.target.value)}
              />
              <Button size="sm" type="submit" variant="outline" disabled={edit.busy || !change.trim()}>
                {edit.busy ? t("extensions.heal.running") : t("extensions.change.submit")}
              </Button>
            </form>
          </>
        )}
      </div>
      {edit.error && (
        <p role="alert" className="border-b px-4 py-1 text-xs text-destructive">{t("extensions.heal.failed", { message: edit.error.slice(0, 300) })}</p>
      )}
      {missing ? (
        <p className="p-6 text-sm text-muted-foreground">{t("extensions.run.notFound")}</p>
      ) : !tool || !session || !project ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Spinner />
          {t("extensions.run.loading")}
        </div>
      ) : (
        <ToolFrame
          project={{ id: project.id, name: project.name }}
          tool={tool}
          session={session}
          roleLevel={roleLevel ?? null}
          onGrantChange={(scopes) => setTool((prev) => (prev ? { ...prev, grantedScopes: scopes } : prev))}
          onHeal={(request) => void applyEdit(request)}
          healing={edit.busy}
        />
      )}
    </div>
  )
}
