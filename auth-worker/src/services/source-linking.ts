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
import type { Env } from "../types"

/** Server-generated event id for identity-side maintenance events. */
export function makeEventId(): string {
  return crypto.randomUUID()
}

/**
 * FRO-476: mint a short-lived service sync-token and POST
 * /api/v1/projects/:projectId/link/sync on the downstream project — this
 * is "seeding is the first mirror sync" (design spec §5): linking a project
 * with mode='live' runs the same engine a lazy file-open would, so files +
 * cells arrive as `file.mirror`/`source.cell.mirror` events with provenance
 * set from birth (never a direct `snapshotSourceCells`-style projection
 * write, which would leave `upstream_event_id` NULL).
 *
 * Best-effort: link/detach success is recorded in `projects.source_project_id`
 * etc. regardless of whether this trigger lands — the lazy-pull trigger on
 * next file-open (useStaleSourceCells) is the self-healing floor per §5.
 */
export async function triggerLinkSeedSync(
  env: Env,
  downstreamProjectId: string,
): Promise<void> {
  if (!env.SYNC_WORKER_URL || !env.SYNC_SECRET_KEY) return
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
    await fetch(
      `${env.SYNC_WORKER_URL.replace(/\/$/, "")}/api/v1/projects/${encodeURIComponent(downstreamProjectId)}/link/sync`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } },
    )
  } catch (err) {
    console.warn(`triggerLinkSeedSync failed for ${downstreamProjectId}:`, err)
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

function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

export interface SourceLinkProject {
  id: string
  name: string
  source_project_id: string | null
  archived_at: string | null
}

/** FRO-476: link mode/consumes/gate — see the linked-projects design spec §2. */
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
    `SELECT id, name, source_project_id, archived_at
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
 * Snapshot every source-side cell from `upstreamProjectId` as a burst of
 * local source events on `targetProjectId`. Used by the detach flow
 * (project lifecycle step 4): after the link is cleared, the upstream's
 * current source cells become this project's local source.
 *
 * Existing local source cells receive `source.cell.commit` events chained to
 * their current head; missing rows receive `source.cell.create` genesis
 * events. Events are authored by the detacher.
 *
 * Returns the count of events emitted (0 if the cells projection isn't
 * available yet — same defensive posture as emitLinkSourceEvent).
 */
export async function snapshotSourceCells(
  env: Env,
  args: {
    upstreamProjectId: string
    targetProjectId: string
    authorUsername: string
  },
): Promise<number> {
  if (!env.AQUILLA_PG) return 0
  const now = Date.now()

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
  }> = []
  try {
    const rows = await env.AQUILLA_PG.prepare(
      `SELECT file_id, cell_id, value, value_html, type, canonical_ref, anchor_cell_id
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
      }>()
    cells = rows.results ?? []
  } catch {
    return 0
  }

  if (cells.length === 0) return 0

  // Best-effort batch insert. Existing target rows are committed against
  // their current source-side chain head; missing rows are created as source
  // genesis events so a detached project becomes self-contained.
  let emitted = 0
  for (const cell of cells) {
    const id = makeEventId()
    try {
      const existing = await env.AQUILLA_PG.prepare(
        `SELECT event_id
           FROM cells
          WHERE project_id = ? AND file_id = ? AND cell_id = ? AND side = 'source'`,
      )
        .bind(args.targetProjectId, cell.file_id, cell.cell_id)
        .first<{ event_id: string }>()

      const kind = existing ? "source.cell.commit" : "source.cell.create"
      const payload = existing
        ? JSON.stringify({
            value: cell.value,
            valueHtml: cell.value_html ?? undefined,
          })
        : JSON.stringify({
            cellId: cell.cell_id,
            anchorCellId: cell.anchor_cell_id,
            value: cell.value,
            valueHtml: cell.value_html ?? undefined,
            type: cell.type ?? undefined,
            canonicalRef: cell.canonical_ref ?? undefined,
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
          cell.file_id,
          cell.cell_id,
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
            cell.file_id,
            cell.cell_id,
          )
          .run()
      } else {
        await env.AQUILLA_PG.prepare(
          `INSERT INTO cells (
            project_id, file_id, cell_id, side, value, value_html, type,
            canonical_ref, anchor_cell_id, event_id, source_event_id,
            last_editor, last_edit_at, validated, word_count, content_hash
          ) VALUES (?, ?, ?, 'source', ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, ?)`,
        )
          .bind(
            args.targetProjectId,
            cell.file_id,
            cell.cell_id,
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
          )
          .run()
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
