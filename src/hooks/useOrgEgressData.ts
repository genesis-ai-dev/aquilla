/**
 * useOrgEgressData — org-wide file inventory for the Data egress page.
 *
 * Two requests cover the whole surface: the accessible-projects list (one row
 * per file, with per-file cell counts) and the org portfolio (per-project lane
 * rollups, audio presence, recorded time). The projects list is required — a
 * failure there is a hard error with retry. The portfolio is enrichment only:
 * when it fails, lane/audio/last-edit columns degrade and
 * `portfolioUnavailable` lets the page say so.
 *
 * Plain useState + race-guarded useEffect per AD-3 — no React Query.
 */

import { useCallback, useEffect, useState } from "react"
import { fetchAccessibleProjectsResult, type CloudProjectSummary } from "@/lib/sync/cloud-projects"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"
import { getPortfolio, type PortfolioLane, type PortfolioProject } from "@/lib/frontier/portfolio"
import { displayLanes } from "@/components/org/project-lanes"

export interface EgressFileRow {
  fileId: string
  fileName: string
  fileType: string
  projectId: string
  projectName: string
  cellCount: number
  sourceLanguage: string
  targetLanguage: string
  /** Cells with target content, when a data source carries it. The projects
   *  list endpoint does not — absent renders as "—" in the table. */
  filledCount?: number
  /** The project's lane rollups in display order ('' default lane first). */
  lanes: PortfolioLane[]
  /** Project-level audio presence — the list endpoint has no per-file signal. */
  hasAudio: boolean
  /** The project's most recent edit (portfolio; null when unavailable). */
  lastEditAt: number | null
}

export interface EgressLaneOption {
  /** Lane code; '' is the project-default lane. */
  lane: string
  label: string
}

/** Per-project fields needed to build EgressProjectSelection[] + estimates. */
export interface EgressProjectMeta {
  projectId: string
  projectName: string
  sourceLanguage: string
  targetLanguage: string
  /** Portfolio recorded-audio total, for the options-panel estimate line. */
  recordedMs: number
}

export interface OrgEgressData {
  rows: EgressFileRow[]
  laneOptions: EgressLaneOption[]
  projectMeta: Map<string, EgressProjectMeta>
  /** True when the portfolio fetch failed — lane/audio columns are degraded. */
  portfolioUnavailable: boolean
  loading: boolean
  error: string | null
  retry: () => void
}

/** A project with no portfolio entry still exports its default lane. */
const FALLBACK_DEFAULT_LANE: PortfolioLane = Object.freeze({
  lane: "",
  totalCells: 0,
  filledCells: 0,
  validatedCells: 0,
  lastEditAt: null,
})

function buildLaneOptions(
  projects: CloudProjectSummary[],
  portfolioById: Map<string, PortfolioProject>,
): EgressLaneOption[] {
  const named = new Set<string>()
  const defaultLabels = new Set<string>()
  for (const p of projects) {
    const pf = portfolioById.get(p.id)
    for (const l of pf ? displayLanes(pf) : [FALLBACK_DEFAULT_LANE]) {
      if (l.lane === "") {
        const t = pf?.targetLanguage?.trim()
        if (t) defaultLabels.add(t)
      } else {
        named.add(l.lane)
      }
    }
  }
  // '' lane first. Its label is the org's target language when every project
  // agrees on one; "Default" when mixed or unknown (a lane-code label would
  // misattribute one project's language to all of them).
  const defaultLabel = defaultLabels.size === 1 ? [...defaultLabels][0] : "Default"
  return [
    { lane: "", label: defaultLabel },
    ...[...named].sort().map((lane) => ({ lane, label: lane })),
  ]
}

const EMPTY: Omit<OrgEgressData, "loading" | "error" | "retry"> = {
  rows: [],
  laneOptions: [],
  projectMeta: new Map(),
  portfolioUnavailable: false,
}

export function useOrgEgressData(jwt: string | null, orgId: number | null): OrgEgressData {
  const [data, setData] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  useEffect(() => {
    if (!jwt || orgId == null) {
      setData(EMPTY)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void (async () => {
      const [projectsRes, portfolioRes] = await Promise.all([
        fetchAccessibleProjectsResult(jwt, orgId),
        // Portfolio is enrichment — swallow its failure into a degraded state.
        getPortfolio(jwt, orgId).then(
          (projects) => ({ ok: true as const, projects }),
          () => ({ ok: false as const }),
        ),
      ])
      if (cancelled) return
      if (!projectsRes.ok) {
        if (projectsRes.reason === "unauthenticated") void notifySessionExpiredIfCurrent(jwt)
        setError(
          projectsRes.reason === "forbidden"
            ? "You don't have access to this organization's projects."
            : "Couldn't load the organization's files. Check your connection and retry.",
        )
        setLoading(false)
        return
      }
      const portfolioById = new Map<string, PortfolioProject>(
        portfolioRes.ok ? portfolioRes.projects.map((p) => [p.id, p]) : [],
      )
      const rows: EgressFileRow[] = []
      const projectMeta = new Map<string, EgressProjectMeta>()
      for (const p of projectsRes.projects) {
        const pf = portfolioById.get(p.id)
        const sourceLanguage = pf?.sourceLanguage?.trim() ?? ""
        const targetLanguage = pf?.targetLanguage?.trim() ?? ""
        projectMeta.set(p.id, {
          projectId: p.id,
          projectName: p.name,
          sourceLanguage,
          targetLanguage,
          recordedMs: pf?.recordedMs ?? 0,
        })
        const lanes = pf ? displayLanes(pf) : [FALLBACK_DEFAULT_LANE]
        for (const f of p.files ?? []) {
          rows.push({
            fileId: f.id,
            fileName: f.name,
            fileType: f.type,
            projectId: p.id,
            projectName: p.name,
            cellCount: f.cellCount,
            sourceLanguage: f.sourceLanguage?.trim() || sourceLanguage,
            targetLanguage: f.targetLanguage?.trim() || targetLanguage,
            lanes,
            hasAudio: (pf?.audioCells ?? 0) > 0,
            lastEditAt: pf?.lastEditAt ?? null,
          })
        }
      }
      setData({
        rows,
        laneOptions: buildLaneOptions(projectsRes.projects, portfolioById),
        projectMeta,
        portfolioUnavailable: !portfolioRes.ok,
      })
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [jwt, orgId, attempt])

  return { ...data, loading, error, retry }
}
