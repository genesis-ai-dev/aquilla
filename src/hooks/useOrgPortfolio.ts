import { useCallback, useEffect, useMemo, useState } from "react"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import {
  getPortfolio,
  translatedPct,
  validatedPct,
  audioPct,
  deadlineStatus,
  attentionRank,
  type PortfolioProject,
} from "@/lib/frontier/portfolio"
import { portfolioActivityStatus, portfolioAttentionReasons } from "@/lib/project-status"
import { UserError } from "@/lib/errors/user-error"
import { notifySessionExpired } from "@/lib/errors/session-expired-signal"
import { withOptimisticLane } from "@/components/org/project-lanes"

export type PortfolioProjectRow = PortfolioProject & {
  orgId?: number
  orgName?: string | null
}

export type StatusFilter = "all" | "stalled" | "attention" | "overdue"

export type AttentionRow = {
  project: PortfolioProjectRow
  score: number
  reasons: ReturnType<typeof portfolioAttentionReasons>
}

/**
 * Single-org portfolio load + derived rollups for Overview and Projects pages.
 * All-orgs portfolio stays in OrgHome (multi-org fetch).
 */
export function useOrgPortfolio(orgId: number | null, orgName?: string | null) {
  const { session, loading: sessionLoading } = useFrontierSession()
  const {
    accessibleProjects,
    accessibleProjectsLoading,
    refreshAccessibleProjects,
  } = useActiveOrg()
  const jwt = session?.jwt ?? null

  const [projects, setProjects] = useState<PortfolioProjectRow[]>([])
  const [resolvedScopeKey, setResolvedScopeKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  const portfolioScopeKey = jwt && orgId != null ? `org:${orgId}` : null

  const handleLaneAdded = useCallback((projectId: string, lane: string) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === projectId ? withOptimisticLane(p, lane) : p)),
    )
  }, [])

  const bumpRefresh = useCallback(() => {
    setRefreshTick((t) => t + 1)
  }, [])

  useEffect(() => {
    if (!jwt || orgId == null) {
      setProjects([])
      setResolvedScopeKey(null)
      return
    }
    let cancelled = false
    setError(null)
    getPortfolio(jwt, orgId)
      .then((list) => {
        if (!cancelled) {
          setProjects(
            list.map((project) => ({
              ...project,
              orgId,
              orgName: orgName ?? "Workspace",
            })),
          )
        }
      })
      .catch((err) => {
        if (!cancelled) {
          if (err instanceof UserError && err.category === "session-expired") {
            notifySessionExpired()
          }
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setResolvedScopeKey(portfolioScopeKey)
      })
    return () => {
      cancelled = true
    }
  }, [jwt, orgId, orgName, portfolioScopeKey, refreshTick])

  // Freeze "now" per portfolio resolve so sort keys stay stable while viewing.
  const now = useMemo(() => Date.now(), [resolvedScopeKey, refreshTick])

  const pmByProjectId = useMemo(
    () => new Map(accessibleProjects.map((project) => [project.id, project.pm ?? null])),
    [accessibleProjects],
  )
  const projectsWithPm: PortfolioProjectRow[] = useMemo(
    () =>
      projects.map((project) =>
        pmByProjectId.has(project.id)
          ? { ...project, pm: pmByProjectId.get(project.id) ?? null }
          : project,
      ),
    [projects, pmByProjectId],
  )

  const roleByProjectId = useMemo(
    () => new Map(accessibleProjects.map((project) => [project.id, project.role])),
    [accessibleProjects],
  )
  const defaultLaneLabelByProjectId = useMemo(
    () =>
      new Map(
        accessibleProjects.map((project) => [
          project.id,
          project.files?.find((f) => f.targetLanguage)?.targetLanguage ?? "",
        ]),
      ),
    [accessibleProjects],
  )
  const filesByProjectId = useMemo(
    () =>
      new Map(
        accessibleProjects.map((project) => [
          project.id,
          (project.files ?? []).map((f) => ({ id: f.id, name: f.name })),
        ]),
      ),
    [accessibleProjects],
  )

  const avgTranslatedPct =
    projects.length > 0
      ? projects.reduce((sum, p) => sum + translatedPct(p), 0) / projects.length
      : 0
  const avgValidatedPct =
    projects.length > 0
      ? projects.reduce((sum, p) => sum + validatedPct(p), 0) / projects.length
      : 0
  const avgAudioPct =
    projects.length > 0
      ? projects.reduce((sum, p) => sum + audioPct(p), 0) / projects.length
      : 0
  const stalledCount = projects.filter((p) => portfolioActivityStatus(p, now) === "stalled").length
  const overdueCount = projects.filter((p) => deadlineStatus(p, now) === "overdue").length

  const attentionProjects = useMemo((): AttentionRow[] => {
    return projectsWithPm
      .map((project) => {
        const reasons = portfolioAttentionReasons(project, now)
        return {
          project,
          reasons,
          score: attentionRank(project, now),
        }
      })
      .filter((row) => row.reasons.length > 0)
      .sort((a, b) => b.score - a.score || a.project.name.localeCompare(b.project.name))
  }, [projectsWithPm, now])

  const filterByStatus = useCallback(
    (status: StatusFilter, list: PortfolioProjectRow[] = projectsWithPm) => {
      return list.filter((p) => {
        switch (status) {
          case "stalled":
            return portfolioActivityStatus(p, now) === "stalled"
          case "attention":
            return portfolioAttentionReasons(p, now).length > 0
          case "overdue":
            return deadlineStatus(p, now) === "overdue"
          default:
            return true
        }
      })
    },
    [projectsWithPm, now],
  )

  const isLoading =
    sessionLoading ||
    accessibleProjectsLoading ||
    (jwt != null && portfolioScopeKey != null && resolvedScopeKey !== portfolioScopeKey)

  return {
    jwt,
    session,
    sessionLoading,
    projects: projectsWithPm,
    error,
    isLoading,
    now,
    avgTranslatedPct,
    avgValidatedPct,
    avgAudioPct,
    stalledCount,
    overdueCount,
    attentionProjects,
    roleByProjectId,
    defaultLaneLabelByProjectId,
    filesByProjectId,
    handleLaneAdded,
    bumpRefresh,
    refreshAccessibleProjects,
    filterByStatus,
  }
}
