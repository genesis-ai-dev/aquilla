/**
 * Keep a BIA forecast client (Web Worker) fed with the project's target text.
 *
 * Why client-side: the model is a pure function of cells the SPA already
 * reads (AD-3 thin client), it needs no new server state, and per-keystroke
 * queries must not round-trip. The worker owns the index so neither building
 * it nor querying it blocks typing.
 *
 * Two feeds into one incremental index:
 *   1. The active file's cell summaries — the same debounced snapshot the
 *      glosser reads, which the store revalidates on every own commit and
 *      remote `event.applied`. Each change is diffed and only changed cells
 *      are re-sent, so an edit costs O(that cell).
 *   2. Every other file's rows (source and target), read once through `fetchAllFileCells`
 *      the first time the editor actually asks for a suggestion (so opening a
 *      project never pays for it), with bounded concurrency.
 * Validated cells weigh 1, other non-empty target cells FALLBACK_WEIGHT.
 *
 * Gap (documented): edits other people make in files you are NOT viewing
 * reach the index on the next workspace load, not live.
 */

import { useEffect, useRef, useState } from "react"
import type { CellSummary } from "@/hooks/useActiveCellStore"
import { createForecastClient, type ForecastClient } from "@/lib/forecast/forecast-client"
import type { ForecastCell } from "@/lib/forecast/bia-index"
import { fetchAllFileCells } from "@/lib/sync/cells-read"

const LOAD_CONCURRENCY = 2
/** Cell order = file position × this + cell index (thesaurus locality bound). */
const FILE_ORDER_STRIDE = 1_000_000

type ActiveCell = Pick<CellSummary, "id" | "fileId" | "index" | "translated" | "validated" | "status"> &
  Partial<Pick<CellSummary, "original">>

export interface UseForecastCorpusOpts {
  enabled: boolean
  projectId: string | null | undefined
  /** Project files in reading order. */
  files: ReadonlyArray<{ id: string }>
  activeFileId: string | null | undefined
  activeCells: readonly ActiveCell[]
  getToken: (fileId: string) => Promise<string | null>
  lane: string
}

interface Sent {
  signature: string
  fileId: string
}

const sentByClient = new WeakMap<ForecastClient, Map<string, Sent>>()

function isValidated(cell: ActiveCell): boolean {
  return cell.validated || cell.status === "validated"
}

export function useForecastCorpus({
  enabled,
  projectId,
  files,
  activeFileId,
  activeCells,
  getToken,
  lane,
}: UseForecastCorpusOpts): ForecastClient | null {
  const [client, setClient] = useState<ForecastClient | null>(null)
  const latest = useRef({ files, activeFileId, getToken })
  useEffect(() => {
    latest.current = { files, activeFileId, getToken }
  }, [files, activeFileId, getToken])

  // One client per project + lane. Created in an effect (not a memo) so
  // StrictMode's mount/unmount/mount cycle disposes and recreates cleanly.
  useEffect(() => {
    if (!enabled || !projectId) return
    const created = createForecastClient()
    let disposed = false
    created.onFirstUse = () => {
      void loadOtherFiles(created, projectId, lane, () => disposed, latest.current)
    }
    // The client owns a Worker; its lifetime is this effect's.
    setClient(created)
    return () => {
      disposed = true
      created.dispose()
      setClient(null)
    }
  }, [enabled, projectId, lane])

  // Incremental feed of the active file.
  useEffect(() => {
    if (!client || !activeFileId) return
    let sent = sentByClient.get(client)
    if (!sent) {
      sent = new Map()
      sentByClient.set(client, sent)
    }
    const fileOrder = Math.max(0, files.findIndex((f) => f.id === activeFileId))
    const upserts: ForecastCell[] = []
    const present = new Set<string>()
    for (const cell of activeCells) {
      if (cell.fileId !== activeFileId) continue
      present.add(cell.id)
      const text = cell.translated.trim()
      const source = cell.original?.trim() ?? ""
      const validated = isValidated(cell)
      const signature = `${validated ? 1 : 0}:${text}\u0000${source}`
      if (sent.get(cell.id)?.signature === signature) continue
      sent.set(cell.id, { signature, fileId: activeFileId })
      upserts.push({ id: cell.id, text, source, validated, order: fileOrder * FILE_ORDER_STRIDE + cell.index })
    }
    const removed: string[] = []
    for (const [id, entry] of sent) {
      if (entry.fileId === activeFileId && !present.has(id)) {
        removed.push(id)
        sent.delete(id)
      }
    }
    client.upsert(upserts)
    client.remove(removed)
  }, [client, activeFileId, activeCells, files])

  return client
}

async function loadOtherFiles(
  client: ForecastClient,
  projectId: string,
  lane: string,
  isDisposed: () => boolean,
  current: { files: ReadonlyArray<{ id: string }>; activeFileId: string | null | undefined; getToken: (fileId: string) => Promise<string | null> },
): Promise<void> {
  const queue = current.files
    .map((file, order) => ({ id: file.id, order }))
    .filter((file) => file.id !== current.activeFileId)
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      if (isDisposed()) return
      try {
        const token = await current.getToken(next.id)
        if (!token || isDisposed()) continue
        // Both sides: the source verse feeds the translation lexicon.
        const rows = await fetchAllFileCells(projectId, next.id, token, undefined, lane)
        if (isDisposed()) return
        const sent = sentByClient.get(client)
        const byCell = new Map<string, ForecastCell>()
        rows.forEach((row, i) => {
          // The active-file feed is fresher for any cell it already sent.
          if (sent?.has(row.cellId)) return
          const cell = byCell.get(row.cellId) ?? { id: row.cellId, text: "", validated: false, order: next.order * FILE_ORDER_STRIDE + i }
          if (row.side === "source") cell.source = row.value.trim()
          else if ((row.targetLang ?? "") === lane) {
            cell.text = row.value.trim()
            cell.validated = row.validated
          } else return
          byCell.set(row.cellId, cell)
        })
        client.upsert(Array.from(byCell.values()).filter((cell) => cell.text || cell.source))
      } catch {
        // Best effort: a file that fails to load just isn't in the corpus.
      }
    }
  }
  await Promise.all(Array.from({ length: LOAD_CONCURRENCY }, worker))
}
