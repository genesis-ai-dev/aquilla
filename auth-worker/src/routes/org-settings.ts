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
// Settings keys (all optional): rules (TranslationRule[]). Shape is open
// EXCEPT for exportMinRole — see EXPORT_FLOOR_WRITE_MIN_ROLE below.
//
// exportMinRole write gate: OWNER (700), not MAINTAINER.
// Rationale: exportMinRole is a permission-policy key that determines who can
// pull project deliverables. Letting maintainers change it would let a
// project-level maintainer lower the org's export security posture without
// owner approval. Only org owners (700) should be able to raise or lower this
// floor. All other settings keys retain the MAINTAINER (600) write gate.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { ROLE } from "../types"
import { getOrgMemberRole } from "../services/org-permissions"

const orgSettings = new Hono<AuthHonoEnv>()

const SETTINGS_WRITE_MIN_ROLE = ROLE.MAINTAINER

/**
 * The exportMinRole key is a permission-policy key — only org owners (700)
 * may set it. This is stricter than the general settings write gate (600).
 * Aligned with the Settings UI copy: "Only owners can change this setting."
 */
const EXPORT_FLOOR_WRITE_MIN_ROLE = ROLE.OWNER

/** Valid role ladder levels that can be set as an exportMinRole floor. */
const VALID_ROLE_LEVELS = new Set(Object.values(ROLE))

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
  const row = await env.AQUILLA_PG.prepare(
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
  const orgId = parseInt(c.req.param("orgId") ?? "", 10)
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
    const orgId = parseInt(c.req.param("orgId") ?? "", 10)
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

    // FRO-253: validate exportMinRole if present in the patch.
    // Must be a known role-ladder value (100–700). Garbage values (e.g. "owner",
    // -1, 9999) are rejected with 400 so misconfiguration is immediately visible
    // to the admin rather than silently coerced to the default.
    const rawExportFloor = body.settings.exportMinRole
    if (rawExportFloor !== undefined) {
      // Gate on CHANGE, not presence: the client patch() is a whole-object
      // read-modify-write, so every maintainer settings write echoes the
      // existing exportMinRole back. An unchanged echo must pass, or setting
      // a floor locks maintainers out of ALL org-settings writes.
      const existing = await loadSettings(c.env, orgId)
      const currentFloor = (existing.settings as Record<string, unknown>).exportMinRole
      const floorChanged = rawExportFloor !== currentFloor
      // exportMinRole CHANGES require OWNER (700) — stricter than the general gate.
      if (floorChanged && role < EXPORT_FLOOR_WRITE_MIN_ROLE) {
        return c.json(
          {
            error: `exportMinRole requires org role >= owner (${EXPORT_FLOOR_WRITE_MIN_ROLE}); only org owners can change the export permission policy`,
          },
          403,
        )
      }
      if (floorChanged && (typeof rawExportFloor !== "number" || !Number.isFinite(rawExportFloor) || !VALID_ROLE_LEVELS.has(rawExportFloor as typeof ROLE[keyof typeof ROLE]))) {
        return c.json(
          {
            error: `exportMinRole must be one of the role ladder values: ${[...VALID_ROLE_LEVELS].sort((a, b) => a - b).join(", ")} (viewer=100, contributor=400, project_lead=500, maintainer=600, owner=700)`,
          },
          400,
        )
      }
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
        await c.env.AQUILLA_PG.prepare(
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
      const result = await c.env.AQUILLA_PG.prepare(
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

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/orgs/:orgId/rule-promotion-requests
// Appends a promotion request to the org settings blob.
// Requires org role >= PROJECT_LEAD (500). Returns 409 on duplicate.
// ──────────────────────────────────────────────────────────────────────────

const PROMOTION_REQUEST_MIN_ROLE = ROLE.PROJECT_LEAD

const promotionRequestSchema = z.object({
  rule: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    severity: z.enum(["major", "minor"]),
    source: z.enum(["algorithmic", "llm", "user"]),
    scope: z.enum(["project", "org"]),
    check: z.record(z.string(), z.unknown()),
    enabled: z.boolean(),
    createdAt: z.string(),
    autofix: z.unknown().optional(),
    sourceProjectId: z.string().optional(),
  }),
  sourceProjectId: z.string(),
})

interface PromotionRequestBlob {
  id: string
  rule: { id: string; [k: string]: unknown }
  sourceProjectId: string
  requestedBy: number
  requestedByName?: string
  requestedAt: string
}

orgSettings.post(
  "/:orgId/rule-promotion-requests",
  authMiddleware,
  zValidator("json", promotionRequestSchema),
  async (c) => {
    const user = c.get("user")
    const orgId = parseInt(c.req.param("orgId") ?? "", 10)
    if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

    const role = await getOrgMemberRole(c.env, orgId, user.id)
    if (role == null) return c.json({ error: "no access to org" }, 403)
    if (role < PROMOTION_REQUEST_MIN_ROLE) {
      return c.json(
        { error: `org role >= project_lead (${PROMOTION_REQUEST_MIN_ROLE}) required` },
        403,
      )
    }

    const { rule, sourceProjectId } = c.req.valid("json")

    const current = await loadSettings(c.env, orgId)
    const existingRequests: PromotionRequestBlob[] =
      (current.settings.promotionRequests as PromotionRequestBlob[] | undefined) ?? []

    // Deduplicate: same rule id + same project = already requested.
    const duplicate = existingRequests.some(
      (r) => r.rule.id === rule.id && r.sourceProjectId === sourceProjectId,
    )
    if (duplicate) {
      return c.json({ error: "promotion request already pending for this rule" }, 409)
    }

    const newRequest: PromotionRequestBlob = {
      id: crypto.randomUUID(),
      rule: rule as PromotionRequestBlob["rule"],
      sourceProjectId,
      requestedBy: user.id,
      requestedByName: user.username,
      requestedAt: new Date().toISOString(),
    }

    const newSettings = {
      ...current.settings,
      promotionRequests: [...existingRequests, newRequest],
    }
    // FRO-253 invariant: this blob write must never alter the export floor.
    if ((newSettings as Record<string, unknown>).exportMinRole !== (current.settings as Record<string, unknown>).exportMinRole) {
      return c.json({ error: "internal: exportMinRole must not change via promotion requests" }, 500)
    }
    const newSettingsJson = JSON.stringify(newSettings)
    const newVersion = current.version + 1

    if (current.updatedAt == null) {
      try {
        await c.env.AQUILLA_PG.prepare(
          `INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (?, ?, ?, ?)`,
        )
          .bind(orgId, newSettingsJson, newVersion, user.id)
          .run()
      } catch {
        return c.json({ error: "concurrent write — please retry" }, 409)
      }
    } else {
      const result = await c.env.AQUILLA_PG.prepare(
        `UPDATE org_settings
            SET settings   = ?,
                version    = version + 1,
                updated_at = CURRENT_TIMESTAMP,
                updated_by = ?
          WHERE org_id = ? AND version = ?`,
      )
        .bind(newSettingsJson, user.id, orgId, current.version)
        .run()

      const changes = result.meta?.changes
      if (typeof changes === "number" && changes === 0) {
        return c.json({ error: "concurrent write — please retry" }, 409)
      }
    }

    return c.json({ ok: true, request: newRequest }, 200)
  },
)

export default orgSettings
