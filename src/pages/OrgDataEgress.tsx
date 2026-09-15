// Org "Data egress" page — org owners/maintainers pull everything the org has
// stored (text per lane, source documents, audio) into one zip with a
// manifest.json transparency record. The engine (src/lib/egress/org-egress)
// runs entirely client-side; server 403s stay the security boundary and
// surface per-project in the results panel.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { AppShell } from "@/components/AppShell"
import { OrgSidebar } from "@/components/org/OrgSidebar"
import { OrgBreadcrumb } from "@/components/org/OrgBreadcrumb"
import { useActiveOrg } from "@/context/OrgContext"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useOrgSettings } from "@/hooks/useOrgSettings"
import { useOrgEgressData, type EgressFileRow, type EgressProjectMeta } from "@/hooks/useOrgEgressData"
import { EgressFileTable } from "@/components/org/egress/EgressFileTable"
import { EgressOptionsPanel, egressProducesNothing } from "@/components/org/egress/EgressOptionsPanel"
import { EgressResultsPanel, type EgressRunState } from "@/components/org/egress/EgressResultsPanel"
import { runOrgEgress } from "@/lib/egress/org-egress"
import type { EgressOptions, EgressProjectSelection } from "@/lib/egress/types"
import { DEFAULT_EGRESS_OPTIONS, getEgressPrefs, setEgressPrefs } from "@/lib/store/egress-prefs"
import { downloadBlob } from "@/lib/export/export-service"
import { Button } from "@/components/ui/button"
import { LoadingPanel } from "@/components/ui/loading-overlay"
import { EmptyState, Page, PageHeader } from "@/components/ui/page"
import { AlertTriangle, Building2, Lock } from "lucide-react"
import { useT } from "@/lib/i18n/I18nProvider"

function buildSelections(
  rows: EgressFileRow[],
  selected: Set<string>,
  projectMeta: Map<string, EgressProjectMeta>,
): EgressProjectSelection[] {
  const byProject = new Map<string, EgressProjectSelection>()
  for (const row of rows) {
    if (!selected.has(row.fileId)) continue
    let sel = byProject.get(row.projectId)
    if (!sel) {
      const meta = projectMeta.get(row.projectId)
      sel = {
        projectId: row.projectId,
        projectName: meta?.projectName ?? row.projectName,
        sourceLanguage: meta?.sourceLanguage ?? "",
        targetLanguage: meta?.targetLanguage ?? "",
        files: [],
      }
      byProject.set(row.projectId, sel)
    }
    sel.files.push({ id: row.fileId, name: row.fileName, type: row.fileType })
  }
  return [...byProject.values()]
}

export function OrgDataEgress() {
  const t = useT()
  const { activeOrg, activeOrgId, isAllOrgs } = useActiveOrg()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  // AQU-907: the surface floor is org policy — owners always pass; other
  // roles only when an owner opened the surface to them (egressMinRole).
  // The same hook carries the AQU-253 exportMinRole gate ExportDialog uses:
  // egressMinRole decides who sees this page, exportMinRole decides whether
  // exports are allowed at all — both can bind at once.
  const { canEgress, canExport, hasFetched } = useOrgSettings(activeOrgId, activeOrg?.role.level)

  let body: ReactNode
  if (isAllOrgs || activeOrgId == null) {
    body = (
      <EmptyState
        icon={Building2}
        title={t("org.teamsList.selectOrgTitle")}
        description={t("org.egress.selectOrgDescription")}
      />
    )
  } else if (!canEgress) {
    // Below-owner callers stay undecided until the settings fetch lands —
    // render nothing rather than flashing the lock at a maintainer the org
    // has actually opened the surface to.
    body = hasFetched ? (
      <EmptyState
        icon={Lock}
        title={t("org.egress.roleRequired")}
      />
    ) : null
  } else {
    // Keyed by org so selection/options/run state reset on an org switch.
    body = (
      <EgressBody
        key={activeOrgId}
        orgId={activeOrgId}
        orgName={activeOrg?.name ?? `Organization ${activeOrgId}`}
        jwt={jwt}
        username={session?.username ?? null}
        canExport={canExport}
      />
    )
  }

  return (
    <AppShell
      sidebar={<OrgSidebar />}
      header={<OrgBreadcrumb section={t("org.egress.title")} />}
      statusBar={null}
      main={
        <Page size="full">
          {canEgress && !isAllOrgs && activeOrgId != null ? null : (
            <PageHeader title={t("org.egress.title")} description={t("org.egress.description")} />
          )}
          {body}
        </Page>
      }
    />
  )
}

function EgressBody({
  orgId,
  orgName,
  jwt,
  username,
  canExport,
}: {
  orgId: number
  orgName: string
  jwt: string | null
  /** Cache user-partitioning — threaded into the engine's RunOrgEgressArgs. */
  username: string | null
  /** AQU-253 org export policy (useOrgSettings.canExport). */
  canExport: boolean
}) {
  const t = useT()
  const data = useOrgEgressData(jwt, orgId)

  // Default ALL files selected once data loads: the easy path is open page →
  // Export. Seed exactly once so later deselections stick across revalidates.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current || data.loading || data.rows.length === 0) return
    seededRef.current = true
    setSelected(new Set(data.rows.map((r) => r.fileId)))
  }, [data.loading, data.rows])

  const [options, setOptions] = useState<EgressOptions>(
    () => getEgressPrefs(orgId) ?? DEFAULT_EGRESS_OPTIONS,
  )
  // Persist outside the setState updater (updaters may be double-invoked).
  const optionsRef = useRef(options)
  optionsRef.current = options
  const updateOptions = useCallback(
    (patch: Partial<EgressOptions>) => {
      const next = { ...optionsRef.current, ...patch }
      setOptions(next)
      setEgressPrefs(orgId, next)
    },
    [orgId],
  )

  // Prune persisted lanes that no longer exist in the org (renamed/deleted
  // lanes would silently produce empty exports). Only against the FULL lane
  // list: when the portfolio failed, laneOptions is degraded (default lane
  // only) and pruning would erase legitimate preferences. The "" default lane
  // is always in laneOptions, so it always survives.
  useEffect(() => {
    if (data.loading || data.portfolioUnavailable || data.laneOptions.length === 0) return
    const valid = new Set(data.laneOptions.map((o) => o.lane))
    const pruned = optionsRef.current.lanes.filter((l) => valid.has(l))
    if (pruned.length !== optionsRef.current.lanes.length) updateOptions({ lanes: pruned })
  }, [data.loading, data.portfolioUnavailable, data.laneOptions, updateOptions])

  const [run, setRun] = useState<EgressRunState>({ kind: "idle" })
  const abortRef = useRef<AbortController | null>(null)
  // Cancel a still-running export when the page unmounts.
  useEffect(() => () => abortRef.current?.abort(), [])

  const estimate = useMemo(() => {
    let files = 0
    let cells = 0
    const projectIds = new Set<string>()
    for (const row of data.rows) {
      if (!selected.has(row.fileId)) continue
      files += 1
      cells += row.cellCount
      projectIds.add(row.projectId)
    }
    let recordedMs = 0
    for (const id of projectIds) recordedMs += data.projectMeta.get(id)?.recordedMs ?? 0
    return { files, cells, recordedMs }
  }, [data.rows, data.projectMeta, selected])

  const running = run.kind === "running"
  const runActive = run.kind !== "idle"

  const handleExport = useCallback(async () => {
    if (!jwt || running) return
    const selections = buildSelections(data.rows, selected, data.projectMeta)
    if (selections.length === 0) return
    const controller = new AbortController()
    abortRef.current = controller
    setRun({ kind: "running", progress: null })
    try {
      const result = await runOrgEgress({
        org: { id: orgId, name: orgName },
        selections,
        options,
        jwt,
        username: username ?? undefined,
        onProgress: (p) => setRun({ kind: "running", progress: p }),
        signal: controller.signal,
      })
      // A cancel (or unmount — the unmount effect aborts) can race the final
      // packaging: the engine resolves anyway. Don't download or claim success.
      if (controller.signal.aborted) {
        setRun({ kind: "idle" })
        return
      }
      downloadBlob(result.blob, result.filename)
      setRun({ kind: "done", manifest: result.manifest })
    } catch (e) {
      // A user cancel is not a failure — return to idle quietly.
      if (controller.signal.aborted) setRun({ kind: "idle" })
      else setRun({ kind: "error", message: e instanceof Error ? e.message : String(e) })
    } finally {
      abortRef.current = null
    }
  }, [jwt, running, data.rows, data.projectMeta, selected, orgId, orgName, options, username])

  const handleCancel = useCallback(() => abortRef.current?.abort(), [])

  const producesNothing = egressProducesNothing(options)

  return (
    <>
      <PageHeader
        title={t("org.egress.title")}
        description={t("org.egress.description")}
        actions={
          <Button
            type="button"
            onClick={() => void handleExport()}
            disabled={selected.size === 0 || running || data.loading || producesNothing || !canExport}
            data-testid="egress-export-button"
          >
            {t("org.egress.exportCount", { count: selected.size })}
          </Button>
        }
      />
      {runActive && (
        <div className="mb-6">
          <EgressResultsPanel state={run} onCancel={handleCancel} />
        </div>
      )}
      {data.loading ? (
        <LoadingPanel label={t("org.egress.loading")} className="min-h-80" />
      ) : data.error ? (
        <EmptyState
          title={t("org.egress.loadFailed")}
          description={data.error}
          action={
            <Button type="button" variant="outline" onClick={data.retry}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-6 xl:flex-row">
          <div className="min-w-0 flex-1">
            {data.portfolioUnavailable && (
              <p className="mb-3 text-xs text-muted-foreground">
                {t("org.egress.portfolioUnavailable")}
              </p>
            )}
            <EgressFileTable rows={data.rows} selected={selected} onSelectedChange={setSelected} />
          </div>
          <div className="w-full shrink-0 xl:w-96">
            {canExport ? (
              <EgressOptionsPanel
                options={options}
                onChange={updateOptions}
                laneOptions={data.laneOptions}
                estimate={estimate}
                disabled={running}
              />
            ) : (
              /* AQU-253 export policy gate — same amber note ExportDialog
                 shows: explain the block instead of hiding it. */
              <div
                role="note"
                aria-label={t("importExport.dialog.permissionRequiredAriaLabel")}
                className="flex flex-col gap-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40 px-3 py-3 text-sm text-amber-700 dark:text-amber-300"
                data-testid="egress-policy-gate"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                  {t("org.egress.policyRestricted")}
                </span>
                <p className="text-xs leading-relaxed">
                  {t("importExport.dialog.permissionExplanation")}
                </p>
                <a
                  href="https://help.aquilla.app/permissions"
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs font-medium underline underline-offset-2 hover:opacity-80"
                >
                  {t("importExport.dialog.permissionsLinkText")}
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
