// Source-project linking helpers (Aquilla AD-9 / 03-data-model.md
// §"Source-project linking").
//
// A project may declare an upstream `source_project_id` via a nullable
// self-FK. Linking, detaching, and creating source-only projects requires
// `project_lead` (500)+ per AD-9.
//
// Cycle prevention: a project A cannot point its `source_project_id` at
// another project B that is — directly or transitively — already a
// downstream of A. We walk the source chain upstream from the proposed
// target and reject if we encounter the linker.
//
// The `source_project_id` column lives on `projects` and is added by Phase
// 1A's `0004_projects_source_link.sql`. This module references it via
// SELECT/UPDATE; if the column isn't present yet (older DB), the query
// fails loudly — by design. The PR description records this ordering.
//
// Event emission: link / detach / source-snapshot writes a row directly
// into the `events` table created by Phase 1A's `0002_events.sql`. The sync
// worker consumes `project.link-source`, `source.cell.create`, and
// `source.cell.commit` events to keep projections aligned.

import { sign } from "hono/jwt"
import { ensureProjectLanes } from "../../../db/shared/lanes"
import { visibleTagsForMember } from "../../../db/shared/lane-visibility"
import type { Env } from "../types"
import {
  loadFileSourceLines,
  matchLinkedFileLines,
  summarizeLinkFileMatch,
  type LinkFileMatchSummary,
} from "../../../db/shared/link-file-match"
import {
  parseSourceLinkAdoption,
  type SourceLinkAdoption,
} from "../../../db/shared/source-link-adopt"

/** Server-generated event id for identity-side maintenance events. */
export function makeEventId(): string {
  return crypto.randomUUID()
}

/**
 * AQU-476: mint a short-lived service sync-token and POST
 * /api/v1/projects/:projectId/link/sync on the downstream project — this
 * is "seeding is the first mirror sync" (design spec §5): linking a project
 * with mode='live' runs the same engine a lazy file-open would, so files +
 * cells arrive as `file.mirror`/`source.cell.mirror` events with provenance
 * set from birth (never a direct `snapshotSourceCells`-style projection
 * write, which would leave `upstream_event_id` NULL).
 *
 * Best-effort but now AWAITED by the caller (QA-BUG-1: a fire-and-forget
 * trigger left freshly created live links with 0 files/cells and no client
 * signal that seeding hadn't happened). Returns true iff the sync-worker
 * responded 2xx with `ranSync: true` or a mirrored count — false on any
 * config/network/non-2xx failure, so the route can surface `seeded: false`
 * and the client can fall back to its own self-heal trigger.
 */
export async function triggerLinkSeedSync(
  env: Env,
  downstreamProjectId: string,
): Promise<boolean> {
  if (!env.SYNC_WORKER_URL || !env.SYNC_SECRET_KEY) return false
  try {
    const now = Math.floor(Date.now() / 1000)
    const token = await sign(
      {
        userId: 0,
        username: "link-sync-seed",
        projectId: downstreamProjectId,
        // Not checked by verifyTokenForProject (project-scoped, not
        // file-scoped) — placeholder to satisfy the SyncTokenClaims shape.
        fileId: "__link_seed__",
        role: 500,
        aud: "sync",
        iat: now,
        exp: now + 300,
      },
      env.SYNC_SECRET_KEY,
      "HS256",
    )
    const res = await fetch(
      `${env.SYNC_WORKER_URL.replace(/\/$/, "")}/api/v1/projects/${encodeURIComponent(downstreamProjectId)}/link/sync`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    )
    return res.ok
  } catch (err) {
    console.warn(`triggerLinkSeedSync failed for ${downstreamProjectId}:`, err)
    return false
  }
}

async function nextServerSeq(env: Env, projectId: string): Promise<number> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT COALESCE(MAX(server_seq), 0) + 1 AS next_seq FROM events WHERE project_id = ?",
  )
    .bind(projectId)
    .first<{ next_seq: number }>()
  return row?.next_seq ?? 1
}

function contentHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/**
 * AQU-1520: a source cell's `metadata` bucket, normalized to a plain object or
 * `null`.
 *
 * `cells.metadata` is JSONB and reaches us as a parsed object through the
 * shim, but a value that predates the column's current use — or a row written
 * by an older path — can be a JSON string, an array, or a scalar. Only a plain
 * object is a usable envelope (`readImportMilestone()` in
 * `src/lib/milestone-navigation.ts` rejects anything else), so anything else
 * becomes `null` and the snapshot copies no metadata for that cell rather than
 * writing a shape the navigator cannot read.
 */
function cellMetadata(
  value: unknown,
): Record<string, unknown> | null {
  const decoded = typeof value === "string"
    ? (() => {
        try {
          return JSON.parse(value) as unknown
        } catch {
          return null
        }
      })()
    : value
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return null
  return decoded as Record<string, unknown>
}

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

/**
 * AQU-1358: read the upstream file a target copy was mirrored from, as
 * recorded by `withUpstreamFileId`. Returns null for legacy rows written
 * before the marker existed, and for meta that is absent, malformed, or holds
 * a non-string/empty value — callers then fall back to the deterministic
 * live-mirror id (`deterministicDownstreamFileId`), never to the display name
 * (AQU-1547).
 */
export function readUpstreamFileId(meta: string | null): string | null {
  if (!meta) return null
  try {
    const parsed = JSON.parse(meta) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const value = (parsed as Record<string, unknown>).upstreamFileId
    return typeof value === "string" && value ? value : null
  } catch {
    return null
  }
}

/**
 * AQU-1358: stamp `upstreamFileId` into a mirrored file's `meta` JSON so a
 * later snapshot finds its own previous copy by upstream identity rather than
 * by display name — which changes when the upstream file is renamed, making
 * the name lookup miss and mint a duplicate.
 *
 * Absent or unparseable legacy meta degrades to a fresh object rather than
 * throwing: this runs inside the best-effort snapshot loop, and losing a
 * malformed meta blob is strictly better than losing the file row.
 */
export function withUpstreamFileId(meta: string | null, upstreamFileId: string): string {
  let parsed: Record<string, unknown> = {}
  if (meta) {
    try {
      const candidate = JSON.parse(meta) as unknown
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      // fall through to {}
    }
  }
  return JSON.stringify({ ...parsed, upstreamFileId })
}

/**
 * MIRROR of sync-worker/src/events/link-sync.ts's `deterministicUuid`. Built
 * on this module's existing `contentHash`, which is already the same djb2
 * primitive sync-worker hashes with (event-projection.ts) — the parity test
 * below is what holds all of it together.
 */
function deterministicUuid(key: string): string {
  const h1 = contentHash(key)
  const h2 = contentHash(`${key}\0salt2`)
  const h3 = contentHash(`${h1}${h2}`)
  const h4 = contentHash(`${h2}${h1}`)
  const hex = (h1 + h2 + h3 + h4).slice(0, 32).padEnd(32, "0")
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${"89ab"[parseInt(hex[16] ?? "0", 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  )
}

/**
 * AQU-1547: the downstream `files.id` a LIVE link's mirror gives an upstream
 * file — a MIRROR of sync-worker/src/events/link-sync.ts's
 * `deterministicDownstreamFileId`.
 *
 * Duplicated rather than imported because the two workers are separate
 * packages with their own lockfiles (the repo's established idiom for a
 * cross-worker contract — cf. the role-policy mirror). The parity test
 * imports BOTH and asserts they agree, so drift fails CI rather than silently
 * un-matching every mirrored file.
 *
 * Why the snapshot needs it: mirrored rows carry no `meta.upstreamFileId`
 * marker (the mirror passes the UPSTREAM's meta through verbatim), so before
 * this they were only findable by display name — and a name lookup cannot
 * tell a mirrored copy from a file the project imported itself. Their id, by
 * contrast, is a pure function of (downstream project, upstream file), which
 * a locally imported file's random UUID can never collide with.
 */
export function deterministicDownstreamFileId(
  downstreamProjectId: string,
  upstreamFileId: string,
): string {
  return deterministicUuid(`file\0${downstreamProjectId}\0${upstreamFileId}`)
}

export interface SourceLinkProject {
  id: string
  name: string
  source_project_id: string | null
  /** AQU-1560: 'live' | 'clone', or null for a legacy link (see SourceLinkMode). */
  source_link_mode: string | null
  /** AQU-1679: 'source' | 'target', or null (= source, the server's default). */
  source_link_consumes: string | null
  archived_at: string | null
}

/**
 * AQU-1559: a link's followed-file selection, parsed from
 * `projects.source_link_file_ids`.
 *
 * `null` means "this link follows the whole upstream project" — the default and,
 * for every link made before this slice, the only answer. A non-empty array of
 * upstream file ids means the link follows a fixed list: nothing outside it
 * mirrors in, and files the upstream gains later are not in it, so they never
 * arrive on their own.
 *
 * Anything that is not a non-empty array of non-empty strings degrades to
 * `null`, i.e. to the whole project. The column is TEXT (see migration 0127), so
 * a malformed blob is possible, and the two ways to be wrong are not equal:
 * reading it as "follow everything" brings in files the lead did not pick (which
 * they can delete), while reading it as "follow nothing" would silently stop a
 * working link from syncing — including the detach snapshot, which would then
 * copy nothing and strand the project with no source at all.
 */
/**
 * AQU-1559: this link's followed-file selection, read in a statement of its own.
 *
 * Isolated deliberately — `projects.source_link_file_ids` arrives with migration
 * 0127, and this worker is deployed independently of the migration being applied
 * (a per-PR preview runs new code against the shared development database, which
 * has not had it applied at all). Selecting the column alongside anything else
 * would make a database that predates it fail the whole statement: the project
 * read behind every project open, or the detach that makes a project
 * self-contained. Both worked before this slice and must keep working.
 *
 * `null` on a missing column is the same answer as a NULL value — this link
 * follows the whole upstream project — so an un-migrated deployment simply does
 * not offer the new capability, rather than breaking the old one. Same posture as
 * `hiddenSourceCellKeys` for `cells.hidden_at` (AQU-1453).
 */
export async function loadLinkFileIds(
  env: Env,
  projectId: string,
): Promise<string[] | null> {
  if (!env.AQUILLA_PG) return null
  try {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_link_file_ids FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ source_link_file_ids: string | null }>()
    return parseLinkFileIds(row?.source_link_file_ids ?? null)
  } catch {
    return null
  }
}

export function parseLinkFileIds(raw: string | null | undefined): string[] | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const ids = parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
  return ids.length > 0 ? ids : null
}

/**
 * AQU-1560: the link's pending addition (`projects.source_link_backfill`,
 * migration 0128), read in a statement of its own for the same reason as
 * `loadLinkFileIds`.
 *
 * Unlike the selection, "the column is missing" is NOT folded into "nothing
 * pending": the add route has to tell the two apart, because it cannot record
 * an addition on a database that predates the column. `{ ok: false }` is that
 * case; `raw` is the column exactly as stored, for the compare-and-set write.
 */
export async function loadLinkBackfillRaw(
  env: Env,
  projectId: string,
): Promise<{ ok: true; raw: string | null } | { ok: false }> {
  if (!env.AQUILLA_PG) return { ok: false }
  try {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_link_backfill FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ source_link_backfill: string | null }>()
    return { ok: true, raw: row?.source_link_backfill ?? null }
  } catch {
    return { ok: false }
  }
}

/**
 * AQU-1560: clear any pending addition. A re-link (to any upstream) and a
 * detach both end the link the addition was for. Best-effort and on its own:
 * a database that predates migration 0128 has nothing to clear, and neither
 * operation should fail over it.
 */
export async function clearLinkBackfill(env: Env, projectId: string): Promise<void> {
  try {
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET source_link_backfill = NULL WHERE id = ? AND source_link_backfill IS NOT NULL",
    )
      .bind(projectId)
      .run()
  } catch {
    // Column absent: nothing pending.
  }
}

/**
 * AQU-1562: the followed-file selection as the column HOLDS it, for a
 * compare-and-set write — the same shape and the same reason as
 * `loadLinkBackfillRaw`.
 *
 * Stopping a file rewrites the selection, and the mirror sync writes it too
 * (a finished backfill moves its files in), so the write has to compare
 * against the value it decided from. And "the column is missing" cannot be
 * folded into "follows the whole project" here, the way `loadLinkFileIds` does
 * it: on a database that predates migration 0127 there is nowhere to record a
 * stopped file, so the route has to refuse rather than write a selection into
 * a column that is not there.
 */
export async function loadLinkFileIdsRaw(
  env: Env,
  projectId: string,
): Promise<{ ok: true; raw: string | null } | { ok: false }> {
  if (!env.AQUILLA_PG) return { ok: false }
  try {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_link_file_ids FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ source_link_file_ids: string | null }>()
    return { ok: true, raw: row?.source_link_file_ids ?? null }
  } catch {
    return { ok: false }
  }
}

/**
 * AQU-1562: which of the upstream's files this project holds as a STOPPED copy
 * — a file the link once followed and no longer does, still here with the
 * source text it had when it was stopped and every translation on it.
 *
 * The caller needs this to say the right thing before it acts: following a
 * stopped file again REPLACES its source text with the upstream's current text,
 * while checking a file this project never had only adds one. Both read as an
 * unchecked row, so the two cannot be told apart from the selection alone.
 *
 * Found by `deterministicDownstreamFileId`, not by name: a stopped file can be
 * renamed on either side, and a name cannot tell a mirrored copy from a file
 * the project imported itself (the same reasoning as the detach snapshot's).
 * A whole-project link has stopped nothing by definition, so it answers empty
 * without a query.
 */
export async function loadStoppedUpstreamFileIds(
  env: Env,
  projectId: string,
  upstreamFileIds: readonly string[],
  followed: readonly string[] | null,
  /** AQU-1679: upstream file id → the project's own file that stands in for it. */
  adoptedFileIdOf: Readonly<Record<string, string>> | null = null,
): Promise<string[]> {
  if (!followed) return []
  const followedSet = new Set(followed)
  const candidates = upstreamFileIds.filter((id) => !followedSet.has(id))
  if (candidates.length === 0) return []

  const downstreamIdOf = new Map<string, string>() // downstream file id -> upstream file id
  for (const upstreamFileId of candidates) {
    // AQU-1679: a file the link followed INTO one of the project's own is that
    // file, not a mirrored copy under the derived id.
    downstreamIdOf.set(
      adoptedFileIdOf?.[upstreamFileId] ?? deterministicDownstreamFileId(projectId, upstreamFileId),
      upstreamFileId,
    )
  }
  const downstreamIds = [...downstreamIdOf.keys()]

  // Chunked: an upstream can hold a whole Bible and then some, and the
  // selection cap is 5000 — more placeholders than one statement should carry.
  const stopped: string[] = []
  const CHUNK = 200
  for (let i = 0; i < downstreamIds.length; i += CHUNK) {
    const chunk = downstreamIds.slice(i, i + CHUNK)
    const placeholders = chunk.map(() => "?").join(", ")
    try {
      const { results } = await env.AQUILLA_PG.prepare(
        `SELECT id FROM files
           WHERE project_id = ? AND deleted_at IS NULL AND id IN (${placeholders})`,
      )
        .bind(projectId, ...chunk)
        .all<{ id: string }>()
      for (const row of results ?? []) {
        const upstreamFileId = downstreamIdOf.get(row.id)
        if (upstreamFileId) stopped.push(upstreamFileId)
      }
    } catch {
      // A read that fails answers "none stopped": the caller then describes a
      // check as a plain add, which understates what it does rather than
      // promising something that will not happen.
      return []
    }
  }
  // The upstream's own order, as every other file list here is.
  const stoppedSet = new Set(stopped)
  return upstreamFileIds.filter((id) => stoppedSet.has(id))
}

/**
 * AQU-1679: the project's own files that stand in for upstream files, from
 * `projects.source_link_adopt` (migration 0140).
 *
 * Read in a statement of its own, like the selection and the pending addition
 * above: on a database that predates the column the answer is `null`, "none" —
 * which is what every link there means — rather than a failed read of
 * something that worked before this slice.
 */
export async function loadLinkAdoption(
  env: Env,
  projectId: string,
): Promise<SourceLinkAdoption | null> {
  if (!env.AQUILLA_PG) return null
  try {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_link_adopt FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ source_link_adopt: string | null }>()
    return parseSourceLinkAdoption(row?.source_link_adopt ?? null)
  } catch {
    return null
  }
}

/**
 * AQU-1679: the adopted-files column exactly as stored, for a compare-and-set
 * write — the mirror sync writes it too (a joined file leaves `pending`) and may
 * be running right now. `{ ok: false }` is a database that predates migration
 * 0140, where a replace cannot be recorded; the add route has to refuse rather
 * than add the file as a copy the lead did not ask for.
 */
export async function loadLinkAdoptionRaw(
  env: Env,
  projectId: string,
): Promise<{ ok: true; raw: string | null } | { ok: false }> {
  if (!env.AQUILLA_PG) return { ok: false }
  try {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT source_link_adopt FROM projects WHERE id = ?",
    )
      .bind(projectId)
      .first<{ source_link_adopt: string | null }>()
    return { ok: true, raw: row?.source_link_adopt ?? null }
  } catch {
    return { ok: false }
  }
}

/** AQU-1679: forget the adopted files — the link they belonged to has ended or
 *  been replaced. Best-effort for the same reason as `clearLinkBackfill`. */
export async function clearLinkAdoption(env: Env, projectId: string): Promise<void> {
  if (!env.AQUILLA_PG) return
  try {
    await env.AQUILLA_PG.prepare("UPDATE projects SET source_link_adopt = NULL WHERE id = ?")
      .bind(projectId)
      .run()
  } catch {
    // Pre-0140 database: there is no column, so there is nothing to clear.
  }
}

/** One "replace the source in my existing file" pair, as the link flow sends it. */
export interface ReplaceFilePair {
  /** The upstream file to follow. */
  upstreamFileId: string
  /** The project's own file whose source it replaces. */
  fileId: string
}

export interface ReplaceFileMatch extends ReplaceFilePair, LinkFileMatchSummary {
  /** One of the two files does not exist (or is in Recently deleted). */
  missing: boolean
}

/**
 * AQU-1679: how each of the project's files compares with the upstream file it
 * would follow — the numbers the confirm step shows before a replace, and the
 * check the link request repeats before it records one.
 *
 * Answered by the server because the pairing reads both projects' source rows,
 * and because it is the same pairing the mirror then performs
 * (db/shared/link-file-match.ts) — a client-side estimate could promise a
 * match the sync does not make.
 */
export async function matchFilesForReplace(
  env: Env,
  args: { projectId: string; sourceProjectId: string; pairs: readonly ReplaceFilePair[] },
): Promise<ReplaceFileMatch[]> {
  const live = async (projectId: string, ids: readonly string[]): Promise<Set<string>> => {
    const found = new Set<string>()
    const CHUNK = 200
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const { results } = await env.AQUILLA_PG.prepare(
        `SELECT id FROM files
          WHERE project_id = ? AND deleted_at IS NULL AND id IN (${chunk.map(() => "?").join(", ")})`,
      )
        .bind(projectId, ...chunk)
        .all<{ id: string }>()
      for (const row of results ?? []) found.add(row.id)
    }
    return found
  }
  const liveUpstream = await live(args.sourceProjectId, args.pairs.map((p) => p.upstreamFileId))
  const liveOwn = await live(args.projectId, args.pairs.map((p) => p.fileId))

  const matches: ReplaceFileMatch[] = []
  for (const pair of args.pairs) {
    if (!liveUpstream.has(pair.upstreamFileId) || !liveOwn.has(pair.fileId)) {
      matches.push({
        ...pair,
        missing: true,
        upstreamLines: 0,
        localLines: 0,
        same: 0,
        changed: 0,
        added: 0,
        kept: 0,
        canReplace: false,
      })
      continue
    }
    const upstreamLines = await loadFileSourceLines(env.AQUILLA_PG, args.sourceProjectId, pair.upstreamFileId)
    const ownLines = await loadFileSourceLines(env.AQUILLA_PG, args.projectId, pair.fileId)
    matches.push({
      ...pair,
      missing: false,
      ...summarizeLinkFileMatch(matchLinkedFileLines(upstreamLines, ownLines)),
    })
  }
  return matches
}

/** AQU-1560: the upstream's current (non-deleted) file ids. */
export async function loadUpstreamFileIds(env: Env, upstreamProjectId: string): Promise<string[]> {
  const { results } = await env.AQUILLA_PG.prepare(
    "SELECT id FROM files WHERE project_id = ? AND deleted_at IS NULL",
  )
    .bind(upstreamProjectId)
    .all<{ id: string }>()
  return (results ?? []).map((r) => r.id)
}

/** AQU-476: link mode/consumes/gate — see the linked-projects design spec §2. */
export type SourceLinkMode = "clone" | "live"
export type SourceLinkConsumes = "source" | "target"
export type SourceLinkGate = "head" | "validated"

/**
 * Load a project including its `source_project_id`. Returns null if the
 * project doesn't exist. Includes archived rows — the link/detach surface
 * needs to see them to e.g. warn about archived-upstream / blocked-delete.
 */
export async function loadProjectWithSource(
  env: Env,
  projectId: string,
): Promise<SourceLinkProject | null> {
  return env.AQUILLA_PG.prepare(
    `SELECT id, name, source_project_id, source_link_mode, source_link_consumes, archived_at
       FROM projects WHERE id = ?`,
  )
    .bind(projectId)
    .first<SourceLinkProject>()
}

/**
 * Walk the source chain upstream from `startId` and return true iff
 * `bannedId` is encountered. Used to reject would-be cycles: when linking
 * A → B, we check whether B's upstream chain ever loops back to A.
 *
 * Loops on truly malformed data (already-cyclic rows) are bounded by a
 * hard step cap. The cap is generous — real chains should be a small
 * handful of hops, and an honest cycle is what we're explicitly testing
 * for, so the cap is a safety net rather than the primary detector.
 */
export async function chainContains(
  env: Env,
  startId: string,
  bannedId: string,
  maxSteps = 32,
): Promise<boolean> {
  let cursor: string | null = startId
  const seen = new Set<string>()
  for (let i = 0; i < maxSteps; i++) {
    if (cursor == null) return false
    if (cursor === bannedId) return true
    if (seen.has(cursor)) {
      // Existing cycle in the DB — bail rather than loop forever. The
      // caller treats this as "yes, banned encountered" out of caution.
      return true
    }
    seen.add(cursor)
    const row: { source_project_id: string | null } | null =
      await env.AQUILLA_PG.prepare(
        "SELECT source_project_id FROM projects WHERE id = ?",
      )
        .bind(cursor)
        .first<{ source_project_id: string | null }>()
    cursor = row?.source_project_id ?? null
  }
  // Exceeded cap; treat as cyclic.
  return true
}

/**
 * Return ids of projects whose `source_project_id` points at `projectId`
 * — i.e. its direct downstream linked targets. Used to:
 *   - block deletion of a project that still has downstreams
 *   - surface an "archiving an upstream" warning to the actor
 */
export async function listDownstreamProjects(
  env: Env,
  projectId: string,
): Promise<string[]> {
  const rows = await env.AQUILLA_PG.prepare(
    "SELECT id FROM projects WHERE source_project_id = ?",
  )
    .bind(projectId)
    .all<{ id: string }>()
  return (rows.results ?? []).map((r) => r.id)
}

/**
 * Write a `project.link-source` event into the `events` table. The
 * projection handler is owned by Phase 1A's sync-worker code; we just
 * persist the durable record here. Schema_version is pinned to 1 — the
 * envelope is locked by AD-2.
 *
 * The `events` table is created by 1A's `0002_events.sql`. If the table
 * isn't present (which can happen in test envs that only loaded 0001),
 * this is a no-op rather than a hard failure — the routes that call this
 * still need to work for permission/cycle-check unit tests.
 */
export async function emitLinkSourceEvent(
  env: Env,
  args: {
    projectId: string
    authorUsername: string
    sourceProjectId: string | null
  },
): Promise<void> {
  if (!env.AQUILLA_PG) return
  const now = Date.now()
  const id = makeEventId()
  const payload = JSON.stringify({ sourceProjectId: args.sourceProjectId })

  try {
    const serverSeq = await nextServerSeq(env, args.projectId)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO events
         (id, schema_version, project_id, file_id, cell_id, parent_id, kind,
          author, payload, client_ts, server_ts, server_seq)
       VALUES (?, 1, ?, NULL, NULL, NULL, 'project.link-source',
               ?, ?, ?, ?, ?)`,
    )
      .bind(id, args.projectId, args.authorUsername, payload, now, now, serverSeq)
      .run()
  } catch (err) {
    // 1A's events table missing OR table shape unknown (e.g. STRICT
    // column-set mismatch). Don't 500 the caller — link/detach success is
    // recorded in `projects.source_project_id` regardless; the projector
    // will catch up after 1A merges and the table is present.
    console.warn("emitLinkSourceEvent failed (events table missing?):", err)
  }
}

/**
 * Copy every `files` row from `upstreamProjectId` onto `targetProjectId`.
 * `files.id` is a GLOBAL primary key (not scoped by project_id — see
 * db/postgres/schema.sql), so the target's copy CANNOT reuse the upstream's
 * file id: doing so collides with `ON CONFLICT (id)` against the upstream's
 * own row and silently reassigns/no-ops instead of creating a target row
 * (confirmed while writing this: an earlier version of this function did
 * exactly that, leaving the target with 0 files despite `copied > 0`-shaped
 * logic never even running). Each target file gets a freshly minted id;
 * returns the upstream-id → target-id map so `snapshotSourceCells` can
 * rewrite `file_id` on the cell rows it copies.
 *
 * Idempotent across re-runs within one target project — a second clone/detach
 * snapshot updates the previously-created copy in place rather than creating a
 * duplicate file.
 *
 * AQU-1358: the match is keyed on the UPSTREAM FILE ID, recorded in the
 * target copy's `meta.upstreamFileId` the first time it is written. Keying on
 * name alone is what minted duplicates: rename a file upstream and the name
 * lookup misses, so the next snapshot created a SECOND target row beside the
 * one it should have renamed. Upstream id is stable across renames, so the
 * re-run renames in place and stays a no-op for untouched files.
 *
 * AQU-1547: the match NEVER falls back to the display name, and never
 * considers a deleted row. A name is not an identity — it cannot distinguish
 * the copy this link brought in from a file the project imported itself years
 * earlier, and picking the latter overwrote real translated work with the
 * upstream's source (an established project linked under AQU-1525/1526 is
 * explicitly allowed to hold a file sharing an upstream file's name). The two
 * keys below are both identities:
 *
 *   1. `meta.upstreamFileId` — written by this function on every copy it makes.
 *   2. `deterministicDownstreamFileId` — the id a LIVE link's mirror gives a
 *      mirrored row, which carries no marker because the mirror passes the
 *      upstream's own meta through verbatim.
 *
 * Neither can name-collide with a locally imported file. When neither matches
 * (no mirror ever ran, or a pre-AQU-1358 legacy copy) the upstream file is
 * copied to a NEW row: a duplicate file the lead can delete is recoverable,
 * silently overwriting their source text and stranding its translations is
 * not.
 *
 * Best-effort: returns an empty map on any failure (matches
 * `snapshotSourceCells`'s defensive posture — missing/legacy schema must not
 * 500 the caller).
 */
export async function snapshotSourceFiles(
  env: Env,
  args: {
    upstreamProjectId: string
    targetProjectId: string
    authorUsername: string
    /** AQU-1559: the upstream files this link follows, or null for the whole
     *  project. A subset link must not hand the project files it never
     *  followed — detach keeps what the link brought in, it does not widen it. */
    onlyUpstreamFileIds?: string[] | null
    /** AQU-1679: upstream file id → the project's OWN file that stood in for it
     *  under the link. Such a file is already this project's and is left as it
     *  is; it only joins the map, so the cell snapshot writes into it. */
    adoptedFileIdOf?: Readonly<Record<string, string>> | null
  },
): Promise<Map<string, string>> {
  const fileIdMap = new Map<string, string>()
  if (!env.AQUILLA_PG) return fileIdMap
  const now = Date.now()

  let files: Array<{
    id: string
    name: string
    role: string | null
    kind: string | null
    book_code: string | null
    meta: string | null
  }> = []
  try {
    const rows = await env.AQUILLA_PG.prepare(
      `SELECT id, name, role, kind, book_code, meta
         FROM files
        WHERE project_id = ? AND deleted_at IS NULL`,
    )
      .bind(args.upstreamProjectId)
      .all<{
        id: string
        name: string
        role: string | null
        kind: string | null
        book_code: string | null
        meta: string | null
      }>()
    files = rows.results ?? []
  } catch {
    return fileIdMap
  }

  // AQU-1559: a fixed-list link copies only the files it followed. Applied here
  // rather than in SQL so the snapshot stays one query per project whatever the
  // selection's size, and so an id in the list that the upstream no longer has
  // simply drops out.
  if (args.onlyUpstreamFileIds) {
    const followed = new Set(args.onlyUpstreamFileIds)
    files = files.filter((f) => followed.has(f.id))
  }

  // AQU-1358: the target's existing files, read once and matched in JS rather
  // than with `meta::jsonb ->> …` in SQL — `files.meta` is TEXT, so a single
  // malformed legacy blob would make the cast throw and (inside this
  // best-effort loop) silently drop that file from the snapshot.
  //
  // AQU-1547: `deleted_at IS NULL` — a file in Recently deleted is not a
  // snapshot target. Writing to one edited work the lead had already set aside
  // and handed it back changed on restore, and a tombstoned row is never the
  // "project's current copy" of anything.
  const byUpstreamId = new Map<string, string>()
  const liveFileIds = new Set<string>()
  try {
    const existingRows = await env.AQUILLA_PG.prepare(
      `SELECT id, meta FROM files WHERE project_id = ? AND deleted_at IS NULL`,
    )
      .bind(args.targetProjectId)
      .all<{ id: string; meta: string | null }>()
    for (const row of existingRows.results ?? []) {
      liveFileIds.add(row.id)
      const upstreamId = readUpstreamFileId(row.meta)
      if (upstreamId != null) byUpstreamId.set(upstreamId, row.id)
    }
  } catch (err) {
    console.warn("snapshotSourceFiles: existing-file scan failed:", err)
  }

  for (const file of files) {
    // AQU-1679: the project's own file followed this upstream file. It is not a
    // copy to refresh — its name, kind and meta are the project's own (the
    // import it came from, the blob its export round-trips through) and stay.
    const adoptedId = args.adoptedFileIdOf?.[file.id]
    if (adoptedId && liveFileIds.has(adoptedId)) {
      fileIdMap.set(file.id, adoptedId)
      continue
    }
    try {
      // AQU-1547: identity only — the marker this function writes, else the
      // live mirror's deterministic id if such a row is actually present. No
      // name fallback: see the doc comment above.
      const mirroredId = deterministicDownstreamFileId(args.targetProjectId, file.id)
      const existingId =
        byUpstreamId.get(file.id) ?? (liveFileIds.has(mirroredId) ? mirroredId : undefined)

      const targetFileId = existingId ?? crypto.randomUUID()
      const eventId = makeEventId()
      // Stamp the upstream id so the next run matches by identity rather than
      // by name, including after the upstream file is renamed.
      const targetMeta = withUpstreamFileId(file.meta, file.id)
      await env.AQUILLA_PG.prepare(
        `INSERT INTO files (
           id, project_id, name, role, kind, book_code,
           event_id, created_by, created_at, updated_at, meta
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           kind = excluded.kind,
           book_code = excluded.book_code,
           event_id = excluded.event_id,
           meta = excluded.meta,
           updated_at = excluded.updated_at`,
      )
        .bind(
          targetFileId,
          args.targetProjectId,
          file.name,
          file.role,
          file.kind,
          file.book_code,
          eventId,
          args.authorUsername,
          now,
          now,
          targetMeta,
        )
        .run()
      // Claim the row for this upstream file so a second upstream file can
      // never be mapped onto it within this same run.
      byUpstreamId.set(file.id, targetFileId)
      liveFileIds.add(targetFileId)
      fileIdMap.set(file.id, targetFileId)
    } catch (err) {
      console.warn(`snapshotSourceFiles: insert failed for ${file.id}:`, err)
    }
  }

  return fileIdMap
}

/**
 * AQU-1608: which of a project's files are in Recently deleted, by id.
 *
 * `snapshotSourceFiles` copies only live files (`deleted_at IS NULL`), but the
 * cell SELECT in `snapshotSourceCells` reads every source row in the project.
 * On a whole-project copy — the default, with every listed file left checked —
 * that handed the new project the source lines of a file the upstream had
 * tombstoned, keyed to a `file_id` the new project has no row for: invisible in
 * the file list, but returned by project-wide search (`scoped-search.ts` matches
 * on `project_id` alone) and counted as an extra unnamed file by the health
 * rollup, which builds its file list from `DISTINCT file_id` on `cells`.
 *
 * Returns `null` — not an empty set — when the question cannot be answered, so
 * a failure degrades to the pre-AQU-1608 behaviour (copy everything) rather
 * than to an empty clone. Same posture as `hiddenSourceCellKeys` below.
 */
async function deletedFileIds(env: Env, projectId: string): Promise<Set<string> | null> {
  if (!env.AQUILLA_PG) return null
  try {
    const rows = await env.AQUILLA_PG.prepare(
      `SELECT id FROM files WHERE project_id = ? AND deleted_at IS NOT NULL`,
    )
      .bind(projectId)
      .all<{ id: string }>()
    return new Set((rows.results ?? []).map((r) => r.id))
  } catch {
    return null
  }
}

/**
 * AQU-1679: `<file id>\0<upstream cell id>` → the project's own cell id, for
 * the files the link followed into (`cells.upstream_cell_id`, migration 0140).
 *
 * Empty on any failure, and on a database that predates the column — where no
 * file can have been adopted, so there is nothing to map.
 */
async function adoptedCellIds(
  env: Env,
  projectId: string,
  fileIds: readonly string[],
): Promise<Map<string, string>> {
  const mapping = new Map<string, string>()
  for (const fileId of fileIds) {
    try {
      const { results } = await env.AQUILLA_PG.prepare(
        `SELECT cell_id, upstream_cell_id FROM cells
          WHERE project_id = ? AND file_id = ? AND side = 'source' AND upstream_cell_id IS NOT NULL`,
      )
        .bind(projectId, fileId)
        .all<{ cell_id: string; upstream_cell_id: string }>()
      for (const row of results ?? []) mapping.set(`${fileId}\0${row.upstream_cell_id}`, row.cell_id)
    } catch {
      return new Map()
    }
  }
  return mapping
}

/**
 * AQU-1453: which source cells of a project are currently PARKED, as a set of
 * `file_id\0cell_id` keys.
 *
 * Returns `null` — not an empty set — when the question cannot be answered,
 * which is the whole point of the signature. `cells.hidden_at` arrives with
 * migration 0116, and this module's documented posture is that a snapshot must
 * degrade rather than fail on a database that predates a column. `null` means
 * "this deployment has no visibility to copy", and `snapshotSourceCells` then
 * behaves exactly as it did before this change; an empty set would instead mean
 * "nothing is parked", which on an older database would be a guess.
 *
 * Deliberately a separate query rather than two more columns on the main cell
 * SELECT: folding `hidden_at` into that one would make a missing column abort
 * the entire snapshot, turning a lost nuance into a clone with no cells at all.
 */
async function hiddenSourceCellKeys(
  env: Env,
  projectId: string,
): Promise<Set<string> | null> {
  if (!env.AQUILLA_PG) return null
  try {
    const rows = await env.AQUILLA_PG.prepare(
      `SELECT file_id, cell_id
         FROM cells
        WHERE project_id = ? AND side = 'source' AND hidden_at IS NOT NULL`,
    )
      .bind(projectId)
      .all<{ file_id: string; cell_id: string }>()
    return new Set((rows.results ?? []).map((r) => `${r.file_id}\0${r.cell_id}`))
  } catch {
    return null
  }
}

/**
 * Snapshot every source-side cell from `upstreamProjectId` as a burst of
 * local source events on `targetProjectId`. Used by the detach flow
 * (project lifecycle step 4) AND by clone-mode linking at creation time
 * (§2 — "snapshot at birth is exactly clone semantics"): the upstream's
 * current source content becomes this project's local source, once.
 *
 * Copies `files` first (see `snapshotSourceFiles`) so the cell rows below
 * resolve to a real file — a clone with 0 file rows was BUG-1 in the
 * 2026-07-06 live-UI QA pass.
 *
 * AQU-1608: and only the cells of the files it actually copied. A file the
 * upstream has moved to Recently deleted is left out of both halves — its
 * lines in the new project would point at a file row that does not exist here.
 *
 * Existing local source cells receive `source.cell.commit` events chained to
 * their current head; missing rows receive `source.cell.create` genesis
 * events. Events are authored by the detacher.
 *
 * AQU-1453: a cell the upstream lead PARKED arrives parked. Hiding a cell is
 * part of curating a source, so a project cloned from a curated source must not
 * start by un-parking everything its upstream deliberately set aside. The copy
 * is an ordinary `source.cell.visibility.set` event rather than a bare column
 * write, so the receiving project's own lead can show the cell again — the
 * acceptance criterion is that the hide stays reversible downstream.
 *
 * Returns the count of cell events emitted (0 if the cells projection isn't
 * available yet — same defensive posture as emitLinkSourceEvent).
 */
export async function snapshotSourceCells(
  env: Env,
  args: {
    upstreamProjectId: string
    targetProjectId: string
    authorUsername: string
    /** AQU-1559: the upstream files this link follows, or null/absent for the
     *  whole project. Cells of an unfollowed file are skipped, so a detach on a
     *  subset link leaves exactly the files the link brought in. */
    onlyUpstreamFileIds?: string[] | null
    /** AQU-1679: upstream file id → the project's own file that stood in for it
     *  under the link (detach passes the record it is about to clear). */
    adoptedFileIdOf?: Readonly<Record<string, string>> | null
  },
): Promise<number> {
  if (!env.AQUILLA_PG) return 0
  const now = Date.now()

  // QA-BUG-1: files must be copied (and their upstream id remapped to a
  // fresh target-owned id — files.id is a GLOBAL PK, see
  // snapshotSourceFiles's doc comment) BEFORE the cell rows below, which
  // reference file_id and must point at the target's own file row, not the
  // upstream's.
  const fileIdMap = await snapshotSourceFiles(env, args)  // same `onlyUpstreamFileIds`

  // AQU-1679: in a file the project already had, an upstream cell's text
  // belongs on the project's OWN cell — the one the mirror joined it to, which
  // is where the translations are. Without this the snapshot would create every
  // upstream line a second time, under the upstream's ids, in that same file.
  const adoptedCellIdOf = await adoptedCellIds(
    env,
    args.targetProjectId,
    Object.values(args.adoptedFileIdOf ?? {}),
  )

  // AQU-1453: the upstream's parked cells, and the target's own, read once
  // rather than per cell. `null` from either means this deployment predates
  // `cells.hidden_at` (see `hiddenSourceCellKeys`) — visibility is then left
  // entirely alone and the rest of the snapshot proceeds untouched.
  const upstreamHidden = await hiddenSourceCellKeys(env, args.upstreamProjectId)
  const targetHidden = upstreamHidden === null
    ? null
    : await hiddenSourceCellKeys(env, args.targetProjectId)

  // Phase 1A's `cells` table has schema columns:
  //   project_id, file_id, cell_id, side, value, value_html, type,
  //   canonical_ref, anchor_cell_id, event_id, source_event_id,
  //   last_editor, last_edit_at, validated, word_count.
  // The 0001 cells table is a sync-worker projection with a different
  // column set (no project_id / side). We try the AD-9 shape first; if
  // the table doesn't have those columns yet, we skip the burst — 1A
  // will replay snapshots correctly once its migrations land.
  let cells: Array<{
    file_id: string
    cell_id: string
    value: string
    value_html: string | null
    type: string | null
    canonical_ref: string | null
    anchor_cell_id: string | null
    metadata: Record<string, unknown> | null
  }> = []
  try {
    const rows = await env.AQUILLA_PG.prepare(
      // AQU-1520: `metadata` carries the import envelope
      // (`aquillaImport.milestone`) the section navigator builds its titles
      // from. A clone that copies text/type/ref but not this one shows
      // app-invented "Part N" divisions where the upstream shows "Acts
      // Preface" and the named chapter sections.
      `SELECT file_id, cell_id, value, value_html, type, canonical_ref, anchor_cell_id,
              metadata
         FROM cells
        WHERE project_id = ? AND side = 'source'`,
    )
      .bind(args.upstreamProjectId)
      .all<{
        file_id: string
        cell_id: string
        value: string
        value_html: string | null
        type: string | null
        canonical_ref: string | null
        anchor_cell_id: string | null
        metadata: Record<string, unknown> | null
      }>()
    cells = rows.results ?? []
  } catch {
    return 0
  }

  // AQU-1559: cells of a file this link never followed are not this project's
  // to receive. Keyed on the upstream file id — the same identity the selection
  // is stored with, so a rename upstream cannot change what is copied.
  if (args.onlyUpstreamFileIds) {
    const followed = new Set(args.onlyUpstreamFileIds)
    cells = cells.filter((c) => followed.has(c.file_id))
  }

  // AQU-1608: and nor are the lines of a file the upstream moved to Recently
  // deleted. `snapshotSourceFiles` above already leaves that file out, so
  // without this its cells would arrive pointing at a file row this project
  // does not have — hidden from the file list, but found by project-wide search
  // and counted by the health rollup. A subset copy was already safe (the
  // selection never lists a deleted file); the whole-project copy was not.
  const deletedUpstream = await deletedFileIds(env, args.upstreamProjectId)
  if (deletedUpstream !== null && deletedUpstream.size > 0) {
    cells = cells.filter((c) => !deletedUpstream.has(c.file_id))
  }

  if (cells.length === 0) return 0

  // Best-effort batch insert. Existing target rows are committed against
  // their current source-side chain head; missing rows are created as source
  // genesis events so a detached project becomes self-contained.
  let emitted = 0
  for (const cell of cells) {
    // QA-BUG-1: files.id is a global PK, so the target's file copy has its
    // OWN id (see snapshotSourceFiles) — cell rows must follow that mapping,
    // not the upstream's file_id, or they'd reference a file row that
    // belongs to a different project (or doesn't exist under this one).
    const targetFileId = fileIdMap.get(cell.file_id) ?? cell.file_id
    const targetCellId = adoptedCellIdOf.get(`${targetFileId}\0${cell.cell_id}`) ?? cell.cell_id
    const id = makeEventId()
    // AQU-1520: normalized once — the genesis payload below and the `cells`
    // row it projects to must carry the same envelope, or a log replay would
    // disagree with the row it rebuilt.
    const metadata = cellMetadata(cell.metadata)
    try {
      const existing = await env.AQUILLA_PG.prepare(
        `SELECT event_id
           FROM cells
          WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
      )
        .bind(args.targetProjectId, targetFileId, targetCellId)
        .first<{ event_id: string }>()

      const kind = existing ? "source.cell.commit" : "source.cell.create"
      const payload = existing
        ? JSON.stringify({
            value: cell.value,
            valueHtml: cell.value_html ?? undefined,
          })
        : JSON.stringify({
            cellId: targetCellId,
            anchorCellId: cell.anchor_cell_id,
            value: cell.value,
            valueHtml: cell.value_html ?? undefined,
            type: cell.type ?? undefined,
            canonicalRef: cell.canonical_ref ?? undefined,
            // AQU-1520: the import envelope travels with the genesis event, so
            // a replay of the log rebuilds the clone's section navigation too
            // — the `cells` insert below is a projection of this payload, not
            // an independent truth.
            metadata: metadata ?? undefined,
          })
      const serverSeq = await nextServerSeq(env, args.targetProjectId)

      await env.AQUILLA_PG.prepare(
        `INSERT INTO events
           (id, schema_version, project_id, file_id, cell_id, parent_id, kind,
            author, payload, client_ts, server_ts, server_seq)
         VALUES (?, 1, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          args.targetProjectId,
          targetFileId,
          targetCellId,
          existing?.event_id ?? null,
          kind,
          args.authorUsername,
          payload,
          now,
          now,
          serverSeq,
        )
        .run()

      const hash = contentHash(cell.value)
      const wordCount = countWords(cell.value)
      const metadataJson = metadata === null ? null : JSON.stringify(metadata)
      if (existing) {
        await env.AQUILLA_PG.prepare(
          `UPDATE cells
              SET value = ?,
                  value_html = ?,
                  event_id = ?,
                  last_editor = ?,
                  last_edit_at = ?,
                  word_count = ?,
                  content_hash = ?
            WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
        )
          .bind(
            cell.value,
            cell.value_html,
            id,
            args.authorUsername,
            now,
            wordCount,
            hash,
            args.targetProjectId,
            targetFileId,
            targetCellId,
          )
          .run()
      } else {
        await env.AQUILLA_PG.prepare(
          // AQU-1240 slice 8: snapshotted source rows -> the target project's
          // source lane. Inlined (mirrors laneIdResolveSql('source')); NULL until
          // the project's lanes exist, then filled by the backfill.
          `INSERT INTO cells (
            project_id, file_id, cell_id, side, value, value_html, type,
            canonical_ref, anchor_cell_id, event_id, source_event_id,
            last_editor, last_edit_at, validated, word_count, content_hash,
            metadata, lane_id
          ) VALUES (?, ?, ?, 'source', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?,
                    ?::text::jsonb,
                    (SELECT id FROM public.lanes WHERE project_id = ? AND role = 'source'))`,
        )
          .bind(
            args.targetProjectId,
            targetFileId,
            targetCellId,
            cell.value,
            cell.value_html,
            cell.type,
            cell.canonical_ref,
            cell.anchor_cell_id,
            id,
            args.authorUsername,
            now,
            wordCount,
            hash,
            // AQU-1520: projects the genesis payload's import envelope, so the
            // clone's section navigator reads the upstream's real divisions
            // instead of falling back to "Part N". JSON text + an explicit
            // cast, the same shape the sync-worker projection binds JSONB with.
            metadataJson,
            args.targetProjectId,
          )
          .run()
      }
      // AQU-1453: carry the cell's visibility across, in whichever direction it
      // differs. A re-snapshot (detach, or a second clone onto the same target)
      // has to be able to SHOW a cell the upstream un-parked as well as hide one
      // it parked, or the target drifts a little further from its source on
      // every pass.
      //
      // Only when it actually differs: the overwhelming case is a project with
      // nothing parked, and an unconditional event per cell would put one
      // no-op `source.cell.visibility.set` in the log for every verse of a
      // Bible.
      if (upstreamHidden !== null) {
        const wantHidden = upstreamHidden.has(`${cell.file_id}\0${cell.cell_id}`)
        // A row that does not exist yet cannot be parked, so a fresh create is
        // visible — which is what makes `false` the right default here.
        const isHidden = targetHidden?.has(`${targetFileId}\0${targetCellId}`) ?? false
        if (wantHidden !== isHidden) {
          const visibilityEventId = makeEventId()
          const visibilitySeq = await nextServerSeq(env, args.targetProjectId)
          await env.AQUILLA_PG.prepare(
            `INSERT INTO events
               (id, schema_version, project_id, file_id, cell_id, parent_id, kind,
                author, payload, client_ts, server_ts, server_seq)
             VALUES (?, 1, ?, ?, ?, NULL, 'source.cell.visibility.set',
                     ?, ?, ?, ?, ?)`,
          )
            .bind(
              visibilityEventId,
              args.targetProjectId,
              targetFileId,
              targetCellId,
              args.authorUsername,
              JSON.stringify({ hidden: wantHidden }),
              now,
              now,
              visibilitySeq,
            )
            .run()
          // `parent_id` is NULL and `cells.event_id` is deliberately NOT moved:
          // `source.cell.visibility.set` is non-chain-mutating (AQU-1422), so
          // parking a cell must not advance the source head and make every
          // lane's translation of it go stale under AD-9.
          await env.AQUILLA_PG.prepare(
            `UPDATE cells SET hidden_at = ?
              WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
          )
            .bind(
              wantHidden ? now : null,
              args.targetProjectId,
              targetFileId,
              targetCellId,
            )
            .run()
        }
      }
      emitted++
    } catch (err) {
      console.warn(
        `snapshotSourceCells: insert failed for ${cell.cell_id}:`,
        err,
      )
    }
  }

  return emitted
}

/**
 * AQU-1605: resolve the UPSTREAM lane a link is being pointed at.
 *
 * The caller chooses the lane, so the server has to be the one that says the
 * choice is legitimate — the picker it came from lists only what the user may
 * see, and a request that did not come from that picker must not be able to
 * reach further. Three things are checked, in the order that makes the error
 * useful:
 *
 *  1. The lane belongs to THIS upstream project, in the role the link's
 *     `consumes` implies — a `'target'` link consumes one of the upstream's
 *     translations, a `'source'` link its source lane. Lane ids are globally
 *     unique (AQU-1606), so a lane id from another project resolves to a real
 *     row and would otherwise be stored as a lane this upstream has never had.
 *  2. The lane is not archived. An archived lane is frozen (AQU-1462), so a
 *     link to one can only ever mirror a corpus nobody may still edit; the
 *     pickers do not offer one, and accepting it here would create a link that
 *     looks live and never moves.
 *  3. The caller may SEE the lane. Linking already requires viewer+ on the
 *     upstream, but the lane read wall can narrow that to a subset of its
 *     lanes — and a link is a read: it copies the lane's text into a project the
 *     caller controls. Without this check, a member granted one lane of an
 *     upstream could mirror any other lane's translations out of it.
 *
 * Omitting the lane does not mean "the former default lane". A new link always
 * stores a concrete id: a source link stores the upstream source lane, and a
 * target link stores the one non-archived target lane the caller can see.
 * Several (or none) is a 400 — storing null would make the fold consume the
 * `legacy_tag = ''` lane, including for a member who was never granted it.
 * Existing rows may still be null until AQU-1616's backfill; that is a read
 * concern, not a shape this writer produces.
 */
export type UpstreamLaneChoice =
  | { ok: true; laneId: string }
  | { ok: false; error: string; status: 400 | 403 }

export async function resolveUpstreamLinkLane(
  env: Env,
  args: {
    upstreamProjectId: string
    consumes: "source" | "target"
    laneId: string | null | undefined
    userId: number
    upstreamRole: number
  },
): Promise<UpstreamLaneChoice> {
  const { upstreamProjectId, consumes, userId, upstreamRole } = args
  let laneId = args.laneId ?? null
  const role = consumes === "target" ? "target" : "source"
  if (!laneId) {
    // Fixtures and any project the lane backfill has not reached have no
    // `lanes` rows. A new link still has to store an id, so mint the lanes the
    // project's settings describe first: a source lane, and a target lane only
    // when a target language or tagged data says there is one (AQU-1594 never
    // invents one). A project that already has lanes is left alone — that
    // could add a lane beside the ones already chosen.
    const anyLane = await env.AQUILLA_PG.prepare(
      `SELECT 1 AS present FROM lanes WHERE project_id = ? LIMIT 1`,
    )
      .bind(upstreamProjectId)
      .first<{ present: number }>()
    if (!anyLane) await ensureProjectLanes(env.AQUILLA_PG, upstreamProjectId)
    if (role === "source") {
      const source = await env.AQUILLA_PG.prepare(
        `SELECT id FROM lanes WHERE project_id = ? AND role = 'source'`,
      )
        .bind(upstreamProjectId)
        .first<{ id: string }>()
      if (!source) {
        return { ok: false, status: 400, error: "source project has no source lane" }
      }
      laneId = source.id
    } else {
      const { results } = await env.AQUILLA_PG.prepare(
        `SELECT id FROM lanes
          WHERE project_id = ? AND role = 'target' AND archived_at IS NULL
          ORDER BY position, id`,
      )
        .bind(upstreamProjectId)
        .all<{ id: string }>()
      let ids = (results ?? []).map((row) => row.id)
      const { visible } = await visibleTagsForMember(
        env.AQUILLA_PG,
        env.LANE_READ_WALL,
        upstreamProjectId,
        userId,
        upstreamRole,
      )
      if (visible !== null) ids = ids.filter((id) => visible.has(id))
      if (ids.length !== 1) {
        return {
          ok: false,
          status: 400,
          error:
            ids.length === 0
              ? "no target lane of the source project is available to link"
              : "choose which target lane of the source project this link follows",
        }
      }
      laneId = ids[0]
    }
  }
  const lane = await env.AQUILLA_PG.prepare(
    `SELECT id, role, archived_at FROM lanes WHERE id = ? AND project_id = ?`,
  )
    .bind(laneId, upstreamProjectId)
    .first<{ id: string; role: string; archived_at: string | null }>()
  if (!lane || lane.role !== role) {
    return {
      ok: false,
      status: 400,
      error: `lane not found on the source project (expected one of its ${role} lanes)`,
    }
  }
  if (lane.archived_at) {
    return { ok: false, status: 400, error: "that lane is archived" }
  }
  // The read wall only ever restricts TARGET lanes, and only below Maintainer;
  // `visible === null` is an unrestricted caller.
  if (role === "target") {
    const { visible } = await visibleTagsForMember(
      env.AQUILLA_PG,
      env.LANE_READ_WALL,
      upstreamProjectId,
      userId,
      upstreamRole,
    )
    if (visible !== null && !visible.has(laneId)) {
      return { ok: false, status: 403, error: "no access to that lane of the source project" }
    }
  }
  return { ok: true, laneId }
}

/** A live re-link that keeps following the same upstream lane.
 *
 *  Equal ids are the same lane. NULL is the pre-AQU-1616 shape: a source link
 *  already follows the upstream source lane, and a target link the `''` lane.
 *  Naming that lane is not a change. Any other id is.
 */
export async function liveLinkKeepsLane(
  env: Env,
  args: {
    upstreamProjectId: string
    consumes: "source" | "target"
    storedLaneId: string | null
    requestedLaneId: string
  },
): Promise<boolean> {
  if (args.storedLaneId === args.requestedLaneId) return true
  if (args.storedLaneId !== null) return false
  const row =
    args.consumes === "source"
      ? await env.AQUILLA_PG.prepare(
          `SELECT id FROM lanes WHERE project_id = ? AND role = 'source'`,
        )
          .bind(args.upstreamProjectId)
          .first<{ id: string }>()
      : await env.AQUILLA_PG.prepare(
          `SELECT id FROM lanes
            WHERE project_id = ? AND role = 'target' AND legacy_tag = ''`,
        )
          .bind(args.upstreamProjectId)
          .first<{ id: string }>()
  return row?.id === args.requestedLaneId
}
