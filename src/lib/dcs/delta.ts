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

import type { DcsCatalogEntry, DcsCell, DcsCursor, DcsFile } from "./types"
import type { DcsClient, RefKind } from "./catalog"
import { parseManifest } from "./manifest"
import { routeFor } from "./resource-map"
import { dcsEventId, dcsFileId } from "./cell-id"
import { contentHash } from "./content-hash"

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
  /** Newly-added upstream cells. Each carries the parsed file's fileId so the
   *  create lands in the RIGHT file — a create is by definition absent from the
   *  adapter's existing cells, so its fileId can't be recovered from them. */
  creates: Array<{ cell: DcsCell; fileId: string }>
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

  // 1. Which files changed between the two refs. compareRefs now THROWS on a
  //    throttled/empty compare body (no numeric total_commits) — we let it
  //    propagate so the UI surfaces "try again" instead of silently importing
  //    nothing. An empty changedFiles here means a GENUINE no-change.
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

  return classifyAgainstCurrent(parsedFiles, currentCells)
}

/**
 * Shared classification (spec §6): diff a fresh parse against the adapter's
 * current source cells. Used by both computeDelta (upstream-changed files) and
 * computeRepairDelta (all held files at the pinned ref).
 *
 * Scopes the delta to files THIS adapter actually holds. A release changes many
 * files (a whole-repo release touches dozens of books); an adapter that only
 * imported a subset (e.g. one book) must ignore the rest — otherwise every cell
 * of every OTHER changed file is absent from currentCells and classifies as a
 * create (measured 83k+ creates for a one-book adapter → "Import changes" hangs).
 * A whole-repo adapter holds every file, so nothing is skipped for it.
 * (A brand-new upstream file is NOT auto-added here — that needs file.create
 * wiring; tracked as a follow-up.)
 */
function classifyAgainstCurrent(
  parsedFiles: DcsFile[],
  currentCells: Map<string, CurrentCell>,
): DeltaResult {
  const adapterFileIds = new Set<string>()
  for (const c of currentCells.values()) adapterFileIds.add(c.fileId)
  const relevantFiles = parsedFiles.filter((f) => adapterFileIds.has(f.fileId))

  // The set of (relevant) files the parse (re)produced — deletes are scoped to
  // these so a cell that vanished from a re-parsed file is a real removal, not
  // just an untouched file elsewhere.
  const parsedFileIds = new Set(relevantFiles.map((f) => f.fileId))
  const parsedCellIds = new Set<string>()

  const creates: Array<{ cell: DcsCell; fileId: string }> = []
  const commits: Array<{ cell: DcsCell; parentEventId: string }> = []

  for (const file of relevantFiles) {
    for (const cell of file.cells) {
      parsedCellIds.add(cell.cellId)
      const current = currentCells.get(cell.cellId)
      if (!current) {
        creates.push({ cell, fileId: file.fileId })
      } else if (current.contentHash !== cell.contentHash) {
        commits.push({ cell, parentEventId: current.eventId })
      }
      // hash-equal → nothing.
    }
  }

  // Deletes: cells the adapter currently holds for a re-parsed file that the
  // new parse no longer produced (tombstone). Scoped by fileId so untouched
  // files' cells are never deleted.
  const deletes: string[] = []
  for (const [cellId, current] of currentCells) {
    if (parsedFileIds.has(current.fileId) && !parsedCellIds.has(cellId)) {
      deletes.push(cellId)
    }
  }

  return { creates, commits, deletes }
}

// ── Repair: re-parse the PINNED ref against the adapter's current cells ─────
//
// When OUR parser improves (e.g. the aligned-USFM one-word-per-verse bug), an
// already-imported adapter stays broken forever: upstream didn't change, so
// computeDelta's compareRefs reports nothing to do. computeRepairDelta skips the
// compare entirely — it re-fetches every file the adapter currently holds at the
// SAME pinned ref, re-parses with today's parser, and classifies against the
// projection with the identical create/commit/delete logic. Correctly-imported
// cells hash-match and produce no ops.

export interface ComputeRepairDeltaArgs {
  client: DcsClient
  /** The catalog entry the cursor is PINNED at — repair re-reads this exact ref. */
  entry: DcsCatalogEntry
  /** The adapter project's current source cells, keyed by cellId. */
  currentCells: Map<string, CurrentCell>
  signal?: AbortSignal
}

/**
 * Re-parse ALL adapter-held files at the pinned ref and diff against the
 * projection. Fetches only files the adapter holds: every route derives its
 * fileId as `dcsFileId(repo, path)`, so tree paths are pre-filtered against the
 * adapter's fileIds BEFORE any raw fetch (a one-book adapter of a 66-book repo
 * fetches exactly one book).
 */
export async function computeRepairDelta(args: ComputeRepairDeltaArgs): Promise<DeltaResult> {
  const { client, entry, currentCells } = args
  if (currentCells.size === 0) return { creates: [], commits: [], deletes: [] }

  const owner = entry.owner
  const repoName = entry.name
  const repo = entry.fullName
  const refKind: RefKind = entry.refType === "branch" ? "branch" : "tag"

  const manifestYaml = await client.fetchRaw(owner, repoName, entry.ref, MANIFEST_PATH, refKind)
  const manifest = parseManifest(manifestYaml)
  const route = routeFor(entry, manifest)
  if (!route) {
    throw new Error(
      `No import route for "${entry.subject}" (${entry.contentFormat}); cannot compute repair delta.`,
    )
  }

  const adapterFileIds = new Set<string>()
  for (const c of currentCells.values()) adapterFileIds.add(c.fileId)

  const tree = await client.getTree(owner, repoName, entry.ref)
  const fileTexts = new Map<string, string>()
  for (const path of tree) {
    if (path === MANIFEST_PATH) continue
    if (!adapterFileIds.has(dcsFileId(repo, path))) continue
    if (args.signal?.aborted) throw new Error("Repair cancelled")
    fileTexts.set(path, await client.fetchRaw(owner, repoName, entry.ref, path, refKind))
  }

  const parsedFiles = route.parse({ entry, manifest, files: fileTexts })
  return classifyAgainstCurrent(parsedFiles, currentCells)
}

/**
 * Revision token for applyDelta's event-id derivation when applying a REPAIR.
 * The original import already minted `dcsEventId(project, repo, entry.commitSha,
 * cellId)`; a repair at the bare pinned sha would mint the SAME ids and the
 * server's `INSERT OR IGNORE` would silently drop every repair commit. Folding a
 * hash of the repaired content in keeps ids deterministic (re-running the same
 * repair dedupes) while successive parser fixes — different parsed content —
 * mint fresh ids instead of colliding with an earlier repair's.
 */
export function repairRevisionToken(sha: string, delta: DeltaResult): string {
  const parts: string[] = []
  for (const { cell } of delta.creates) parts.push(`${cell.cellId}:${cell.contentHash}`)
  for (const { cell } of delta.commits) parts.push(`${cell.cellId}:${cell.contentHash}`)
  for (const cellId of delta.deletes) parts.push(cellId)
  return `${sha}#repair-${contentHash(parts.join("|"))}`
}

// ── applyDelta: route the classified delta to typed emitters ────────────────
//
// Slice A stays pure/testable: `applyDelta` takes an INJECTED emitters object
// rather than importing the outbox emitters directly. The Slice C wiring binds
// these to `source.cell.create` / `source.cell.commit` (chained on parentEventId)
// / `source.cell.delete` from src/lib/sync/events-emit.ts. All event ids are the
// deterministic `dcsEventId(projectId|repo|newSha|cellId)` — scoped to the
// destination project so the same resource delta'd into two projects never
// collides on the events-table PK — so a re-run in the SAME project dedupes.

export interface CreateArg {
  cellId: string
  eventId: string
  cell: DcsCell
  /** The parsed file the new cell belongs to — the create must project into
   *  this file, not a fallback derived from the cell id. */
  fileId: string
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

/** Apply a computed delta through the injected emitters. `projectId`/`repo`/`sha`
 *  derive the deterministic, project-scoped new-revision event ids for creates +
 *  commits (project scope prevents the events-table PK from colliding when the
 *  same resource is delta'd into more than one project). */
export async function applyDelta(
  delta: DeltaResult,
  emitters: DeltaEmitters,
  ctx: { projectId: string; repo: string; sha: string },
): Promise<void> {
  for (const { cell, fileId } of delta.creates) {
    await emitters.create({
      cellId: cell.cellId,
      eventId: dcsEventId(ctx.projectId, ctx.repo, ctx.sha, cell.cellId),
      cell,
      fileId,
    })
  }
  for (const { cell, parentEventId } of delta.commits) {
    await emitters.commit({
      cellId: cell.cellId,
      eventId: dcsEventId(ctx.projectId, ctx.repo, ctx.sha, cell.cellId),
      parentEventId,
      cell,
    })
  }
  for (const cellId of delta.deletes) {
    await emitters.delete({ cellId })
  }
}
