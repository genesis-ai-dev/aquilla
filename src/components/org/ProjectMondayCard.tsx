import { useEffect, useState } from "react"
import { Link, useLocation } from "react-router-dom"
import { ExternalLink } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { fetchMondayBoardStructure, fetchMondayLink, type MondayLinkStatus } from "@/lib/monday/api"
import { projectSettingsPath } from "@/lib/navigation/org-paths"
import { onMondayLinkChanged } from "@/lib/monday/events"
import { ROLE } from "@/lib/frontier/roles"
import { useT } from "@/lib/i18n/I18nProvider"

interface Props {
  projectId: string
  jwt: string | null
  roleLevel: number | null
}

/** Overview shortcut. Connection state comes from the project's own org. */
export function ProjectMondayCard({ projectId, jwt, roleLevel }: Props) {
  const t = useT()
  const location = useLocation()
  const [state, setState] = useState<{
    projectId: string
    jwt: string
    status: MondayLinkStatus
    boardUrl: string | null
  } | null>(null)

  useEffect(() => {
    if (!jwt) return
    let current = true
    let request = 0
    const load = async () => {
      const version = ++request
      try {
        const status = await fetchMondayLink(jwt, projectId)
        if (!current || version !== request) return
        let boardUrl = status.link?.boardUrl ?? null
        // Existing links predate cached URLs. Read provider metadata without
        // rewriting the saved mapping; project-only members may lack access.
        if (status.linked && status.link && !boardUrl && status.orgId != null) {
          const board = await fetchMondayBoardStructure(jwt, status.orgId, status.link.boardId).catch(() => null)
          boardUrl = board?.url ?? null
        }
        if (current && version === request) setState({ projectId, jwt, status, boardUrl })
      } catch {
        // An unconfirmed connection must not advertise a setup action.
        if (current && version === request) setState(null)
      }
    }
    void load()
    window.addEventListener("focus", load)
    const unsubscribe = onMondayLinkChanged(projectId, () => void load())
    return () => {
      current = false
      window.removeEventListener("focus", load)
      unsubscribe()
    }
  }, [projectId, jwt, location.key])

  if (!state || state.projectId !== projectId || state.jwt !== jwt) return null
  const { status, boardUrl } = state
  if (!(status.orgConnected ?? status.link?.orgConnected)) return null
  const link = status.linked ? status.link : undefined
  const canManage = (roleLevel ?? 0) >= ROLE.MAINTAINER
  const settingsPath = projectSettingsPath(projectId, "integrations")

  return (
    <Card size="sm" aria-label="Monday.com">
      <CardHeader>
        <CardTitle>Monday.com</CardTitle>
        <CardDescription>
          {link ? link.boardName ?? link.boardId : t("projectSettings.monday.overviewConnectDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        {link && boardUrl && (
          <a href={boardUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: "sm" })}>
            {t("projectSettings.monday.overviewOpenBoard")} <ExternalLink data-icon="inline-end" />
          </a>
        )}
        {canManage ? (
          <Link
            to={settingsPath}
            state={{ backgroundLocation: location, projectSettingsModalDepth: 1 }}
            className={buttonVariants({ variant: link ? "outline" : "default", size: "sm" })}
          >
            {t(link ? "projectSettings.monday.overviewConfigureLink" : "projectSettings.monday.overviewLinkBoard")}
          </Link>
        ) : !link ? (
          <p className="text-sm text-muted-foreground">{t("projectSettings.monday.overviewMaintainerHint")}</p>
        ) : null}
        {link && !boardUrl && (
          <p className="text-sm text-muted-foreground">{t("projectSettings.monday.overviewUrlUnavailable")}</p>
        )}
      </CardContent>
    </Card>
  )
}
