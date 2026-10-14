// Who's Who, Bridge 1 state per file (AQU-1694).
//
// The editor reads a file's stored links to tint a gateway-language source;
// the Who's Who panel shows how much of the book is aligned and lets a
// maintainer (re)run the alignment. Both read this one module-level store,
// keyed by project and file, so a run started in the panel lights the editor
// the moment it is saved. A run:
//   1. reads the file's source cells from the server (the text the server
//      hashes, not the editor's possibly unsaved draft);
//   2. aligns them to the pack in a Web Worker (progress, cancellable);
//   3. uploads the links in chunks, then reloads them.
// Nothing here throws into React: failures become a typed reason.

import { useCallback, useSyncExternalStore } from "react"
import type { BkpTextLayer } from "@/lib/bible-data/pack-types"
import { alignSourceOffMainThread, AlignmentCancelledError } from "@/lib/bible-data/bridge-align-client"
import { SOURCE_ALIGNMENT_METHOD, type SourceCellInput, type SourceWordLink } from "@/lib/bible-data/source-alignment"
import { cellVerses } from "@/lib/bible-data/voice-index"
import { fetchAllFileCells } from "@/lib/sync/cells-read"
import {
  fetchSourceWordAlignment,
  SourceAlignmentRequestError,
  uploadSourceWordAlignment,
  type StoredAlignmentCell,
} from "@/lib/sync/source-word-alignment"

/** One source cell's links, as the editor needs them. */
export interface CellSourceLinks {
  sourceHash: string
  trainedPairs: number
  links: readonly SourceWordLink[]
}

export type SourceAlignmentStatus =
  | { kind: "idle" }
  | { kind: "loading" }
  | {
      kind: "ready"
      /** Aligned cells whose text has not changed since. */
      cells: ReadonlyMap<string, CellSourceLinks>
      /** Aligned cells whose source text changed since: no tints until the next run. */
      staleCells: number
      /** The verse cells the last run trained on, or null with nothing aligned. */
      trainedPairs: number | null
    }
  | { kind: "error"; reason: AlignmentFailure }

export type AlignmentFailure = "offline" | "forbidden" | "failed"

export type AlignmentRun =
  | { phase: "reading" }
  | { phase: "aligning"; done: number; total: number }
  | { phase: "saving"; done: number; total: number }
  | { phase: "failed"; reason: AlignmentFailure }

export interface SourceAlignmentSnapshot {
  status: SourceAlignmentStatus
  /** The run in progress, or the last one when it failed; null otherwise. */
  run: AlignmentRun | null
}

type TokenFor = (fileId: string) => Promise<string | null>

interface Entry {
  snapshot: SourceAlignmentSnapshot
  controller: AbortController | null
  loading: Promise<void> | null
}

const IDLE: SourceAlignmentSnapshot = { status: { kind: "idle" }, run: null }
const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

const keyOf = (projectId: string, fileId: string) => `${projectId}\u0000${fileId}`

function entry(key: string): Entry {
  let found = entries.get(key)
  if (!found) entries.set(key, (found = { snapshot: IDLE, controller: null, loading: null }))
  return found
}

function update(key: string, change: Partial<SourceAlignmentSnapshot>): void {
  const target = entry(key)
  target.snapshot = { ...target.snapshot, ...change }
  for (const listener of listeners) listener()
}

function failureOf(err: unknown): AlignmentFailure {
  if (err instanceof SourceAlignmentRequestError) return err.status === 403 || err.status === 401 ? "forbidden" : "failed"
  if (err instanceof TypeError) return "offline"
  return "failed"
}

/** The stored rows as the editor reads them. */
export function readyStatus(stored: readonly StoredAlignmentCell[]): SourceAlignmentStatus {
  const cells = new Map<string, CellSourceLinks>()
  let staleCells = 0
  let trainedPairs: number | null = null
  for (const cell of stored) {
    trainedPairs = cell.trainedPairs
    if (cell.stale) {
      staleCells++
      continue
    }
    cells.set(cell.cellId, {
      sourceHash: cell.sourceHash,
      trainedPairs: cell.trainedPairs,
      links: cell.links.map(([wordId, token, conf]) => ({ wordId, token, conf })),
    })
  }
  return { kind: "ready", cells, staleCells, trainedPairs }
}

async function load(projectId: string, fileId: string, tokenFor: TokenFor): Promise<void> {
  const key = keyOf(projectId, fileId)
  try {
    const jwt = await tokenFor(fileId)
    if (!jwt) {
      update(key, { status: { kind: "error", reason: "offline" } })
      return
    }
    update(key, { status: readyStatus(await fetchSourceWordAlignment({ projectId, fileId, jwt })) })
  } catch (err) {
    update(key, { status: { kind: "error", reason: failureOf(err) } })
  }
}

/** Load a file's stored links once (again after a failure). Safe to call on every render. */
export function ensureSourceAlignment(projectId: string, fileId: string, tokenFor: TokenFor): void {
  const key = keyOf(projectId, fileId)
  const target = entry(key)
  if (target.loading || target.snapshot.status.kind === "ready") return
  update(key, { status: { kind: "loading" } })
  target.loading = load(projectId, fileId, tokenFor).finally(() => {
    target.loading = null
  })
}

/** The source cells a run aligns: whole verses of this book that no other cell shares. */
export function alignableCells(
  rows: readonly { cellId: string; value: string; canonicalRef: string | null; type: string | null }[],
  book: string,
): SourceCellInput[] {
  const candidates = rows.flatMap((row) => {
    const verses = cellVerses({ ref: row.canonicalRef, type: row.type })
    if (!verses || verses.partial || verses.book !== book || row.value.trim() === "") return []
    return [{ cellId: row.cellId, refs: verses.refs, text: row.value }]
  })
  const owners = new Map<string, number>()
  for (const cell of candidates) for (const ref of cell.refs) owners.set(ref, (owners.get(ref) ?? 0) + 1)
  return candidates.filter((cell) => cell.refs.every((ref) => owners.get(ref) === 1))
}

export interface StartAlignmentOptions {
  projectId: string
  fileId: string
  /** The pack's text layer for the file's book. */
  text: BkpTextLayer
  tokenFor: TokenFor
}

/** Run Bridge 1 for a file (a maintainer's action). A run already going for the file is left alone. */
export function startSourceAlignment({ projectId, fileId, text, tokenFor }: StartAlignmentOptions): void {
  const key = keyOf(projectId, fileId)
  const target = entry(key)
  if (target.controller) return
  const controller = new AbortController()
  target.controller = controller
  update(key, { run: { phase: "reading" } })
  void (async () => {
    try {
      const jwt = await tokenFor(fileId)
      if (!jwt) throw new TypeError("no token")
      const rows = await fetchAllFileCells(projectId, fileId, jwt, "source")
      const cells = alignableCells(rows, text.book)
      update(key, { run: { phase: "aligning", done: 0, total: 1 } })
      const alignment = await alignSourceOffMainThread(text, cells, {
        signal: controller.signal,
        onProgress: (done, total) => update(key, { run: { phase: "aligning", done, total } }),
      })
      update(key, { run: { phase: "saving", done: 0, total: 1 } })
      const saveJwt = (await tokenFor(fileId)) ?? jwt
      await uploadSourceWordAlignment({
        projectId,
        fileId,
        jwt: saveJwt,
        method: SOURCE_ALIGNMENT_METHOD,
        alignment,
        signal: controller.signal,
        onProgress: (done, total) => update(key, { run: { phase: "saving", done, total } }),
      })
      update(key, { status: readyStatus(await fetchSourceWordAlignment({ projectId, fileId, jwt: saveJwt })), run: null })
    } catch (err) {
      const cancelled = err instanceof AlignmentCancelledError || (err instanceof DOMException && err.name === "AbortError")
      update(key, { run: cancelled ? null : { phase: "failed", reason: failureOf(err) } })
      // Whatever a cancelled or failed run saved is real: show it.
      if (cancelled) void load(projectId, fileId, tokenFor)
    } finally {
      target.controller = null
    }
  })()
}

/** Stop a file's run. Chunks already saved stay saved (each one is whole). */
export function cancelSourceAlignment(projectId: string, fileId: string): void {
  entries.get(keyOf(projectId, fileId))?.controller?.abort()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A file's Bridge 1 state; re-renders the caller when it changes. */
export function useSourceAlignment(projectId: string | null, fileId: string | null): SourceAlignmentSnapshot {
  const snapshot = useCallback(
    () => (projectId && fileId ? (entries.get(keyOf(projectId, fileId))?.snapshot ?? IDLE) : IDLE),
    [projectId, fileId],
  )
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

/** Forget every file (tests). */
export function __resetSourceAlignmentStore(): void {
  for (const target of entries.values()) target.controller?.abort()
  entries.clear()
  for (const listener of listeners) listener()
}
