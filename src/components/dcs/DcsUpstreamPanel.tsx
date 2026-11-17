// DCS freshness / delta panel (spec §6, §9 step 3) — the "Check for updates /
// Import changes" surface for a Door43-linked ADAPTER project (one whose
// project_settings carries a `dcsUpstream` cursor).
//
// Flow:
//   1. Read the pinned cursor via readCursor(settings). No cursor ⇒ render
//      nothing (this project is not a DCS adapter).
//   2. "Check for updates" → client.getLatestRelease(owner, repo) resolves the
//      current prod release (newest released entry, regardless of tag name),
//      compares its commitSha/ref against the cursor; if newer,
//      client.compareRefs(cursor.ref, newRef) reports the changed-file count.
//      Shows "vOLD → vNEW, N files changed".
//   3. "Import changes" → the files changed between the two refs that this
//      project holds each take ONE file revision (reviseDcsFiles, AQU-2459),
//      then the advanced cursor (buildCursor) is persisted to project_settings.
//
// Reuse-not-rebuild: this panel ONLY moves the adapter project's source side. Once a source head moves, downstream linked targets flag stale
// automatically via the inherited AD-9 / linked-projects invalidation
// (stale-source-read + UpstreamChangesPanel). We do not touch those here.

import { useCallback, useMemo, useRef, useState } from "react"
import { RefreshCw, DownloadCloud, CheckCircle2, AlertTriangle, Wrench, Unlink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ConfirmActionDialog } from "@/components/ConfirmActionDialog"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { useFrontierSession } from "@/hooks/useFrontierSession"
import { useProjectSettings } from "@/hooks/useProjectSettings"
import { useT } from "@/lib/i18n/I18nProvider"
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"
import { fetchProjectFiles } from "@/lib/sync/cells-read"
import { ROLE } from "@/lib/sync/role-policy"
import { DcsClient } from "@/lib/dcs/catalog"
import { readCursor, buildCursor, DCS_UPSTREAM_KEY } from "@/lib/dcs/cursor"
import { reviseDcsFiles, type DcsRevisionCounts, type DcsScan } from "@/lib/dcs/revision"
import type { DcsCatalogEntry, DcsCursor } from "@/lib/dcs/types"

// A Door43 update writes source revisions (the route's floor is
// PROJECT_LEAD 500); spec §11 puts the adapter's importer at MAINTAINER (600).
// Gate the destructive "Import changes" action at 600 to match.
const IMPORT_MIN_ROLE = ROLE.MAINTAINER

export interface DcsUpstreamPanelProps {
  projectId: string
  /** The caller's resolved role level on this (adapter) project. */
  roleLevel: number | null
  /** Injected DCS client for tests; defaults to a real git.door43.org client. */
  client?: DcsClient
}

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; latest: DcsCatalogEntry }
  | { kind: "update-available"; latest: DcsCatalogEntry; changedFiles: number }
  | { kind: "error"; message: string }

type ImportState =
  | { kind: "idle" }
  | { kind: "importing" }
  | { kind: "done"; created: number; updated: number; removed: number }
  | { kind: "error"; message: string }

// Repair is a two-step flow (adversarial-review blocker): a read-only SCAN
// that reports what would change, then an explicit CONFIRM before any source
// revision is written. The scan is a dry run of the same revisions the apply
// posts, against the same pinned ref; the apply re-checks that pin first.
type RepairState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | {
      kind: "scanned"
      entry: DcsCatalogEntry
      counts: DcsRevisionCounts
      scan: DcsScan
    }
  | { kind: "applying" }
  | { kind: "done"; repaired: number; scan: DcsScan }
  | { kind: "error"; message: string }

type DetachState =
  | { kind: "idle" }
  | { kind: "detaching" }
  | { kind: "error"; message: string }

/** True when the resolved prod release is ahead of the pinned cursor. */
/**
 * AQU-1896: the outcome line after a re-sync scan.
 *
 * Zero ops used to render one message — "Everything already matches the pinned
 * source." — for two opposite states: a scan that re-read every held file and
 * found them all correct, and a scan that resolved none of the project's files
 * upstream and therefore read nothing at all. The second is not health: a
 * project whose file ids no longer derive from any upstream path (renamed or
 * removed upstream, or an id-scheme skew) was being told it was fine, and any
 * future regression in file-id derivation was invisible here.
 *
 * So the reassuring copy is earned only by `fetchedFiles > 0`; a scan that
 * reached nothing names the cause instead, and is NOT painted success-green.
 */
function RepairDoneMessage({
  state,
  t,
}: {
  state: { repaired: number; scan: DcsScan }
  t: ReturnType<typeof useT>
}) {
  const { repaired, scan } = state
  if (repaired > 0) {
    return (
      <p className="text-xs text-emerald-700 dark:text-emerald-400">
        {t("importExport.dcs.resyncRepaired", { count: repaired })}
      </p>
    )
  }
  // Held nothing to begin with: there is genuinely nothing to check, and no
  // false claim is being made about files the scan failed to reach.
  if (scan.heldFiles > 0 && scan.resolvedFiles === 0) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
        {t("importExport.dcs.resyncNoFilesResolved", { count: scan.heldFiles })}
      </p>
    )
  }
  if (scan.resolvedFiles > 0 && scan.fetchedFiles === 0) {
    return (
      <p className="text-xs text-amber-700 dark:text-amber-300" role="status">
        {t("importExport.dcs.resyncNoFilesRead", { count: scan.resolvedFiles })}
      </p>
    )
  }
  return (
    <p className="text-xs text-emerald-700 dark:text-emerald-400">
      {t("importExport.dcs.resyncNoChanges")}
    </p>
  )
}

function isNewer(cursor: DcsCursor, latest: DcsCatalogEntry): boolean {
  // Prefer the commit SHA (authoritative); fall back to the ref/tag name.
  if (latest.commitSha && cursor.commitSha) return latest.commitSha !== cursor.commitSha
  return latest.ref !== cursor.ref
}

export function DcsUpstreamPanel({ projectId, roleLevel, client }: DcsUpstreamPanelProps) {
  const t = useT()
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null

  const { settings, patch, refresh } = useProjectSettings(projectId, roleLevel)
  const cursor = useMemo(
    () => readCursor(settings as Record<string, unknown>),
    [settings],
  )
  // AQU-686: the genesis import (importDcsResource) parses under the project's
  // persisted front-matter opt-out, so every later re-parse — update delta AND
  // repair scan — has to use the SAME option. Re-parsing without it produces
  // book-name/header/TOC/title/intro cells this adapter deliberately never
  // imported; they are absent from the file's head, so the revision inserts
  // each one and the next Door43 sync silently undoes the opt-out.
  const excludeFrontMatter = settings.importExcludeFrontMatter ?? false

  const dcs = useMemo(() => client ?? new DcsClient(), [client])

  // Project-scoped sync-token minter (per-file cache; any fileId mints a token
  // whose project claim authorizes cross-file reads). Same shape as the
  // Upstream-changes panel's getToken.
  const getJwt = useCallback(() => jwt, [jwt])
  const getToken = useMemo(
    () => buildFileScopedTokenFetcher(getJwt, projectId, {}, FRONTIER_API_URL),
    [getJwt, projectId],
  )

  const [check, setCheck] = useState<CheckState>({ kind: "idle" })
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" })
  const [repairState, setRepairState] = useState<RepairState>({ kind: "idle" })
  const [detachState, setDetachState] = useState<DetachState>({ kind: "idle" })
  const [detachConfirmOpen, setDetachConfirmOpen] = useState(false)
  const [repairConfirmOpen, setRepairConfirmOpen] = useState(false)
  const busyRef = useRef(false)

  const canImport = (roleLevel ?? 0) >= IMPORT_MIN_ROLE

  const handleCheck = useCallback(async () => {
    if (!cursor || busyRef.current) return
    busyRef.current = true
    setCheck({ kind: "checking" })
    setImportState({ kind: "idle" })
    setRepairState({ kind: "idle" })
    try {
      // Resolve the CURRENT prod release for the repo — the newest released
      // entry regardless of tag NAME. Re-fetching the pinned ref's own entry
      // only catches a MOVED tag, never a NEW tag (v8 → v9, the normal release
      // case), so it would always report "up to date". Fall back to the pinned
      // ref's entry only if the latest-release lookup returns nothing (e.g. the
      // repo has no prod release surfaced by search).
      const latest =
        (await dcs.getLatestRelease(cursor.owner, cursor.repo)) ??
        (await dcs.getCatalogEntry(cursor.owner, cursor.repo, cursor.ref))
      if (!isNewer(cursor, latest)) {
        setCheck({ kind: "up-to-date", latest })
        return
      }
      const compare = await dcs.compareRefs(cursor.owner, cursor.repo, cursor.ref, latest.ref)
      setCheck({
        kind: "update-available",
        latest,
        changedFiles: compare.changedFiles.length,
      })
    } catch (err) {
      setCheck({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, dcs])

  // The files this project holds. A Door43 update only ever touches these: a
  // project that imported one book ignores the rest of a whole-repo release.
  const heldFileIds = useCallback(async (): Promise<Set<string>> => {
    const token = await getToken("__dcs_list__")
    if (!token) throw new Error(t("importExport.dcs.syncTokenError"))
    const files = await fetchProjectFiles(projectId, token)
    return new Set(files.filter((f) => !f.deletedAt).map((f) => f.fileId))
  }, [projectId, getToken, t])

  const handleImport = useCallback(async () => {
    if (!cursor || busyRef.current) return
    if (check.kind !== "update-available") return
    if (!canImport) return
    busyRef.current = true
    setImportState({ kind: "importing" })
    const newEntry = check.latest
    try {
      // 1. Which files changed between the pinned ref and the new one.
      //    compareRefs THROWS on a throttled/empty compare body, so a broken
      //    upstream surfaces as "try again" instead of importing nothing.
      const oldEntry = await dcs.getCatalogEntry(cursor.owner, cursor.repo, cursor.ref)
      const compare = await dcs.compareRefs(newEntry.owner, newEntry.name, oldEntry.ref, newEntry.ref)

      // 2. One revision per changed file this project holds. The server aligns
      //    each against the file's head, so nothing here reads the project's
      //    source cells.
      const delta = await reviseDcsFiles({
        client: dcs,
        projectId,
        entry: newEntry,
        heldFileIds: await heldFileIds(),
        paths: compare.changedFiles,
        excludeFrontMatter,
        getToken,
      })

      // 4. Advance + persist the cursor so a subsequent "Check for updates"
      //    compares against the release we just imported.
      const advanced = buildCursor(newEntry, cursor.trackMode)
      await patch({ [DCS_UPSTREAM_KEY]: advanced } as Record<string, unknown>)

      setImportState({
        kind: "done",
        created: delta.created,
        updated: delta.updated,
        removed: delta.removed,
      })
      // Reflect the advanced pin: nothing more to import.
      setCheck({ kind: "up-to-date", latest: newEntry })
    } catch (err) {
      setImportState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, check, canImport, dcs, projectId, getToken, heldFileIds, patch, excludeFrontMatter])

  // Repair: re-read the source at the PINNED ref with today's parser and fix any
  // cells that were imported incorrectly (e.g. by a since-fixed parser bug).
  // Upstream didn't change, so "Check for updates" can never surface these — this
  // is the recovery path. Posts the same revisions an update does, told to
  // align even though each head already names this artifact; the cursor is NOT
  // advanced (the pin is unchanged).
  //
  // Two steps (adversarial-review blocker): repair deletes are tombstones that
  // hide any translations attached to the removed cells, so a one-click apply
  // could destroy work. Step 1 SCANS (a dry run) and reports counts; step 2
  // applies only after an explicit ConfirmActionDialog confirm.
  const handleRepairScan = useCallback(async () => {
    if (!cursor || busyRef.current) return
    if (!canImport) return
    busyRef.current = true
    setRepairState({ kind: "scanning" })
    try {
      const entry = await dcs.getCatalogEntry(cursor.owner, cursor.repo, cursor.ref)
      const delta = await reviseDcsFiles({
        client: dcs,
        projectId,
        entry,
        heldFileIds: await heldFileIds(),
        excludeFrontMatter,
        repair: true,
        dryRun: true,
        getToken,
      })
      const total = delta.created + delta.updated + delta.removed
      if (total === 0) {
        // Zero ops — report and stop; no confirm, no events. AQU-1896: carry
        // the scan through, because zero ops is only "nothing diverges" when
        // the scan actually read something. A scan that resolved or read none
        // of the project's files checked nothing, and the renderer says so
        // instead of claiming a match.
        setRepairState({ kind: "done", repaired: 0, scan: delta.scan })
        return
      }
      setRepairState({
        kind: "scanned",
        entry,
        counts: { created: delta.created, updated: delta.updated, removed: delta.removed },
        scan: delta.scan,
      })
      setRepairConfirmOpen(true)
    } catch (err) {
      setRepairState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, canImport, dcs, projectId, getToken, heldFileIds, excludeFrontMatter])

  const handleRepairApply = useCallback(async () => {
    if (!cursor || busyRef.current) return
    if (!canImport) return
    if (repairState.kind !== "scanned") return
    const { entry } = repairState
    busyRef.current = true
    setRepairState({ kind: "applying" })
    try {
      // Between confirm and apply another tab may have detached the project or
      // imported a newer release. Re-read the settings cursor from the server
      // and ABORT unless it still pins the exact revision we scanned — the
      // counts the user confirmed were for that pin (and a detached project
      // must not be written into).
      const fresh = await refresh()
      const freshCursor = fresh ? readCursor(fresh.settings as Record<string, unknown>) : null
      if (!freshCursor || freshCursor.commitSha !== cursor.commitSha) {
        setRepairState({
          kind: "error",
          message: t("importExport.dcs.repairStaleCursorError"),
        })
        return
      }
      const applied = await reviseDcsFiles({
        client: dcs,
        projectId,
        entry,
        heldFileIds: await heldFileIds(),
        excludeFrontMatter,
        repair: true,
        getToken,
      })
      setRepairState({
        kind: "done",
        repaired: applied.created + applied.updated + applied.removed,
        scan: applied.scan,
      })
    } catch (err) {
      setRepairState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, canImport, repairState, refresh, dcs, projectId, heldFileIds, excludeFrontMatter, getToken, t])

  // Detach: the ONLY sanctioned way out of the DCS lockdown. Persist the
  // settings with the dcsUpstream key REMOVED. patch() merges shallowly (the
  // client sends the full merged settings object), so we write an explicit
  // `null` — readCursor treats null as absent, which unlocks source editing
  // (useDcsUpstreamCursor → canEditSource) and makes this panel render its
  // no-cursor state. Relinking requires a fresh Door43 import.
  const handleDetach = useCallback(async () => {
    if (!cursor || busyRef.current) return
    if (!canImport) return
    busyRef.current = true
    setDetachState({ kind: "detaching" })
    setCheck({ kind: "idle" })
    setImportState({ kind: "idle" })
    setRepairState({ kind: "idle" })
    try {
      const out = await patch({ [DCS_UPSTREAM_KEY]: null } as Record<string, unknown>)
      if (out.kind === "ok") {
        // The settings hook re-renders us with cursor === null; nothing to show.
        setDetachState({ kind: "idle" })
      } else {
        setDetachState({
          kind: "error",
          message:
            out.kind === "error"
              ? out.message
              : out.kind === "blocked"
                ? t("importExport.dcs.settingsBlocked", { reason: out.reason })
                : t("importExport.dcs.settingsConflict"),
        })
      }
    } catch (err) {
      setDetachState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, canImport, patch, t])

  // Not a DCS adapter project (or just detached) — render nothing.
  if (!cursor) return null

  const checking = check.kind === "checking"
  const importing = importState.kind === "importing"
  const repairing = repairState.kind === "scanning" || repairState.kind === "applying"
  const detaching = detachState.kind === "detaching"

  return (
    <Card id="section-dcs-upstream">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DownloadCloud className="h-4 w-4 text-muted-foreground" />
          {t("projectSettings.section.dcsUpstream")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">
          {t("importExport.dcs.panelDescription")}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {/* i18n-exempt Door43 owner/repo identifier */}
          <Badge variant="outline">{cursor.owner}/{cursor.repo}</Badge>
          <Badge variant="secondary">{t("importExport.dcs.pinnedRefBadge", { ref: cursor.ref })}</Badge>
          <Badge variant="outline">
            {cursor.trackMode === "head"
              ? t("importExport.dcs.trackingHead")
              : t("importExport.dcs.trackingRelease")}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleCheck}
            disabled={checking || importing || repairing || detaching || !jwt}
          >
            {checking ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            {t("importExport.dcs.checkForUpdates")}
          </Button>
        </div>

        {check.kind === "up-to-date" && (
          <div className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            {t("importExport.dcs.upToDateWith", { ref: check.latest.ref })}
          </div>
        )}

        {check.kind === "update-available" && (
          <div className="space-y-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950">
            <p className="font-medium text-amber-900 dark:text-amber-100">
              {t("importExport.dcs.updateAvailable", {
                count: check.changedFiles,
                oldRef: cursor.ref,
                newRef: check.latest.ref,
              })}
            </p>
            <p className="text-amber-800 dark:text-amber-200">
              {t("importExport.dcs.importAdvancesNote", { ref: check.latest.ref })}
            </p>
            {canImport ? (
              <div className="flex justify-end">
                <Button onClick={handleImport} disabled={importing || repairing || detaching}>
                  {importing ? <Spinner className="h-4 w-4" /> : <DownloadCloud className="h-4 w-4" />}
                  {t("importExport.dcs.importChanges")}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {t("importExport.dcs.importRoleRequired")}
              </p>
            )}
          </div>
        )}

        {check.kind === "error" && (
          <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("importExport.dcs.checkFailed", { message: check.message })}</span>
          </div>
        )}

        {importState.kind === "done" && (
          <div className="flex items-start gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              {t("importExport.dcs.importSummary", {
                created: importState.created,
                updated: importState.updated,
                removed: importState.removed,
              })}
            </span>
          </div>
        )}

        {importState.kind === "error" && (
          <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("importExport.dcs.importFailed", { message: importState.message })}</span>
          </div>
        )}

        {canImport && (
          <div className="space-y-1 border-t pt-3">
            <Button
              variant="ghost"
              onClick={handleRepairScan}
              disabled={checking || importing || repairing || detaching || !jwt}
            >
              {repairing ? <Spinner className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}
              {t("importExport.dcs.resyncButton")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("importExport.dcs.resyncHint")}
            </p>
            {repairState.kind === "scanned" && (
              <div className="space-y-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950">
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  {t("importExport.dcs.resyncScanSummary", {
                    repair: repairState.counts.updated,
                    created: repairState.counts.created,
                    removed: repairState.counts.removed,
                  })}
                </p>
                {repairState.counts.removed > 0 && (
                  <p className="text-amber-800 dark:text-amber-200">
                    {t("importExport.dcs.resyncRemovalWarning", {
                      count: repairState.counts.removed,
                    })}
                  </p>
                )}
                <div className="flex justify-end">
                  <Button
                    variant="destructive"
                    onClick={() => setRepairConfirmOpen(true)}
                    disabled={checking || importing || detaching}
                  >
                    <Wrench className="h-4 w-4" />
                    {t("importExport.dcs.applyResyncEllipsis")}
                  </Button>
                </div>
                <ConfirmActionDialog
                  open={repairConfirmOpen}
                  onOpenChange={setRepairConfirmOpen}
                  title={t("importExport.dcs.applyResyncConfirmTitle")}
                  description={`${t("importExport.dcs.applyResyncConfirmRepairs", {
                    count: repairState.counts.updated,
                    created: repairState.counts.created,
                  })} ${t("importExport.dcs.applyResyncConfirmRemovals", {
                    count: repairState.counts.removed,
                  })}`}
                  confirmLabel={t("importExport.dcs.applyResyncConfirmLabel")}
                  checkboxLabel={t("importExport.dcs.applyResyncCheckbox")}
                  variant="destructive"
                  onConfirm={() => { void handleRepairApply() }}
                />
              </div>
            )}
            {repairState.kind === "done" && <RepairDoneMessage state={repairState} t={t} />}
            {repairState.kind === "error" && (
              <p className="text-xs text-destructive">
                {t("importExport.dcs.resyncFailed", { message: repairState.message })}
              </p>
            )}
          </div>
        )}

        {canImport && (
          <div className="space-y-1 border-t pt-3">
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDetachConfirmOpen(true)}
              disabled={checking || importing || repairing || detaching}
            >
              {detaching ? <Spinner className="h-4 w-4" /> : <Unlink className="h-4 w-4" />}
              {t("importExport.dcs.detachButton")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("importExport.dcs.detachHint", { repo: `${cursor.owner}/${cursor.repo}` })}
            </p>
            {detachState.kind === "error" && (
              <p className="text-xs text-destructive">
                {t("importExport.dcs.detachFailed", { message: detachState.message })}
              </p>
            )}
            <ConfirmActionDialog
              open={detachConfirmOpen}
              onOpenChange={setDetachConfirmOpen}
              title={t("importExport.dcs.detachConfirmTitle")}
              description={t("importExport.dcs.detachConfirmDescription", {
                repo: `${cursor.owner}/${cursor.repo}`,
              })}
              confirmLabel={t("projectSettings.sourceLink.detachConfirmButton")}
              checkboxLabel={t("importExport.dcs.detachConfirmCheckbox")}
              variant="destructive"
              onConfirm={() => { void handleDetach() }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
