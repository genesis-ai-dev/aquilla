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

import type { AquillaDb, AquillaStatement } from "../shim/postgres"
import { isPrimaryRegistryLane } from "../../src/lib/lanes/registry-lanes"
import {
  askedLanesFromSpecs,
  ensureProjectLaneStmts,
  listProjectLanes,
  retryingLaneIdCollision,
  type AskedLane,
  type ExternalLaneSpec,
  type ProjectLaneRecord,
} from "./lanes"

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
  /**
   * AQU-1594: the language pair becomes lane rows in the same batch as the
   * project. It is NOT written into `project_settings` — new projects have no
   * project-level language keys. Omit both and the project still gets its
   * source lane (every project has one) and no target lane.
   *
   * The first target lane's `legacy_tag` is the language string, not `''`.
   */
  settingsSeed?: { sourceLanguage?: string; targetLanguage?: string }
  /**
   * Target lanes beyond the single `settingsSeed.targetLanguage`, each with
   * the language the user typed and an optional display name. Same batch.
   */
  targetLanes?: ReadonlyArray<{ language: string; name?: string | null }>
  /**
   * AQU-1615: explicit lanes from the external API (role, language, optional
   * name, optional code). When set, these are the lanes — `settingsSeed` and
   * `targetLanes` are not also applied, and no project-level language key is
   * written. The app create path leaves this unset.
   */
  lanes?: readonly ExternalLaneSpec[]
}

/**
 * Insert a project row (idempotent via `ON CONFLICT(id) DO NOTHING`) and,
 * optionally, the creator's owner-level membership row. Returns whether the
 * project row was newly inserted (false on an id collision — the caller decides
 * whether that is a conflict or a benign retry).
 *
 * Throws on any DB error; the caller owns the error → HTTP-status mapping (the
 * auth-worker route wraps this in try/catch and returns 500 unchanged).
 *
 * AQU-1594: the same batch writes the source lane and each requested target
 * lane. No project-level language keys are written.
 */
export async function createProjectShared(
  db: AquillaDb,
  input: CreateProjectInput,
): Promise<{ inserted: boolean }> {
  // Lane ids are minted inside the attempt. A uq_lanes_id collision rolls the
  // whole batch back, so repeating it does not insert the project twice.
  return retryingLaneIdCollision(async () => {
    const projectStmt = db
      .prepare(
        `INSERT INTO projects (id, name, org_id, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .bind(input.projectId, input.name, input.orgId, input.createdBy)

    // The project insert stays FIRST in the batch — `inserted` is read off index 0.
    const stmts: AquillaStatement[] = [projectStmt]

    if (input.writeCreatorMembership) {
      // Atomic with the project insert so a caller relying on the membership row
      // for its role never observes a project without its creator's grant.
      stmts.push(
        db
          .prepare(
            `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
             VALUES (?, ?, 700, ?)
             ON CONFLICT(project_id, user_id) DO NOTHING`,
          )
          .bind(input.projectId, input.createdBy, input.createdBy),
      )
    }

    const lanes = lanesForNewProject(input)
    stmts.push(
      ...ensureProjectLaneStmts(db, input.projectId, { lanes }),
    )

    const [projectResult] = await db.batch(stmts)
    return { inserted: (projectResult.meta?.changes ?? 0) > 0 }
  })
}

/** Source lane plus each requested target. The first target's tag is its language. */
function lanesForNewProject(input: CreateProjectInput): AskedLane[] {
  if (input.lanes) {
    const asked = askedLanesFromSpecs(input.lanes)
    if (!asked.ok) throw new Error(asked.message)
    // A project always has a source lane. An explicit list that names only
    // targets still gets one, with no language, the same as an empty seed.
    if (!asked.lanes.some((lane) => lane.role === "source")) {
      return [{ role: "source", language: "" }, ...asked.lanes]
    }
    return asked.lanes
  }
  const source = typeof input.settingsSeed?.sourceLanguage === "string"
    ? input.settingsSeed.sourceLanguage.trim()
    : ""
  const lanes: AskedLane[] = [{ role: "source", language: source }]
  const addTarget = (language: string, name?: string | null) => {
    const trimmed = language.trim()
    if (!trimmed) return
    if (lanes.some((lane) => lane.role === "target" && isPrimaryRegistryLane(trimmed, lane.language))) return
    lanes.push({
      role: "target",
      language: trimmed,
      name: name?.trim() ? name.trim() : null,
      legacyTag: trimmed,
    })
  }
  if (typeof input.settingsSeed?.targetLanguage === "string") {
    addTarget(input.settingsSeed.targetLanguage)
  }
  for (const target of input.targetLanes ?? []) addTarget(target.language, target.name)
  return lanes
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
  /** Lane rows for this project. Absent on older writers that only return the settings blob. */
  lanes?: ProjectLaneRecord[]
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
  // AQU-490: the audio threshold gets the same treatment, and needs it more.
  // It has been a writable settings key since AQU-508 with nothing clamping
  // it, so a hand-written or old client value reaches the blob verbatim — and
  // the histogram it is compared against only has buckets up to 15, so an
  // unclamped 999 would make every recording permanently unvalidated with no
  // way to see why.
  if (next.validationCountAudio != null) {
    next.validationCountAudio = clampThreshold(next.validationCountAudio)
  }
  return next
}

function clampThreshold(raw: unknown): number {
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) ? Math.min(15, Math.max(1, value)) : 1
}

function validationThreshold(settings: Record<string, unknown>): number {
  return clampThreshold(settings.validationCount)
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

  if (row) {
    const response = rowToResponse(row)
    response.lanes = await listProjectLanes(db, projectId)
    return response
  }

  // No row yet — treat as empty defaults at version 0. We don't auto-create
  // the row on read; first write does the upsert.
  return {
    projectId,
    settings: {},
    version: 0,
    updatedAt: null,
    updatedBy: null,
    lanes: await listProjectLanes(db, projectId),
  }
}

export interface UpdateProjectSettingsInput {
  projectId: string
  settings: Record<string, unknown>
  /** Optimistic-concurrency guard — must equal the currently-stored version. */
  ifMatchVersion: number
  /** Writer's user id (numeric, or its string form). */
  updatedBy: number | string
  /**
   * AQU-1075: this write is the link copying a field into a downstream.
   * Skip the inherit prepare (it would detach the field being copied) and
   * skip a further cascade from this write — the caller walks the chain.
   */
  inheritPropagation?: boolean
  /** Originals for knowledge documents copied with a newly enabled field. */
  blobs?: {
    get(key: string): Promise<{
      arrayBuffer(): Promise<ArrayBuffer>
      httpMetadata?: { contentType?: string }
    } | null>
    put(
      key: string,
      value: ArrayBuffer | Uint8Array,
      options?: { httpMetadata?: { contentType?: string } },
    ): Promise<unknown>
    delete(key: string): Promise<unknown>
  } | null
  r2KeyPrefix?: string
  /**
   * AQU-1615: the in-app settings write still registers lanes from the blob
   * (AQU-1585). An external settings write passes false so a blob that still
   * holds sourceLanguage / targetLanguage / targetLanes / archivedLanes cannot
   * mint a lane. Default true.
   */
  registerLanes?: boolean
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
  | {
      status: "ok"
      settings: ProjectSettingsResponse
      /** Live downstreams this save copied into, with the version now stored. */
      propagated?: { projectId: string; version: number }[]
    }
  | { status: "conflict"; current: ProjectSettingsResponse }
  | { status: "error"; message: string }

export interface PatchProjectSettingsInput {
  projectId: string
  /** Top-level settings keys to replace; each op's value replaces that key
   *  wholesale (no deep merge). JSON cannot express undefined, so ops cannot
   *  delete a key — write null instead. */
  ops: { key: string; value: unknown }[]
  /** Optimistic-concurrency guard — must equal the currently-stored version. */
  ifMatchVersion: number
  /** Writer's user id (numeric, or its string form). */
  updatedBy: number | string
  /** See {@link UpdateProjectSettingsInput.registerLanes}. Default true. */
  registerLanes?: boolean
}

/**
 * Field-scoped variant of updateProjectSettingsShared (AQU-926 PatchSettings):
 * load the live blob, replace only the named top-level keys, and delegate the
 * versioned write to updateProjectSettingsShared — so normalization, the
 * version guard, and the validation-threshold re-projection are shared, not
 * forked. Race-safe by composition: a writer landing between our load and the
 * delegated write moves the version, and the delegate's own `ifMatchVersion`
 * pre-check / guarded UPDATE returns `conflict`.
 */
export async function patchProjectSettingsShared(
  db: AquillaDb,
  input: PatchProjectSettingsInput,
): Promise<UpdateProjectSettingsResult> {
  const current = await loadProjectSettings(db, input.projectId)
  if (input.ifMatchVersion !== current.version) {
    return { status: "conflict", current }
  }
  const merged: Record<string, unknown> = { ...current.settings }
  for (const op of input.ops) merged[op.key] = op.value
  return updateProjectSettingsShared(db, {
    projectId: input.projectId,
    settings: merged,
    ifMatchVersion: input.ifMatchVersion,
    updatedBy: input.updatedBy,
    registerLanes: input.registerLanes,
  })
}

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

  // AQU-1075: a normal save keeps the link's choice, detaches a field the
  // maintainer just edited, and pulls a field they just turned on. A copy
  // the link itself is writing skips this — otherwise the copy would detach
  // the field it is delivering. A failure here must not refuse the save.
  let settingsToStore = input.settings
  let pullKnowledge = false
  if (!input.inheritPropagation) {
    try {
      const inherited = await import("./inherited-settings")
      const prepared = await inherited.prepareInheritedSettingsWrite(
        db,
        input.projectId,
        current.settings,
        input.settings,
      )
      settingsToStore = prepared.settings
      pullKnowledge = prepared.pullKnowledge
    } catch (err) {
      console.error("[inherited-settings] prepare failed:", err)
    }
  }

  const normalizedSettings = normalizeSettings(settingsToStore)
  const newSettingsJson = JSON.stringify(normalizedSettings)
  const newVersion = current.version + 1
  const oldThreshold = validationThreshold(current.settings)
  const newThreshold = validationThreshold(normalizedSettings)
  const thresholdChanged = oldThreshold !== newThreshold
  // Lane ids are minted inside the attempt. The settings write is in the same
  // transaction, so a uq_lanes_id collision rolls the version change back too.
  // Passing the existing lane rows stops a stale targetLanes entry minting a
  // second lane for one that already exists (AQU-1585). The in-app path still
  // registers lanes from the blob. External settings writes pass
  // registerLanes: false (AQU-1615) so they never mint a lane.
  const registerLanes = input.registerLanes !== false
  const batchWithLanes = (head: AquillaStatement[]) =>
    retryingLaneIdCollision(() =>
      db.batch([
        ...head,
        ...(registerLanes
          ? ensureProjectLaneStmts(db, input.projectId, {
              settings: normalizedSettings,
              existingLanes: current.lanes ?? [],
            })
          : []),
      ]),
    )

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
      await batchWithLanes(stmts)
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
      ;[result] = await batchWithLanes(stmts)
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
  let propagated: { projectId: string; version: number }[] = []
  if (!input.inheritPropagation) {
    try {
      const inherited = await import("./inherited-settings")
      propagated = await inherited.afterInheritedSettingsWrite(db, {
        projectId: input.projectId,
        before: current.settings,
        after: normalizedSettings,
        updatedBy: input.updatedBy,
        pullKnowledge,
        blobs: input.blobs,
        r2KeyPrefix: input.r2KeyPrefix,
      })
    } catch (err) {
      console.error("[inherited-settings] propagate failed:", err)
    }
  }
  const settings = propagated.length > 0 || pullKnowledge
    ? await loadProjectSettings(db, input.projectId)
    : fresh
  return {
    status: "ok",
    settings,
    ...(propagated.length > 0 ? { propagated } : {}),
  }
}
