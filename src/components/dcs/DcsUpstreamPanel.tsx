// DCS freshness / delta panel (spec §6, §9 step 3) — the "Check for updates /
// Import changes" surface for a Door43-linked ADAPTER project (one whose
// project_settings carries a `dcsUpstream` cursor).
//
// Flow:
//   1. Read the pinned cursor via readCursor(settings). No cursor ⇒ render
//      nothing (this project is not a DCS adapter).
//   2. "Check for updates" → client.getCatalogEntry(owner, repo, ref) to
//      resolve the current prod release, compare its commitSha/ref against the
//      cursor; if newer, client.compareRefs(cursor.ref, newRef) reports the
//      changed-file count. Shows "vOLD → vNEW, N files changed".
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
import { RefreshCw, DownloadCloud, CheckCircle2, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { computeDelta, applyDelta, type CurrentCell, type DeltaEmitters } from "@/lib/dcs/delta"
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

  const { settings, patch } = useProjectSettings(projectId, roleLevel)
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
  const busyRef = useRef(false)

  const canImport = (roleLevel ?? 0) >= IMPORT_MIN_ROLE

  const handleCheck = useCallback(async () => {
    if (!cursor || busyRef.current) return
    busyRef.current = true
    setCheck({ kind: "checking" })
    setImportState({ kind: "idle" })
    try {
      // Resolve the current prod release. For a release-tracking cursor we ask
      // for the pinned ref's entry family; the catalog returns the entry AT
      // that ref, but a fresh prod release carries a newer commitSha even at a
      // moved tag — so we resolve via the cursor's ref (release track) and let
      // the SHA comparison catch a moved release. trackMode "head" pins to the
      // branch head, which advances under the same ref.
      const latest = await dcs.getCatalogEntry(cursor.owner, cursor.repo, cursor.ref)
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

      const fileIdByCellId = new Map<string, string>()
      for (const [cellId, cur] of currentCells) fileIdByCellId.set(cellId, cur.fileId)

      const emitters: DeltaEmitters = {
        // Deterministic event id (from applyDelta) is threaded through as the
        // outbox event `id` so a re-run dedupes idempotently (server /import is
        // idempotent on event id). New cells have no existing fileId in the
        // projection — use the parsed DcsFile's fileId already stamped on the
        // cell path via delta; here we fall back to the cell's own file mapping.
        create: async ({ eventId, cell }) => {
          const fileId = fileIdByCellId.get(cell.cellId) ?? cell.cellId
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

      await applyDelta(delta, emitters, {
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
  }, [cursor, check, canImport, dcs, projectId, getToken, author, patch])

  // Not a DCS adapter project — render nothing.
  if (!cursor) return null

  const checking = check.kind === "checking"
  const importing = importState.kind === "importing"

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
            disabled={checking || importing || !jwt}
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
                <Button size="sm" onClick={handleImport} disabled={importing}>
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
