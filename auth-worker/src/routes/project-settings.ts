// Project settings routes — versioned JSON blob with optimistic-concurrency
// control (Aquilla spec 03-data-model.md §"Project Settings"). Mounted at
// /api/v2/projects in src/index.ts; sub-paths:
//
//   GET  /:projectId/settings        any project member
//   PUT  /:projectId/settings        maintainer (600)+ per AD-6
//
// The PUT requires `ifMatchVersion` (query string or header). On mismatch
// the response is 409 with the current row attached so the client can show
// "settings changed elsewhere — refresh and reapply." On match we run a
// single atomic UPDATE that re-checks the version inside the WHERE clause
// — meta.changes == 0 means a concurrent writer landed first and we 409
// with the now-stored row.
//
// Settings keys (all optional per spec): sourceLanguage, targetLanguage,
// systemPrompt, rules, rulePenalties, healthSettings, validationCount,
// validationCountAudio. We don't enforce the key set here — the server is
// a dumb store, the client owns the shape. The spec note about
// `targetLanguage` left unset identifying a source-only project (AD-9) is
// purely a downstream interpretation.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { resolveProjectRole } from "../services/project-permissions"

const projectSettings = new Hono<AuthHonoEnv>()

// Minimum role allowed to write settings — `maintainer` per the spec
// (project-configuration stories: name-and-configure-project,
// customize-ai-settings, monitor-project-health, validate-translation).
const SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER

interface ProjectSettingsRow {
  project_id: string
  settings: string
  version: number
  updated_at: string | null
  updated_by: number | null
}

interface ProjectSettingsResponse {
  projectId: string
  settings: Record<string, unknown>
  version: number
  updatedAt: string | null
  updatedBy: number | null
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
    settings,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

async function loadSettings(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
): Promise<ProjectSettingsResponse> {
  const row = await env.AQUILLA_DB.prepare(
    `SELECT project_id, settings, version, updated_at, updated_by
       FROM project_settings
      WHERE project_id = ?`,
  )
    .bind(projectId)
    .first<ProjectSettingsRow>()

  if (row) return rowToResponse(row)

  // No row yet — treat as empty defaults at version 0. We don't auto-create
  // the row on read; first PUT does the upsert.
  return {
    projectId,
    settings: {},
    version: 0,
    updatedAt: null,
    updatedBy: null,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects/:projectId/settings
// ──────────────────────────────────────────────────────────────────────────

projectSettings.get("/:projectId/settings", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)

  const response = await loadSettings(c.env, projectId)
  return c.json(response)
})

// ──────────────────────────────────────────────────────────────────────────
// PUT /api/v2/projects/:projectId/settings
//
// Body shape:
//   { settings: object, ifMatchVersion?: number }
//
// `ifMatchVersion` may also be supplied via:
//   - query string ?ifMatchVersion=N
//   - header `If-Match-Version: N`
//
// The version-match check is server-authoritative: even if a client sends
// no version, we still require one — there's no "force write" path. The
// 409 response includes the current stored row so the client can rebase.
// ──────────────────────────────────────────────────────────────────────────

const updateSettingsSchema = z.object({
  settings: z.record(z.string(), z.unknown()),
  ifMatchVersion: z.number().int().nonnegative().optional(),
})

function parseIntOrNull(s: string | undefined): number | null {
  if (s == null) return null
  const n = Number.parseInt(s, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

projectSettings.put(
  "/:projectId/settings",
  authMiddleware,
  zValidator("json", updateSettingsSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const body = c.req.valid("json")

    const role = await resolveProjectRole(c.env, user, projectId)
    if (!role) return c.json({ error: "no access to project" }, 403)
    if (role.level < SETTINGS_WRITE_MIN_ROLE) {
      return c.json(
        { error: `role >= maintainer (${SETTINGS_WRITE_MIN_ROLE}) required` },
        403,
      )
    }

    const queryVersion = parseIntOrNull(c.req.query("ifMatchVersion"))
    const headerVersion = parseIntOrNull(c.req.header("If-Match-Version"))
    const ifMatchVersion =
      body.ifMatchVersion ?? queryVersion ?? headerVersion

    if (ifMatchVersion == null) {
      return c.json(
        {
          error:
            "ifMatchVersion required (body, query, or If-Match-Version header)",
        },
        400,
      )
    }

    const current = await loadSettings(c.env, projectId)

    if (ifMatchVersion !== current.version) {
      return c.json(
        {
          error: "version mismatch",
          current,
        },
        409,
      )
    }

    const newSettingsJson = JSON.stringify(body.settings)
    const newVersion = current.version + 1

    // No existing row yet — INSERT. Otherwise UPDATE with a version guard
    // so a racing writer can't sneak past us.
    if (current.updatedAt == null) {
      try {
        await c.env.AQUILLA_DB.prepare(
          `INSERT INTO project_settings
             (project_id, settings, version, updated_by)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(projectId, newSettingsJson, newVersion, user.id)
          .run()
      } catch (err) {
        // Race: another request inserted between our load and insert.
        // Re-read and 409.
        const fresh = await loadSettings(c.env, projectId)
        if (fresh.version !== newVersion) {
          return c.json({ error: "version mismatch", current: fresh }, 409)
        }
        const message = err instanceof Error ? err.message : String(err)
        console.error("project_settings insert failed:", err)
        return c.json({ error: `write failed: ${message}` }, 500)
      }
    } else {
      const result = await c.env.AQUILLA_DB.prepare(
        `UPDATE project_settings
            SET settings   = ?,
                version    = version + 1,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = ?
          WHERE project_id = ? AND version = ?`,
      )
        .bind(newSettingsJson, user.id, projectId, ifMatchVersion)
        .run()

      const changes = result.meta?.changes
      if (typeof changes === "number" && changes === 0) {
        const fresh = await loadSettings(c.env, projectId)
        return c.json({ error: "version mismatch", current: fresh }, 409)
      }
    }

    const fresh = await loadSettings(c.env, projectId)
    return c.json(fresh)
  },
)

export default projectSettings
