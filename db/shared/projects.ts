// Shared project row-write logic for the Agent API v1.1 (spec
// 2026-07-17-agent-api-v1.1-design.md §2 "Shared module"). Lives in db/shared/
// so both auth-worker (its internal REST routes) and sync-worker (the
// receipt-only `CreateProject` / `UpdateProjectSettings` external commands)
// apply the SAME row writes with no forked logic.
//
// Scope of this module is deliberately narrow: it owns the DB writes only.
//   - Identity + authorization (org-role checks, project-role resolution) stay
//     in the caller — auth-worker resolves them via its Env-bound services
//     (getEffectiveOrgRole, getOrCreateUserOrg, resolveProjectRole); the
//     external command layer resolves them via db/shared/project-roles.ts.
//   - The best-effort sync-worker settings-change notification is transport,
//     not domain logic, and stays in the auth-worker route.
//
// Takes the bare `AquillaDb` handle (db/shim/postgres.ts) so it is callable from
// either worker — the same handle both inject as `env.AQUILLA_PG`.

import type { AquillaDb } from "../shim/postgres"

// ──────────────────────────────────────────────────────────────────────────
// Create project
// ──────────────────────────────────────────────────────────────────────────

export interface CreateProjectInput {
  /** Client-chosen project id (also the R2 / event-log partition key). */
  projectId: string
  name: string
  /** Resolved org id, or null for an org-less (personal) project. */
  orgId: number | null
  /** Creator's user id (numeric, or its string form). */
  createdBy: number | string
  /**
   * When true, also INSERT a `project_members` row at owner level (700) for the
   * creator.
   *
   * The auth-worker HTTP route leaves this false: a project's creator already
   * resolves to 700 via the resolver's implicit "creator" path
   * (created_by = user), so writing an explicit override row would flip that
   * attribution from source "creator" to source "override" — a behavior change
   * the internal route must not make. The sync-worker `CreateProject` command
   * (spec §2), whose receipt-only apply step confers the creator role through
   * this row rather than a live resolver, passes true.
   */
  writeCreatorMembership?: boolean
}

/**
 * Insert a project row (idempotent via `ON CONFLICT(id) DO NOTHING`) and,
 * optionally, the creator's owner-level membership row. Returns whether the
 * project row was newly inserted (false on an id collision — the caller decides
 * whether that is a conflict or a benign retry).
 *
 * Throws on any DB error; the caller owns the error → HTTP-status mapping (the
 * auth-worker route wraps this in try/catch and returns 500 unchanged).
 */
export async function createProjectShared(
  db: AquillaDb,
  input: CreateProjectInput,
): Promise<{ inserted: boolean }> {
  const projectStmt = db
    .prepare(
      `INSERT INTO projects (id, name, org_id, created_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(input.projectId, input.name, input.orgId, input.createdBy)

  if (input.writeCreatorMembership) {
    // Atomic with the project insert so a caller relying on the membership row
    // for its role never observes a project without its creator's grant.
    const membershipStmt = db
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
         VALUES (?, ?, 700, ?)
         ON CONFLICT(project_id, user_id) DO NOTHING`,
      )
      .bind(input.projectId, input.createdBy, input.createdBy)
    const [projectResult] = await db.batch([projectStmt, membershipStmt])
    return { inserted: (projectResult.meta?.changes ?? 0) > 0 }
  }

  const result = await projectStmt.run()
  return { inserted: (result.meta?.changes ?? 0) > 0 }
}

// ──────────────────────────────────────────────────────────────────────────
// Project settings — versioned JSON blob with optimistic-concurrency control
// (ported verbatim from auth-worker/src/routes/project-settings.ts so the two
// callers share one implementation).
// ──────────────────────────────────────────────────────────────────────────

interface ProjectSettingsRow {
  project_id: string
  settings: string
  version: number
  updated_at: string | null
  updated_by: number | null
}

export interface ProjectSettingsResponse {
  projectId: string
  settings: Record<string, unknown>
  version: number
  updatedAt: string | null
  updatedBy: number | null
}

export function normalizeSettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...settings }
  if (next.decaySettings == null && next.healthSettings != null) {
    next.decaySettings = next.healthSettings
  }
  // Backward-compatible read alias while the workspace health UI still uses
  // healthSettings. New writers should prefer decaySettings.
  if (next.healthSettings == null && next.decaySettings != null) {
    next.healthSettings = next.decaySettings
  }
  // Validation histograms are intentionally capped at 15+. Persist the same
  // bounded value every reader uses so old/hand-written settings cannot make
  // the file rollup disagree with the detailed progress endpoint.
  if (next.validationCount != null) {
    next.validationCount = validationThreshold(next)
  }
  return next
}

function validationThreshold(settings: Record<string, unknown>): number {
  const value = Math.floor(Number(settings.validationCount))
  return Number.isFinite(value) ? Math.min(15, Math.max(1, value)) : 1
}

function validationProjectionStmts(
  db: AquillaDb,
  projectId: string,
  threshold: number,
  newVersion: number,
  newSettingsJson: string,
) {
  // Both statements are guarded by the settings row written earlier in the
  // same batch. If the optimistic UPDATE matched zero rows, these are no-ops;
  // the caller then returns 409 without any projection changes.
  const guard = `EXISTS (
    SELECT 1 FROM project_settings
     WHERE project_id = ? AND version = ? AND settings = ?
  )`
  return [
    db.prepare(
      // AQU-538: validations are per target-language lane, so each target
      // row's validated flag counts only its own lane's validators
      // (v.target_lang = c.target_lang). N=1 (all rows '') is byte-identical.
      `UPDATE cells c
          SET validated = CASE WHEN (
            SELECT COUNT(*) FROM cell_validators v
             WHERE v.project_id = c.project_id
               AND v.file_id = c.file_id
               AND v.cell_id = c.cell_id
               AND v.target_lang = c.target_lang
               AND v.event_id = c.event_id
          ) >= ? THEN 1 ELSE 0 END
        WHERE c.project_id = ? AND c.side = 'target' AND ${guard}`,
    ).bind(threshold, projectId, projectId, newVersion, newSettingsJson),
    db.prepare(
      `UPDATE files f
          SET approved_count = (
            SELECT COUNT(*) FROM cells c
             WHERE c.project_id = f.project_id
               AND c.file_id = f.id
               AND c.side = 'target'
               AND c.validated = 1
          )
        WHERE f.project_id = ? AND ${guard}`,
    ).bind(projectId, projectId, newVersion, newSettingsJson),
  ]
}

function rowToResponse(row: ProjectSettingsRow): ProjectSettingsResponse {
  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.settings)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    }
  } catch {
    // Stored value is non-JSON — treat as empty rather than 500ing the
    // read path. Clients can overwrite via PUT to repair.
    settings = {}
  }
  return {
    projectId: row.project_id,
    settings: normalizeSettings(settings),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

/**
 * Read the current settings for a project. Returns empty defaults at version 0
 * when no row exists yet — the row is created lazily by the first write.
 */
export async function loadProjectSettings(
  db: AquillaDb,
  projectId: string,
): Promise<ProjectSettingsResponse> {
  const row = await db
    .prepare(
      `SELECT project_id, settings, version, updated_at, updated_by
         FROM project_settings
        WHERE project_id = ?`,
    )
    .bind(projectId)
    .first<ProjectSettingsRow>()

  if (row) return rowToResponse(row)

  // No row yet — treat as empty defaults at version 0. We don't auto-create
  // the row on read; first write does the upsert.
  return {
    projectId,
    settings: {},
    version: 0,
    updatedAt: null,
    updatedBy: null,
  }
}

export interface UpdateProjectSettingsInput {
  projectId: string
  settings: Record<string, unknown>
  /** Optimistic-concurrency guard — must equal the currently-stored version. */
  ifMatchVersion: number
  /** Writer's user id (numeric, or its string form). */
  updatedBy: number | string
}

/**
 * Outcome of a settings write, discriminated so the caller maps each case to
 * its own HTTP status while this module stays transport-agnostic:
 *   - `ok`       → the write landed; `settings` is the freshly-stored row.
 *   - `conflict` → version drift (pre-check or a racing writer); `current` is
 *                  the now-stored row for the client to rebase on.
 *   - `error`    → the INSERT or version-guarded UPDATE failed for a non-conflict
 *                  reason; `message` is the DB error text.
 *
 * Both write paths disambiguate a losing race (→ `conflict`) from a real DB
 * failure (→ `error`); neither throws an uncaught exception. The caller maps
 * `error` to its own 500, matching the internal route's original behavior.
 */
export type UpdateProjectSettingsResult =
  | { status: "ok"; settings: ProjectSettingsResponse }
  | { status: "conflict"; current: ProjectSettingsResponse }
  | { status: "error"; message: string }

/**
 * Apply a version-guarded settings write. Encapsulates: version pre-check,
 * normalization, first-write INSERT vs `version = version + 1` UPDATE,
 * validation-threshold change detection, and the projection fan-out that
 * re-derives `cells.validated` / `files.approved_count` when the threshold
 * moves. The projection statements are batched atomically with the settings
 * write and self-guard on the written row, so a lost UPDATE race leaves the
 * projection untouched.
 */
export async function updateProjectSettingsShared(
  db: AquillaDb,
  input: UpdateProjectSettingsInput,
): Promise<UpdateProjectSettingsResult> {
  const current = await loadProjectSettings(db, input.projectId)

  if (input.ifMatchVersion !== current.version) {
    return { status: "conflict", current }
  }

  const normalizedSettings = normalizeSettings(input.settings)
  const newSettingsJson = JSON.stringify(normalizedSettings)
  const newVersion = current.version + 1
  const oldThreshold = validationThreshold(current.settings)
  const newThreshold = validationThreshold(normalizedSettings)
  const thresholdChanged = oldThreshold !== newThreshold

  // No existing row yet — INSERT. Otherwise UPDATE with a version guard so a
  // racing writer can't sneak past us.
  if (current.updatedAt == null) {
    try {
      const stmts = [
        db.prepare(
          `INSERT INTO project_settings
             (project_id, settings, version, updated_by)
           VALUES (?, ?, ?, ?)`,
        ).bind(input.projectId, newSettingsJson, newVersion, input.updatedBy),
      ]
      if (thresholdChanged) {
        stmts.push(...validationProjectionStmts(
          db, input.projectId, newThreshold, newVersion, newSettingsJson,
        ))
      }
      await db.batch(stmts)
    } catch (err) {
      // Race: another request inserted between our load and insert. Re-read and
      // return conflict only if another writer actually won. A projection /
      // database failure must remain an error, not masquerade as a conflict.
      const fresh = await loadProjectSettings(db, input.projectId)
      if (fresh.version !== current.version) {
        return { status: "conflict", current: fresh }
      }
      const message = err instanceof Error ? err.message : String(err)
      console.error("project_settings insert failed:", err)
      return { status: "error", message }
    }
  } else {
    const stmts = [
      db.prepare(
        `UPDATE project_settings
            SET settings   = ?,
                version    = version + 1,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = ?
          WHERE project_id = ? AND version = ?
          RETURNING version`,
      ).bind(newSettingsJson, input.updatedBy, input.projectId, input.ifMatchVersion),
    ]
    if (thresholdChanged) {
      stmts.push(...validationProjectionStmts(
        db, input.projectId, newThreshold, newVersion, newSettingsJson,
      ))
    }
    // H3: catch DB errors on the version-guarded UPDATE (e.g. a projection
    // statement failing) and return the discriminated `error` result rather than
    // letting the exception propagate uncaught. The caller (auth-worker route /
    // sync-worker commit) maps `error` to its own 500 — mapping unchanged, but a
    // thrown exception no longer escapes this module. A genuine losing race still
    // returns `conflict` (0-row guard below); only real failures are `error`.
    let result: Awaited<ReturnType<typeof db.batch>>[number]
    try {
      ;[result] = await db.batch(stmts)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("project_settings update failed:", err)
      return { status: "error", message }
    }

    const changes = result.meta?.changes
    if ((typeof changes === "number" && changes === 0) || result.results.length === 0) {
      const fresh = await loadProjectSettings(db, input.projectId)
      return { status: "conflict", current: fresh }
    }
  }

  const fresh = await loadProjectSettings(db, input.projectId)
  return { status: "ok", settings: fresh }
}
