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
//   3. "Import changes" → build the currentCells map from the adapter project's
//      source cells (fetchProjectFiles + fetchAllFileCells(side:"source")),
//      computeDelta(), applyDelta() bound to the typed source emitters
//      (source.cell.create / emitSourceCellCommit / emitSourceCellDelete), then
//      persist the advanced cursor (buildCursor) back to project_settings.
//
// Reuse-not-rebuild: this panel ONLY produces source events into the adapter
// project. Once a source head moves, downstream linked targets flag stale
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
import { buildFileScopedTokenFetcher } from "@/lib/sync/cqrs-bridge"
import { FRONTIER_API_URL } from "@/lib/sync/sync-token"
import { fetchProjectFiles, fetchAllFileCells } from "@/lib/sync/cells-read"
import {
  emitSourceCellCommit,
  emitSourceCellDelete,
  enqueueEvent,
} from "@/lib/sync/events-emit"
import { ROLE } from "@/lib/sync/role-policy"
import { DcsClient } from "@/lib/dcs/catalog"
import { contentHash } from "@/lib/dcs/content-hash"
import { readCursor, buildCursor, DCS_UPSTREAM_KEY } from "@/lib/dcs/cursor"
import {
  computeDelta,
  computeRepairDelta,
  applyDelta,
  repairRevisionToken,
  type CurrentCell,
  type DeltaEmitters,
  type DeltaResult,
} from "@/lib/dcs/delta"
import type { DcsCatalogEntry, DcsCursor } from "@/lib/dcs/types"

// Running a DCS delta writes source.cell.* events (role-policy floor is
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
// event is emitted. `scanned` carries everything the apply step needs so the
// delta is computed exactly once and what the user confirmed is what runs.
type RepairState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | {
      kind: "scanned"
      entry: DcsCatalogEntry
      currentCells: Map<string, CurrentCell>
      delta: DeltaResult
    }
  | { kind: "applying" }
  | { kind: "done"; repaired: number }
  | { kind: "error"; message: string }

type DetachState =
  | { kind: "idle" }
  | { kind: "detaching" }
  | { kind: "error"; message: string }

/** True when the resolved prod release is ahead of the pinned cursor. */
function isNewer(cursor: DcsCursor, latest: DcsCatalogEntry): boolean {
  // Prefer the commit SHA (authoritative); fall back to the ref/tag name.
  if (latest.commitSha && cursor.commitSha) return latest.commitSha !== cursor.commitSha
  return latest.ref !== cursor.ref
}

export function DcsUpstreamPanel({ projectId, roleLevel, client }: DcsUpstreamPanelProps) {
  const { session } = useFrontierSession()
  const jwt = session?.jwt ?? null
  const author = session?.username ?? "local"

  const { settings, patch, refresh } = useProjectSettings(projectId, roleLevel)
  const cursor = useMemo(
    () => readCursor(settings as Record<string, unknown>),
    [settings],
  )

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

  // Shared apply path: bind the classified delta to the REAL typed source
  // emitters and run applyDelta. Both "Import changes" (upstream advance) and
  // "Re-sync content" (same-ref repair) apply through this identical wiring so
  // outbox routing, idempotent event ids, and fileId resolution never diverge.
  const runApply = useCallback(
    async (
      delta: DeltaResult,
      currentCells: Map<string, CurrentCell>,
      ctx: { repo: string; sha: string },
    ) => {
      const fileIdByCellId = new Map<string, string>()
      for (const [cellId, cur] of currentCells) fileIdByCellId.set(cellId, cur.fileId)

      const emitters: DeltaEmitters = {
        // Deterministic event id (from applyDelta) is threaded through as the
        // outbox event `id` so a re-run dedupes idempotently (server /import is
        // idempotent on event id). A new cell has no existing projection row, so
        // its fileId comes from the parsed DcsFile via the delta (CreateArg.fileId)
        // — NOT from currentCells (which would miss and fall back to a phantom id).
        create: async ({ eventId, cell, fileId }) => {
          const { eventId: id } = await enqueueEvent({
            kind: "source.cell.create",
            projectId,
            fileId,
            cellId: cell.cellId,
            parentId: null,
            author,
            id: eventId,
            payload: {
              cellId: cell.cellId,
              anchorCellId: null,
              value: cell.value,
              ...(cell.valueHtml !== undefined ? { valueHtml: cell.valueHtml } : {}),
              ...(cell.type !== undefined ? { type: cell.type } : {}),
              ...(cell.canonicalRef !== undefined ? { canonicalRef: cell.canonicalRef } : {}),
              ...(cell.metadata !== undefined ? { metadata: cell.metadata } : {}),
              ...(cell.sequenceIndex !== undefined ? { sequenceIndex: cell.sequenceIndex } : {}),
            },
          })
          return id
        },
        commit: async ({ eventId, parentEventId, cell }) => {
          const fileId = fileIdByCellId.get(cell.cellId) ?? cell.cellId
          return emitSourceCellCommit({
            projectId,
            fileId,
            cellId: cell.cellId,
            parentId: parentEventId,
            value: cell.value,
            ...(cell.valueHtml !== undefined ? { valueHtml: cell.valueHtml } : {}),
            id: eventId,
            author,
          })
        },
        delete: async ({ cellId }) => {
          const fileId = fileIdByCellId.get(cellId) ?? cellId
          return emitSourceCellDelete({ projectId, fileId, cellId, author })
        },
      }

      await applyDelta(delta, emitters, { projectId, repo: ctx.repo, sha: ctx.sha })
    },
    [projectId, author],
  )

  const handleImport = useCallback(async () => {
    if (!cursor || busyRef.current) return
    if (check.kind !== "update-available") return
    if (!canImport) return
    busyRef.current = true
    setImportState({ kind: "importing" })
    const newEntry = check.latest
    try {
      // 1. Resolve the OLD catalog entry the cursor points at — computeDelta
      //    needs both entries (its refType picks the raw-fetch kind).
      const oldEntry = await dcs.getCatalogEntry(cursor.owner, cursor.repo, cursor.ref)

      // 2. Build the adapter project's CURRENT source cells from the projection.
      //    fetchProjectFiles → fetchAllFileCells(side:"source"), hashing each
      //    cell's value with the SAME djb2 the server + delta engine use so
      //    unchanged cells are suppressed. Keyed by cellId; carries the chain
      //    head eventId (the parent for a commit) and the owning fileId (deletes
      //    are scoped by file).
      const currentCells = await buildCurrentCells(projectId, getToken)

      // 3. Compute + apply the delta through the typed source emitters.
      const delta = await computeDelta({
        client: dcs,
        cursor,
        oldEntry,
        newEntry,
        currentCells,
      })

      await runApply(delta, currentCells, {
        repo: newEntry.fullName,
        sha: newEntry.commitSha,
      })

      // 4. Advance + persist the cursor so a subsequent "Check for updates"
      //    compares against the release we just imported.
      const advanced = buildCursor(newEntry, cursor.trackMode)
      await patch({ [DCS_UPSTREAM_KEY]: advanced } as Record<string, unknown>)

      setImportState({
        kind: "done",
        created: delta.creates.length,
        updated: delta.commits.length,
        removed: delta.deletes.length,
      })
      // Reflect the advanced pin: nothing more to import.
      setCheck({ kind: "up-to-date", latest: newEntry })
    } catch (err) {
      setImportState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, check, canImport, dcs, projectId, getToken, runApply, patch])

  // Repair: re-read the source at the PINNED ref with today's parser and fix any
  // cells that were imported incorrectly (e.g. by a since-fixed parser bug).
  // Upstream didn't change, so "Check for updates" can never surface these — this
  // is the recovery path. Applies through the SAME runApply wiring; the cursor is
  // NOT advanced (the pin is unchanged).
  //
  // Two steps (adversarial-review blocker): repair deletes are tombstones that
  // hide any translations attached to the removed cells, so a one-click apply
  // could destroy work. Step 1 SCANS (no events) and reports counts; step 2
  // applies only after an explicit ConfirmActionDialog confirm.
  const handleRepairScan = useCallback(async () => {
    if (!cursor || busyRef.current) return
    if (!canImport) return
    busyRef.current = true
    setRepairState({ kind: "scanning" })
    try {
      const entry = await dcs.getCatalogEntry(cursor.owner, cursor.repo, cursor.ref)
      const currentCells = await buildCurrentCells(projectId, getToken)
      const delta = await computeRepairDelta({ client: dcs, entry, currentCells })
      const total = delta.creates.length + delta.commits.length + delta.deletes.length
      if (total === 0) {
        // Nothing diverges from the pinned source — report and stop; no
        // confirm, no events.
        setRepairState({ kind: "done", repaired: 0 })
        return
      }
      setRepairState({ kind: "scanned", entry, currentCells, delta })
      setRepairConfirmOpen(true)
    } catch (err) {
      setRepairState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, canImport, dcs, projectId, getToken])

  const handleRepairApply = useCallback(async () => {
    if (!cursor || busyRef.current) return
    if (!canImport) return
    if (repairState.kind !== "scanned") return
    const { entry, currentCells, delta } = repairState
    busyRef.current = true
    setRepairState({ kind: "applying" })
    try {
      // Between confirm and apply another tab may have detached the project or
      // imported a newer release. Re-read the settings cursor from the server
      // and ABORT unless it still pins the exact revision we scanned — applying
      // a stale delta would tombstone cells that no longer diverge (or write
      // into a detached project).
      const fresh = await refresh()
      const freshCursor = fresh ? readCursor(fresh.settings as Record<string, unknown>) : null
      if (!freshCursor || freshCursor.commitSha !== cursor.commitSha) {
        setRepairState({
          kind: "error",
          message:
            "the upstream link changed while confirming (detached or re-imported in another tab). Nothing was applied — run the scan again.",
        })
        return
      }
      await runApply(delta, currentCells, {
        repo: entry.fullName,
        // NOT the bare pinned sha — the original import already minted event ids
        // at that revision, and reusing them would make the server silently drop
        // every repair commit. See repairRevisionToken.
        sha: repairRevisionToken(entry.commitSha, delta),
      })
      setRepairState({
        kind: "done",
        repaired: delta.creates.length + delta.commits.length + delta.deletes.length,
      })
    } catch (err) {
      setRepairState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, canImport, repairState, refresh, runApply])

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
                ? `blocked (${out.reason})`
                : "conflict — settings changed elsewhere; try again",
        })
      }
    } catch (err) {
      setDetachState({ kind: "error", message: err instanceof Error ? err.message : String(err) })
    } finally {
      busyRef.current = false
    }
  }, [cursor, canImport, patch])

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
          Door43 upstream
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-sm text-muted-foreground">
          This project mirrors a Door43 resource. Check for a newer published
          release and import upstream changes into the source lane.
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="outline">{cursor.owner}/{cursor.repo}</Badge>
          <Badge variant="secondary">pinned {cursor.ref}</Badge>
          <Badge variant="outline">
            {cursor.trackMode === "head" ? "tracking HEAD" : "tracking release"}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheck}
            disabled={checking || importing || repairing || detaching || !jwt}
          >
            {checking ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}
            Check for updates
          </Button>
        </div>

        {check.kind === "up-to-date" && (
          <div className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            Up to date with {check.latest.ref}.
          </div>
        )}

        {check.kind === "update-available" && (
          <div className="space-y-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950">
            <p className="font-medium text-amber-900 dark:text-amber-100">
              {cursor.ref} → {check.latest.ref}, {check.changedFiles}{" "}
              {check.changedFiles === 1 ? "file" : "files"} changed
            </p>
            <p className="text-amber-800 dark:text-amber-200">
              Importing advances the source cells to {check.latest.ref}.
              Downstream linked projects will show stale flags for the affected
              cells so translators can review them.
            </p>
            {canImport ? (
              <div className="flex justify-end">
                <Button size="sm" onClick={handleImport} disabled={importing || repairing || detaching}>
                  {importing ? <Spinner className="h-4 w-4" /> : <DownloadCloud className="h-4 w-4" />}
                  Import changes
                </Button>
              </div>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                Maintainer or above required to import upstream changes.
              </p>
            )}
          </div>
        )}

        {check.kind === "error" && (
          <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Could not check for updates: {check.message}</span>
          </div>
        )}

        {importState.kind === "done" && (
          <div className="flex items-start gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            <span>
              Imported: {importState.created} created, {importState.updated}{" "}
              updated, {importState.removed} removed. Downstream linked projects
              will now show stale flags for the changed cells.
            </span>
          </div>
        )}

        {importState.kind === "error" && (
          <div className="flex items-start gap-2 rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Import failed: {importState.message}</span>
          </div>
        )}

        {canImport && (
          <div className="space-y-1 border-t pt-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRepairScan}
              disabled={checking || importing || repairing || detaching || !jwt}
            >
              {repairing ? <Spinner className="h-4 w-4" /> : <Wrench className="h-4 w-4" />}
              Re-sync content
            </Button>
            <p className="text-xs text-muted-foreground">
              Scans the source at the pinned version for cells that were
              imported incorrectly. Nothing is changed until you confirm.
            </p>
            {repairState.kind === "scanned" && (
              <div className="space-y-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-800 dark:bg-amber-950">
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  Scan complete: {repairState.delta.commits.length} to repair,{" "}
                  {repairState.delta.creates.length} new,{" "}
                  {repairState.delta.deletes.length} to remove.
                </p>
                {repairState.delta.deletes.length > 0 && (
                  <p className="text-amber-800 dark:text-amber-200">
                    {repairState.delta.deletes.length}{" "}
                    {repairState.delta.deletes.length === 1 ? "cell" : "cells"} will be
                    removed — translations attached to them will be hidden.
                  </p>
                )}
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setRepairConfirmOpen(true)}
                    disabled={checking || importing || detaching}
                  >
                    <Wrench className="h-4 w-4" />
                    Apply re-sync…
                  </Button>
                </div>
                <ConfirmActionDialog
                  open={repairConfirmOpen}
                  onOpenChange={setRepairConfirmOpen}
                  title="Apply re-sync?"
                  description={`${repairState.delta.commits.length} ${repairState.delta.commits.length === 1 ? "cell" : "cells"} will be repaired and ${repairState.delta.creates.length} created. ${repairState.delta.deletes.length} ${repairState.delta.deletes.length === 1 ? "cell" : "cells"} will be removed — translations attached to removed cells will be hidden.`}
                  confirmLabel="Apply re-sync"
                  checkboxLabel="I understand removed cells hide their translations."
                  variant="destructive"
                  onConfirm={() => { void handleRepairApply() }}
                />
              </div>
            )}
            {repairState.kind === "done" && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400">
                {repairState.repaired === 0
                  ? "Everything already matches the pinned source."
                  : `Repaired ${repairState.repaired} ${repairState.repaired === 1 ? "cell" : "cells"}.`}
              </p>
            )}
            {repairState.kind === "error" && (
              <p className="text-xs text-destructive">
                Re-sync failed: {repairState.message}
              </p>
            )}
          </div>
        )}

        {canImport && (
          <div className="space-y-1 border-t pt-3">
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => setDetachConfirmOpen(true)}
              disabled={checking || importing || repairing || detaching}
            >
              {detaching ? <Spinner className="h-4 w-4" /> : <Unlink className="h-4 w-4" />}
              Detach from upstream
            </Button>
            <p className="text-xs text-muted-foreground">
              Permanently unlink this project from {cursor.owner}/{cursor.repo} and
              make source cells editable again.
            </p>
            {detachState.kind === "error" && (
              <p className="text-xs text-destructive">
                Detach failed: {detachState.message}
              </p>
            )}
            <ConfirmActionDialog
              open={detachConfirmOpen}
              onOpenChange={setDetachConfirmOpen}
              title="Detach from upstream?"
              description={`This project will stop receiving updates from ${cursor.owner}/${cursor.repo}. Source cells become editable. This cannot be undone from here — relinking requires a fresh import.`}
              confirmLabel="Detach"
              checkboxLabel="I understand this permanently unlinks the project."
              variant="destructive"
              onConfirm={() => { void handleDetach() }}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * Build the adapter project's current SOURCE cells keyed by cellId. Streams
 * every file's source rows and hashes each cell's plain value with the shared
 * djb2 (`@/lib/dcs/content-hash`) so no-op suppression matches the server.
 */
async function buildCurrentCells(
  projectId: string,
  getToken: (fileId: string) => Promise<string | null>,
): Promise<Map<string, CurrentCell>> {
  const out = new Map<string, CurrentCell>()
  // Any fileId mints a project-scoped token (the token's project claim, not the
  // fileId, is what authorizes the reads).
  const listToken = await getToken("__dcs_list__")
  if (!listToken) throw new Error("Could not mint a sync token for this project.")
  const files = await fetchProjectFiles(projectId, listToken)
  for (const file of files) {
    const fileToken = (await getToken(file.fileId)) ?? listToken
    const rows = await fetchAllFileCells(projectId, file.fileId, fileToken, "source")
    for (const row of rows) {
      out.set(row.cellId, {
        eventId: row.eventId,
        contentHash: contentHash(row.value),
        fileId: file.fileId,
      })
    }
  }
  return out
}
