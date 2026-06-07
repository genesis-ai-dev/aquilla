// Org settings routes — versioned JSON blob mirroring project-settings.ts.
// Mounted at /api/v2/orgs in src/index.ts; sub-paths:
//
//   GET  /:orgId/settings        any org member
//   PUT  /:orgId/settings        org role >= MAINTAINER (600)
//   PATCH /:orgId/settings       compatibility alias
//
// Same optimistic-concurrency design as project-settings: clients send
// `ifMatchVersion` and a mismatch returns 409 with the current row. The
// server-side WHERE version-guard ensures concurrent writers get a 409
// rather than silently overwriting each other.
//
// Settings keys (all optional): rules (TranslationRule[]). Shape is open;
// server is a dumb store.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { getOrgMemberRole } from "../services/org-permissions"

const orgSettings = new Hono<AuthHonoEnv>()

const SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER

interface OrgSettingsRow {
  org_id: number
  settings: string
  version: number
  updated_at: string | null
  updated_by: number | null
}

interface OrgSettingsResponse {
  orgId: number
  settings: Record<string, unknown>
  version: number
  updatedAt: string | null
  updatedBy: number | null
}

function rowToResponse(row: OrgSettingsRow): OrgSettingsResponse {
  let settings: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(row.settings)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    }
  } catch {
    settings = {}
  }
  return {
    orgId: row.org_id,
    settings,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

async function loadSettings(
  env: AuthHonoEnv["Bindings"],
  orgId: number,
): Promise<OrgSettingsResponse> {
  const row = await env.AQUILLA_DB.prepare(
    `SELECT org_id, settings, version, updated_at, updated_by
       FROM org_settings
      WHERE org_id = ?`,
  )
    .bind(orgId)
    .first<OrgSettingsRow>()

  if (row) return rowToResponse(row)

  return {
    orgId,
    settings: {},
    version: 0,
    updatedAt: null,
    updatedBy: null,
  }
}

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/orgs/:orgId/settings
// ──────────────────────────────────────────────────────────────────────────

orgSettings.get("/:orgId/settings", authMiddleware, async (c) => {
  const user = c.get("user")
  const orgId = parseInt(c.req.param("orgId"), 10)
  if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

  const role = await getOrgMemberRole(c.env, orgId, user.id)
  if (role == null) return c.json({ error: "no access to org" }, 403)

  const response = await loadSettings(c.env, orgId)
  return c.json(response)
})

// ──────────────────────────────────────────────────────────────────────────
// PUT/PATCH /api/v2/orgs/:orgId/settings
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

orgSettings.on(
  ["PUT", "PATCH"],
  "/:orgId/settings",
  authMiddleware,
  zValidator("json", updateSettingsSchema),
  async (c) => {
    const user = c.get("user")
    const orgId = parseInt(c.req.param("orgId"), 10)
    if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)
    const body = c.req.valid("json")

    const role = await getOrgMemberRole(c.env, orgId, user.id)
    if (role == null) return c.json({ error: "no access to org" }, 403)
    if (role < SETTINGS_WRITE_MIN_ROLE) {
      return c.json(
        { error: `org role >= maintainer (${SETTINGS_WRITE_MIN_ROLE}) required` },
        403,
      )
    }

    const queryVersion = parseIntOrNull(c.req.query("ifMatchVersion"))
    const headerVersion = parseIntOrNull(c.req.header("If-Match-Version"))
    const ifMatchVersion = body.ifMatchVersion ?? queryVersion ?? headerVersion

    if (ifMatchVersion == null) {
      return c.json(
        { error: "ifMatchVersion required (body, query, or If-Match-Version header)" },
        400,
      )
    }

    const current = await loadSettings(c.env, orgId)

    if (ifMatchVersion !== current.version) {
      return c.json({ error: "version mismatch", current }, 409)
    }

    const newSettingsJson = JSON.stringify(body.settings)
    const newVersion = current.version + 1

    if (current.updatedAt == null) {
      try {
        await c.env.AQUILLA_DB.prepare(
          `INSERT INTO org_settings (org_id, settings, version, updated_by)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(orgId, newSettingsJson, newVersion, user.id)
          .run()
      } catch (err) {
        const fresh = await loadSettings(c.env, orgId)
        if (fresh.version !== newVersion) {
          return c.json({ error: "version mismatch", current: fresh }, 409)
        }
        const message = err instanceof Error ? err.message : String(err)
        console.error("org_settings insert failed:", err)
        return c.json({ error: `write failed: ${message}` }, 500)
      }
    } else {
      const result = await c.env.AQUILLA_DB.prepare(
        `UPDATE org_settings
            SET settings   = ?,
                version    = version + 1,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = ?
          WHERE org_id = ? AND version = ?`,
      )
        .bind(newSettingsJson, user.id, orgId, ifMatchVersion)
        .run()

      const changes = result.meta?.changes
      if (typeof changes === "number" && changes === 0) {
        const fresh = await loadSettings(c.env, orgId)
        return c.json({ error: "version mismatch", current: fresh }, 409)
      }
    }

    const fresh = await loadSettings(c.env, orgId)
    return c.json(fresh)
  },
)

export default orgSettings
