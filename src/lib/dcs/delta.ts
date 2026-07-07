// DCS delta — the money logic (spec §6). Given a pinned cursor and a newer
// catalog entry, compute exactly which source cells to create / commit / delete
// so the adapter project's source lane advances to the new release with NO
// spurious writes (content-hash no-op suppression matches the server).
//
// Two levels:
//   1. compareRefs(old → new) → changed FILES (the Gitea per-commit union quirk
//      is handled in catalog.ts).
//   2. re-fetch + re-parse ONLY those files → content-hash each parsed cell and
//      diff against the adapter's CURRENT source cells:
//        - cellId not in currentCells               → create
//        - present, hash differs                    → commit (chained on head)
//        - present in a changed file, gone from parse → delete (tombstone)
//        - present, hash equal                      → nothing

import type { DcsCatalogEntry, DcsCell, DcsCursor } from "./types"
import type { DcsClient, RefKind } from "./catalog"
import { parseManifest } from "./manifest"
import { routeFor } from "./resource-map"
import { dcsEventId } from "./cell-id"

/** The adapter project's current view of one source cell (from the projection). */
export interface CurrentCell {
  /** Current chain-head event id — the parent for a commit. */
  eventId: string
  /** The djb2 content hash of the current source value. */
  contentHash: string
  /** Which file this cell belongs to — used to scope deletes to changed files. */
  fileId: string
}

export interface ComputeDeltaArgs {
  client: DcsClient
  /** The pinned cursor (owner/repo/ref of the LAST import). */
  cursor: DcsCursor
  /** The entry the cursor points at (old ref). Its refType picks the raw kind. */
  oldEntry: DcsCatalogEntry
  /** The newer catalog entry to advance to. */
  newEntry: DcsCatalogEntry
  /** The adapter project's current source cells, keyed by cellId. */
  currentCells: Map<string, CurrentCell>
  signal?: AbortSignal
}

export interface DeltaResult {
  creates: DcsCell[]
  commits: Array<{ cell: DcsCell; parentEventId: string }>
  deletes: string[]
}

const MANIFEST_PATH = "manifest.yaml"

/**
 * Compute the source-cell delta between the pinned cursor and a newer release.
 * Fetches nothing when compare reports no changed files.
 */
export async function computeDelta(args: ComputeDeltaArgs): Promise<DeltaResult> {
  const { client, oldEntry, newEntry, currentCells } = args
  const owner = newEntry.owner
  const repoName = newEntry.name
  const refKind: RefKind = newEntry.refType === "branch" ? "branch" : "tag"

  // 1. Which files changed between the two refs.
  const compare = await client.compareRefs(owner, repoName, oldEntry.ref, newEntry.ref)
  if (compare.changedFiles.length === 0) {
    return { creates: [], commits: [], deletes: [] }
  }

  // Route: fetch the manifest at the new ref so parsing uses the current shape.
  const manifestYaml = await client.fetchRaw(owner, repoName, newEntry.ref, MANIFEST_PATH, refKind)
  const manifest = parseManifest(manifestYaml)
  const route = routeFor(newEntry, manifest)
  if (!route) {
    throw new Error(
      `No import route for "${newEntry.subject}" (${newEntry.contentFormat}); cannot compute delta.`,
    )
  }

  // 2. Re-fetch + re-parse only the changed files the route can parse.
  const changed = compare.changedFiles.filter((p) => p !== MANIFEST_PATH)
  const fileTexts = new Map<string, string>()
  for (const path of changed) {
    if (args.signal?.aborted) throw new Error("Delta cancelled")
    fileTexts.set(path, await client.fetchRaw(owner, repoName, newEntry.ref, path, refKind))
  }
  const parsedFiles = route.parse({ entry: newEntry, manifest, files: fileTexts })

  // The set of files the parse (re)produced — deletes are scoped to these so a
  // cell that vanished from a re-parsed file is a real removal, not just an
  // untouched file elsewhere.
  const parsedFileIds = new Set(parsedFiles.map((f) => f.fileId))
  const parsedCellIds = new Set<string>()

  const creates: DcsCell[] = []
  const commits: Array<{ cell: DcsCell; parentEventId: string }> = []

  for (const file of parsedFiles) {
    for (const cell of file.cells) {
      parsedCellIds.add(cell.cellId)
      const current = currentCells.get(cell.cellId)
      if (!current) {
        creates.push(cell)
      } else if (current.contentHash !== cell.contentHash) {
        commits.push({ cell, parentEventId: current.eventId })
      }
      // hash-equal → nothing.
    }
  }

  // 3. Deletes: cells the adapter currently holds for a re-parsed file that the
  //    new parse no longer produced (tombstone). Scoped by fileId so untouched
  //    files' cells are never deleted.
  const deletes: string[] = []
  for (const [cellId, current] of currentCells) {
    if (parsedFileIds.has(current.fileId) && !parsedCellIds.has(cellId)) {
      deletes.push(cellId)
    }
  }

  return { creates, commits, deletes }
}

// ── applyDelta: route the classified delta to typed emitters ────────────────
//
// Slice A stays pure/testable: `applyDelta` takes an INJECTED emitters object
// rather than importing the outbox emitters directly. The Slice C wiring binds
// these to `source.cell.create` / `source.cell.commit` (chained on parentEventId)
// / `source.cell.delete` from src/lib/sync/events-emit.ts. All event ids are the
// deterministic `dcsEventId(repo|newSha|cellId)` so a re-run dedupes.

export interface CreateArg {
  cellId: string
  eventId: string
  cell: DcsCell
}
export interface CommitArg {
  cellId: string
  eventId: string
  parentEventId: string
  cell: DcsCell
}
export interface DeleteArg {
  cellId: string
}

export interface DeltaEmitters {
  create: (arg: CreateArg) => Promise<string>
  commit: (arg: CommitArg) => Promise<string>
  delete: (arg: DeleteArg) => Promise<string>
}

/** Apply a computed delta through the injected emitters. `repo`/`sha` derive the
 *  deterministic new-revision event ids for creates + commits. */
export async function applyDelta(
  delta: DeltaResult,
  emitters: DeltaEmitters,
  ctx: { repo: string; sha: string },
): Promise<void> {
  for (const cell of delta.creates) {
    await emitters.create({
      cellId: cell.cellId,
      eventId: dcsEventId(ctx.repo, ctx.sha, cell.cellId),
      cell,
    })
  }
  for (const { cell, parentEventId } of delta.commits) {
    await emitters.commit({
      cellId: cell.cellId,
      eventId: dcsEventId(ctx.repo, ctx.sha, cell.cellId),
      parentEventId,
      cell,
    })
  }
  for (const cellId of delta.deletes) {
    await emitters.delete({ cellId })
  }
}
