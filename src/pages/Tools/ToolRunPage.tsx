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
          </>
        )}
      </div>
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
        />
      )}
    </div>
  )
}
