// Named snapshot create, list, view, delete, and restore routes (FRO-176).
//
// Endpoints:
//   POST   /api/v1/projects/:projectId/snapshots          — create (maintainer+)
//   GET    /api/v1/projects/:projectId/snapshots          — list active snapshots (viewer+)
//   GET    /api/v1/projects/:projectId/snapshots/:id      — view one (viewer+)
//   DELETE /api/v1/projects/:projectId/snapshots/:id      — soft-delete (maintainer+)
//   POST   /api/v1/projects/:projectId/snapshots/:id/restore — restore (maintainer+)
//
// Design (per spec snapshots-and-history.md):
//   - A snapshot is a labeled timestamp (snapshot_ts = epoch ms at create time).
//   - Restore queries "latest chain-winning cell.commit per cell WHERE event.server_ts
//     <= snapshot_ts" then emits target.cell.commit events off each cell's current head.
//   - Restore is idempotent: a cell whose value already matches the snapshot value
//     is skipped (no event emitted).
//   - Restore respects the parent-chain: the new event's parent_id is the cell's
//     current cells.event_id. If cells.event_id changed between the client's click
//     and the write, that cell is skipped (reported as skippedConcurrent).
//   - All write operations are maintainer (600)+ gated; reads are viewer (100)+.

import { verifyTokenForProject } from "../auth"
import { ROLE } from "./role-policy"
import { buildEventInsertStmt } from "./event-insert"
import { buildChainClaimStmt } from "./chain-claims"

export interface SnapshotsRouteEnv {
  AQUILLA_PG?: AquillaDb
  SYNC_SECRET_KEY?: string
}

interface SnapshotRow {
  id: string
  project_id: string
  name: string
  description: string | null
  created_by: string
  snapshot_ts: number
  created_at: string
  deleted_at: string | null
}

interface SnapshotOut {
  id: string
  projectId: string
  name: string
  description: string | null
  createdBy: string
  snapshotTs: number
  createdAt: string
}

function toOut(row: SnapshotRow): SnapshotOut {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    createdBy: row.created_by,
    snapshotTs: row.snapshot_ts,
    createdAt: row.created_at,
  }
}

// Path patterns
const LIST_CREATE_RE = /^\/api\/v1\/projects\/([^/]+)\/snapshots$/
const VIEW_DELETE_RE = /^\/api\/v1\/projects\/([^/]+)\/snapshots\/([^/]+)$/
const RESTORE_RE     = /^\/api\/v1\/projects\/([^/]+)\/snapshots\/([^/]+)\/restore$/

function randomId(): string {
  return crypto.randomUUID()
}

/** Extract and verify a project-scoped sync-token JWT. */
async function verifyProject(
  request: Request,
  projectId: string,
  secret: string,
) {
  const authHeader = request.headers.get("Authorization") ?? ""
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null
  if (!token) return { ok: false as const, status: 401 as const, reason: "missing Authorization header" }
  return verifyTokenForProject(token, projectId, secret)
}

export async function handleSnapshotsRequest(
  request: Request,
  env: SnapshotsRouteEnv,
): Promise<Response | null> {
  const url = new URL(request.url)
  const path = url.pathname

  if (!env.SYNC_SECRET_KEY) return new Response("SYNC_SECRET_KEY not configured", { status: 500 })
  if (!env.AQUILLA_PG) return new Response("AQUILLA_PG binding not configured", { status: 500 })
  const db = env.AQUILLA_PG

  // ── Restore ──────────────────────────────────────────────────────────────
  const restoreMatch = path.match(RESTORE_RE)
  if (restoreMatch) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
    const projectId = decodeURIComponent(restoreMatch[1])
    const snapshotId = decodeURIComponent(restoreMatch[2])

    const auth = await verifyProject(request, projectId, env.SYNC_SECRET_KEY)
    if (!auth.ok) return new Response(auth.reason, { status: auth.status })
    if (auth.claims.role < ROLE.MAINTAINER) {
      return new Response("restore requires maintainer role", { status: 403 })
    }
    const callerUsername = auth.claims.username ?? `user:${auth.claims.userId}`

    // Load the snapshot.
    const snap = await db
      .prepare("SELECT id, project_id, snapshot_ts, deleted_at FROM snapshots WHERE id = ? AND project_id = ? LIMIT 1")
      .bind(snapshotId, projectId)
      .first<{ id: string; project_id: string; snapshot_ts: number; deleted_at: string | null }>()
    if (!snap) return new Response("snapshot not found", { status: 404 })
    if (snap.deleted_at) return new Response("snapshot has been deleted", { status: 410 })

    const snapshotTs = snap.snapshot_ts

    // Query: for each (project_id, file_id, cell_id, side) find the value at snapshot_ts.
    // We want the latest chain-winning cell.commit event whose server_ts <= snapshotTs.
    // "Chain-winning" = the event whose id is referenced by cells.event_id OR whose
    // commit led to the current head (walking backwards). For simplicity, we use the
    // cells projection at snapshot time: the cell whose event_id has server_ts <= snapshotTs
    // AND is the latest such cell.commit in the parent-chain order (server_seq).
    //
    // Practical implementation: for each cell, find the MAX(server_seq) cell.commit
    // event with server_ts <= snapshotTs. This is the "latest committed value at or
    // before the snapshot timestamp."
    // For each (project_id, file_id, cell_id) find the latest chain-winning
    // commit event at or before snapshot_ts. "Side" is derived from the event
    // kind (source.* vs target.*) — the events table has no side column.
    // We group by (project_id, file_id, cell_id) and take MAX(server_seq)
    // to get the most recent commit event in that triple at the snapshot time.
    // Then we join to cells (which has one row per (project_id, file_id, cell_id, side))
    // to get the current head event_id and value for comparison.
    const snapCellsSql = `
      SELECT
        e.project_id,
        e.file_id,
        e.cell_id,
        e.id          AS event_id,
        e.kind,
        e.payload,
        e.parent_id,
        c.event_id    AS current_event_id,
        c.value       AS current_value
      FROM events e
      JOIN (
        SELECT
          project_id, file_id, cell_id,
          MAX(server_seq) AS max_seq
        FROM events
        WHERE project_id = ?
          AND kind IN ('target.cell.create', 'target.cell.commit',
                       'source.cell.create', 'source.cell.commit')
          AND server_ts <= ?
        GROUP BY project_id, file_id, cell_id
      ) latest ON e.project_id = latest.project_id
               AND e.file_id = latest.file_id
               AND e.cell_id = latest.cell_id
               AND e.server_seq = latest.max_seq
      JOIN cells c ON c.project_id = e.project_id
                  AND c.file_id    = e.file_id
                  AND c.cell_id    = e.cell_id
      WHERE e.project_id = ?
        AND e.server_ts <= ?
    `
    interface SnapCell {
      project_id: string
      file_id: string
      cell_id: string
      event_id: string
      kind: string
      payload: string
      parent_id: string | null
      current_event_id: string
      current_value: string
    }

    const snapCells = await db
      .prepare(snapCellsSql)
      .bind(projectId, snapshotTs, projectId, snapshotTs)
      .all<SnapCell>()

    const cells = snapCells.results
    if (cells.length === 0) {
      return Response.json({
        restored: 0,
        skippedIdentical: 0,
        skippedConcurrent: 0,
        message: "No changes — snapshot matches current state or project is empty.",
      })
    }

    const now = Date.now()
    let skippedIdentical = 0

    // Emit one restore commit per cell that differs from the snapshot value.
    // Each restored cell contributes exactly THREE statements (audit B6),
    // which must land in the SAME transaction, in this order:
    //   1. the canonical `events` INSERT — allocator bump first, so the
    //      per-project counter row-lock is acquired in the same order as
    //      POST /events and restore serializes with live commits;
    //   2. the AD-2 chain claim for the slot this commit contends
    //      (parent_key = the head the CAS targets), mirroring
    //      handlers/cell-events.ts. Without it the restore event takes a
    //      chain slot in the log WITHOUT a claim row, so a racing live
    //      commit on the same head could claim the slot and win live
    //      arbitration while a later rebuild replay (lowest server_seq wins)
    //      picks the restore — silently flipping the winner;
    //   3. the cells CAS, gated BOTH on the head still matching (no
    //      concurrent edit landed between our SELECT and this transaction)
    //      AND on holding the claim.
    const STMTS_PER_CELL = 3
    const CHUNK = 50
    const stmts: AquillaStatement[] = []

    for (const cell of cells) {
      let snapPayload: { value?: string } = {}
      try { snapPayload = JSON.parse(cell.payload) } catch { /* ignore */ }
      const snapValue = snapPayload.value ?? ""

      // Parse current cell value.
      const currentValueParsed = (() => {
        try { return (JSON.parse(cell.current_value) as { value?: string }).value ?? cell.current_value }
        catch { return cell.current_value }
      })()

      if (snapValue === currentValueParsed) {
        skippedIdentical++
        continue
      }

      // Determine event kind based on what kind the snapshot event was.
      const restoreKind = cell.kind.startsWith("source.")
        ? "source.cell.commit"
        : "target.cell.commit"

      const newEventId = randomId()
      const newPayload = JSON.stringify({
        value: snapValue,
        restore_origin: { snapshot_id: snapshotId, snapshot_ts: snapshotTs },
      })

      // The parent_id for the new event is the cell's current event_id.
      // If the cell's current event_id changed since we loaded it (concurrent
      // edit), we skip this cell. server_seq comes from the shared per-project
      // allocator (event-insert.ts) — conflict-safe against concurrent
      // commits, unlike the old naked MAX(server_seq)+1 INSERT (RACE-1).
      stmts.push(
        buildEventInsertStmt(db, {
          id: newEventId,
          schemaVersion: 1,
          projectId: cell.project_id,
          fileId: cell.file_id,
          cellId: cell.cell_id,
          parentId: cell.current_event_id,
          kind: restoreKind,
          author: callerUsername,
          payloadJson: newPayload,
          clientTs: now,
          serverTs: now,
        }),
      )

      // Claim the chain slot this commit contends — the slot's parent_key is
      // the head the CAS below targets (never null: cells.event_id is NOT
      // NULL), matching parentKeyOf(parentId) on the live path.
      stmts.push(
        buildChainClaimStmt(
          db,
          {
            projectId: cell.project_id,
            fileId: cell.file_id,
            cellId: cell.cell_id,
            parentKey: cell.current_event_id,
          },
          newEventId,
        ),
      )

      // Update cells projection only if event_id still matches current head
      // (no concurrent edit landed between our SELECT and this UPDATE) AND
      // this event holds the chain claim (no racing live commit took the
      // slot). `value` is the RAW snapshot text — exactly what a rebuild
      // replay of this same commit event writes (event-projection.ts), so
      // live == rebuild holds for the value column too.
      stmts.push(
        db.prepare(`
          UPDATE cells
          SET value = ?, event_id = ?, last_editor = ?, last_edit_at = ?
          WHERE project_id = ? AND file_id = ? AND cell_id = ?
            AND event_id = ?
            AND EXISTS (SELECT 1 FROM chain_claims WHERE project_id = ? AND file_id = ? AND cell_id = ? AND parent_key = ? AND event_id = ?)
        `).bind(
          snapValue,
          newEventId,
          callerUsername,
          now,
          cell.project_id,
          cell.file_id,
          cell.cell_id,
          cell.current_event_id,
          cell.project_id,
          cell.file_id,
          cell.cell_id,
          cell.current_event_id,
          newEventId,
        ),
      )
    }

    // Commit in CHUNK-sized batches (one transaction each). Slices step in
    // STMTS_PER_CELL multiples so a cell's triplet is never split across
    // transactions. restored/skippedConcurrent are derived from the CAS
    // row-counts — the pre-transaction SELECT cannot know whether a
    // concurrent commit wins the race before these batches run (audit B6:
    // the old counters were computed before the transaction and were wrong
    // under exactly that race).
    let restored = 0
    let skippedConcurrent = 0
    for (let i = 0; i < stmts.length; i += CHUNK * STMTS_PER_CELL) {
      const results = await db.batch(stmts.slice(i, i + CHUNK * STMTS_PER_CELL))
      // The CAS is the last statement of each triplet.
      for (let j = STMTS_PER_CELL - 1; j < results.length; j += STMTS_PER_CELL) {
        if (results[j].meta.changes > 0) restored++
        else skippedConcurrent++
      }
    }

    return Response.json({
      restored,
      skippedIdentical,
      skippedConcurrent,
      message: restored > 0
        ? `Restored ${restored} cells.`
        : skippedConcurrent > 0
          ? `No cells restored — ${skippedConcurrent} changed concurrently; re-run restore if still wanted.`
          : "No changes — snapshot matches current state.",
    })
  }

  // ── View / Delete one snapshot ─────────────────────────────────────────
  const viewDeleteMatch = path.match(VIEW_DELETE_RE)
  if (viewDeleteMatch) {
    const projectId = decodeURIComponent(viewDeleteMatch[1])
    const snapshotId = decodeURIComponent(viewDeleteMatch[2])

    const auth = await verifyProject(request, projectId, env.SYNC_SECRET_KEY)
    if (!auth.ok) return new Response(auth.reason, { status: auth.status })

    if (request.method === "GET") {
      if (auth.claims.role < ROLE.VIEWER) {
        return new Response("viewer role required", { status: 403 })
      }
      const row = await db
        .prepare("SELECT id, project_id, name, description, created_by, snapshot_ts, created_at, deleted_at FROM snapshots WHERE id = ? AND project_id = ? AND deleted_at IS NULL LIMIT 1")
        .bind(snapshotId, projectId)
        .first<SnapshotRow>()
      if (!row) return new Response("snapshot not found", { status: 404 })
      return Response.json({ snapshot: toOut(row) })
    }

    if (request.method === "DELETE") {
      if (auth.claims.role < ROLE.MAINTAINER) {
        return new Response("delete requires maintainer role", { status: 403 })
      }
      await db
        .prepare("UPDATE snapshots SET deleted_at = NOW() WHERE id = ? AND project_id = ? AND deleted_at IS NULL")
        .bind(snapshotId, projectId)
        .run()
      return Response.json({ ok: true })
    }

    return new Response("method not allowed", { status: 405 })
  }

  // ── List / Create ────────────────────────────────────────────────────────
  const listCreateMatch = path.match(LIST_CREATE_RE)
  if (listCreateMatch) {
    const projectId = decodeURIComponent(listCreateMatch[1])

    const auth = await verifyProject(request, projectId, env.SYNC_SECRET_KEY)
    if (!auth.ok) return new Response(auth.reason, { status: auth.status })

    if (request.method === "GET") {
      if (auth.claims.role < ROLE.VIEWER) {
        return new Response("viewer role required", { status: 403 })
      }
      const rows = await db
        .prepare("SELECT id, project_id, name, description, created_by, snapshot_ts, created_at, deleted_at FROM snapshots WHERE project_id = ? AND deleted_at IS NULL ORDER BY snapshot_ts DESC")
        .bind(projectId)
        .all<SnapshotRow>()
      return Response.json({ snapshots: rows.results.map(toOut) })
    }

    if (request.method === "POST") {
      if (auth.claims.role < ROLE.MAINTAINER) {
        return new Response("create requires maintainer role", { status: 403 })
      }
      let body: unknown
      try { body = await request.json() } catch { return new Response("invalid JSON", { status: 400 }) }
      const b = body as Record<string, unknown>
      const name = typeof b.name === "string" ? b.name.trim() : ""
      if (!name) return new Response("name is required", { status: 400 })
      const description = typeof b.description === "string" ? b.description.trim() || null : null

      const id = randomId()
      const snapshotTs = Date.now()
      const callerUsername = auth.claims.username ?? `user:${auth.claims.userId}`

      await db
        .prepare("INSERT INTO snapshots (id, project_id, name, description, created_by, snapshot_ts) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, projectId, name, description, callerUsername, snapshotTs)
        .run()

      const row = await db
        .prepare("SELECT id, project_id, name, description, created_by, snapshot_ts, created_at, deleted_at FROM snapshots WHERE id = ? LIMIT 1")
        .bind(id)
        .first<SnapshotRow>()

      return Response.json({ snapshot: toOut(row!) }, { status: 201 })
    }

    return new Response("method not allowed", { status: 405 })
  }

  return null
}
