/**
 * Load the complete cell corpus for project-wide exports, terminology, and
 * glossary workflows.
 *
 * The old implementation unrolled 40 `useCells` calls to satisfy the Rules of
 * Hooks, then silently truncated larger projects. Scripture projects commonly
 * contain 66+ files, so completeness is a correctness requirement. This hook
 * performs imperative, paginated reads with bounded concurrency instead: no
 * hook-count limit, stable input order, and all-or-nothing publication.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { buildCellData, type CellData } from "@/hooks/useCells"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import type { CellRow } from "@/lib/sync/cells-read-types"
import { peekOutboxBatch, subscribeToOutbox } from "@/lib/sync/outbox"

const LOAD_CONCURRENCY = 4
const OUTBOX_READ_LIMIT = 10_000

export interface ProjectFileCells {
  fileId: string
  fileName: string
  cells: CellData[]
}

interface ProjectFileInput {
  id: string
  name: string
  type: string
}

export interface UseProjectCellsResult {
  /** Every requested file, in the same order as projectFiles. */
  files: ProjectFileCells[]
  /** True until the complete project snapshot has loaded. */
  isLoading: boolean
  /** Retained for callers compiled against the old contract; always false. */
  isTruncated: boolean
  /** A complete snapshot is never published when one file fails. */
  error?: Error
  /**
   * Soft refetch of the server snapshot — call after a known write so the
   * corpus reflects it. Unlike the initial load this keeps the current
   * snapshot on screen while the new one streams in (no blanking, no spinner).
   */
  revalidate: () => void
  /**
   * Optimistically patch a target-side cell so a caller that commits through
   * `emitTargetCellCommit` sees its own edit immediately, without waiting on
   * the outbox overlay's debounce. The shadow is dropped once an authoritative
   * snapshot reports the same value (see `reconcileOptimisticEdits`).
   */
  applyOptimisticTargetEdit: (
    cell: { cellId: string; fileId: string },
    patch: { value: string; valueHtml?: string; aiDrafted?: boolean },
  ) => void
}

export interface UseProjectCellsOpts {
  projectId: string | null
  projectFiles: ProjectFileInput[]
  getToken: (fileId: string) => Promise<string | null>
  /** Pass false to defer fetching (e.g. while scope !== "project"). */
  enabled?: boolean
  /** Target-language lane. Empty/omitted selects the legacy default lane. */
  lane?: string
}

type FileRowsLoader = (
  projectId: string,
  fileId: string,
  token: string,
  side?: "source" | "target",
  lane?: string,
) => Promise<CellRow[]>

/** Convert a server snapshot into the paired source/target view used by exporters. */
export function buildProjectCellSnapshot(
  rows: readonly CellRow[],
  fileId: string,
  lane = "",
): CellData[] {
  const sources = new Map<string, CellRow>()
  const targets = new Map<string, CellRow>()
  const order: string[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    let belongsToSnapshot = false
    if (row.side === "source") {
      if (!sources.has(row.cellId)) sources.set(row.cellId, row)
      belongsToSnapshot = true
    } else if ((row.targetLang ?? "") === lane && !targets.has(row.cellId)) {
      targets.set(row.cellId, row)
      belongsToSnapshot = true
    }
    if (belongsToSnapshot && !seen.has(row.cellId)) {
      seen.add(row.cellId)
      order.push(row.cellId)
    }
  }

  return order.map((cellId) =>
    buildCellData(
      cellId,
      sources.get(cellId),
      targets.get(cellId),
      fileId,
      "local",
      1,
      undefined,
    ),
  )
}

/**
 * Fetch all project files with a small worker pool. Results are assigned by
 * input index, so response timing cannot reorder the exported project.
 */
export async function loadProjectCellFiles(
  args: {
    projectId: string
    projectFiles: readonly ProjectFileInput[]
    getToken: (fileId: string) => Promise<string | null>
    lane?: string
  },
  loadRows: FileRowsLoader = fetchAllFileCells,
): Promise<ProjectFileCells[]> {
  const results = new Array<ProjectFileCells>(args.projectFiles.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++
      if (index >= args.projectFiles.length) return
      const file = args.projectFiles[index]
      const token = await args.getToken(file.id)
      if (!token) throw new Error(`Couldn't get a read token for ${file.name}.`)
      const rows = await loadRows(args.projectId, file.id, token, undefined, args.lane)
      results[index] = {
        fileId: file.id,
        fileName: file.name,
        cells: buildProjectCellSnapshot(rows, file.id, args.lane),
      }
    }
  }

  const workers = Math.min(LOAD_CONCURRENCY, args.projectFiles.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

interface PendingTargetEdit {
  value: string
  valueHtml?: string
  aiDrafted: boolean
}

/** Overlay map key. Cell ids are unique per file, not per project. */
export function overlayKey(fileId: string, cellId: string): string {
  return `${fileId}\0${cellId}`
}

/**
 * Drop optimistic shadows the server has caught up with.
 *
 * A shadow outlives the outbox row that produced it: the flusher deletes the
 * row the moment the write is accepted, which removes the pending overlay. If
 * the shadow were cleared at the same moment the cell would visibly snap back
 * to the pre-edit snapshot until something remounted the hook. So a shadow is
 * retired only when an authoritative snapshot actually reports its value.
 */
export function reconcileOptimisticEdits(
  optimistic: ReadonlyMap<string, PendingTargetEdit>,
  files: readonly ProjectFileCells[],
): ReadonlyMap<string, PendingTargetEdit> {
  if (optimistic.size === 0) return optimistic
  const next = new Map(optimistic)
  for (const file of files) {
    for (const cell of file.cells) {
      const key = overlayKey(file.fileId, cell.id)
      const shadow = next.get(key)
      if (shadow && shadow.value === cell.translated) next.delete(key)
    }
  }
  return next.size === optimistic.size ? optimistic : next
}

function overlayPendingEdits(
  files: ProjectFileCells[],
  pending: ReadonlyMap<string, PendingTargetEdit>,
): ProjectFileCells[] {
  if (pending.size === 0) return files
  return files.map((file) => ({
    ...file,
    cells: file.cells.map((cell) => {
      const edit = pending.get(overlayKey(file.fileId, cell.id))
      if (!edit) return cell
      return {
        ...cell,
        translated: edit.value,
        translatedHtml: edit.valueHtml ?? cell.translatedHtml,
        aiDrafted: edit.aiDrafted,
        hasPendingEdit: true,
        status: edit.value.trim() ? "unvalidated" : "empty",
      }
    }),
  }))
}

export function useProjectCells({
  projectId,
  projectFiles,
  getToken,
  enabled = true,
  lane = "",
}: UseProjectCellsOpts): UseProjectCellsResult {
  const [serverFiles, setServerFiles] = useState<ProjectFileCells[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | undefined>()
  const [pending, setPending] = useState<ReadonlyMap<string, PendingTargetEdit>>(new Map())
  const [optimistic, setOptimistic] = useState<ReadonlyMap<string, PendingTargetEdit>>(new Map())
  const [reloadNonce, setReloadNonce] = useState(0)
  const generationRef = useRef(0)
  // Set by revalidate() so the load effect can tell a refetch-after-write from
  // a first load and skip the blanking + spinner.
  const softReloadRef = useRef(false)

  const revalidate = useCallback(() => {
    softReloadRef.current = true
    setReloadNonce((n) => n + 1)
  }, [])

  const applyOptimisticTargetEdit = useCallback(
    (
      cell: { cellId: string; fileId: string },
      patch: { value: string; valueHtml?: string; aiDrafted?: boolean },
    ) => {
      setOptimistic((prev) => {
        const next = new Map(prev)
        next.set(overlayKey(cell.fileId, cell.cellId), {
          value: patch.value,
          valueHtml: patch.valueHtml,
          aiDrafted: patch.aiDrafted === true,
        })
        return next
      })
    },
    [],
  )

  // Depend on content, not the caller's array identity. ProjectWorkspace maps
  // its file list inline and would otherwise restart a whole-project read on
  // every render.
  const filesKey = JSON.stringify(projectFiles.map(({ id, name, type }) => [id, name, type]))
  const requestedFiles = useMemo(
    () => projectFiles.map((file) => ({ ...file })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filesKey],
  )

  useEffect(() => {
    const generation = ++generationRef.current
    // Consume the flag here: whatever this run is, the next one is a hard load
    // unless revalidate() says otherwise.
    const soft = softReloadRef.current
    softReloadRef.current = false
    let cancelled = false
    if (!enabled || !projectId || requestedFiles.length === 0) {
      setServerFiles([])
      setOptimistic(new Map())
      setIsLoading(false)
      setError(undefined)
      return
    }

    if (!soft) {
      setServerFiles([])
      setOptimistic(new Map())
      setIsLoading(true)
    }
    setError(undefined)
    void loadProjectCellFiles({ projectId, projectFiles: requestedFiles, getToken, lane })
      .then((files) => {
        if (cancelled || generation !== generationRef.current) return
        setServerFiles(files)
        setOptimistic((prev) => reconcileOptimisticEdits(prev, files))
        setIsLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled || generation !== generationRef.current) return
        // A soft refetch that fails keeps the last good snapshot on screen —
        // the caller's write already landed in the outbox and is still shown
        // through the pending/optimistic overlays.
        if (!soft) setServerFiles([])
        setError(cause instanceof Error ? cause : new Error(String(cause)))
        setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled, getToken, lane, projectId, reloadNonce, requestedFiles])

  // Match useCells' pending-edit semantics so a project export includes edits
  // still queued locally, while quarantined writes remain excluded.
  useEffect(() => {
    if (!enabled || !projectId) {
      setPending(new Map())
      return
    }
    const fileIds = new Set(requestedFiles.map((file) => file.id))
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    async function refreshPending(): Promise<void> {
      try {
        const rows = await peekOutboxBatch(OUTBOX_READ_LIMIT)
        if (cancelled) return
        const next = new Map<string, PendingTargetEdit>()
        for (const row of rows) {
          if (row.status === "failed" || row.event.projectId !== projectId) continue
          if (row.event.kind !== "target.cell.commit" && row.event.kind !== "target.cell.create") continue
          const fileId = row.event.fileId
          const cellId = row.event.cellId
          if (!fileId || !cellId || !fileIds.has(fileId)) continue
          const payload = row.event.payload as {
            value?: string
            valueHtml?: string
            targetLang?: string
            ai_suggestion?: true
          }
          if ((payload.targetLang ?? "") !== lane || typeof payload.value !== "string") continue
          next.set(overlayKey(fileId, cellId), {
            value: payload.value,
            valueHtml: payload.valueHtml,
            aiDrafted: payload.ai_suggestion === true,
          })
        }
        setPending(next)
      } catch {
        // IndexedDB can be unavailable in privacy modes. The authoritative
        // server snapshot remains usable; pending overlay is best-effort.
        if (!cancelled) setPending(new Map())
      }
    }

    const scheduleRefresh = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        void refreshPending()
      }, 50)
    }
    void refreshPending()
    const unsubscribe = subscribeToOutbox(scheduleRefresh)
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, [enabled, lane, projectId, requestedFiles])

  // Optimistic shadows win over the outbox overlay: they are the same edit,
  // stamped by the committer before the outbox row is readable, and they
  // outlive that row once the flusher accepts it.
  const overlay = useMemo(() => {
    if (optimistic.size === 0) return pending
    if (pending.size === 0) return optimistic
    return new Map([...pending, ...optimistic])
  }, [optimistic, pending])

  const files = useMemo(
    () => overlayPendingEdits(serverFiles, overlay),
    [overlay, serverFiles],
  )

  return { files, isLoading, isTruncated: false, error, revalidate, applyOptimisticTargetEdit }
}
