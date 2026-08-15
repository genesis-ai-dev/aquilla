// Platform-operator (site-wide admin) surface — read-only, cross-tenant.
//
// Every route here bypasses the org-scoped 403 guards used elsewhere, so the
// entire router is mounted behind `requirePlatformAdmin` (which itself runs
// after `authMiddleware`). These are deliberately read-only: listing orgs,
// users, projects, a top-line rollup, and the cross-tenant activity feed.
// Credit config endpoints (read + write) are also gated here.
//
// Routes (mounted at /api/v2/admin):
//   GET /me                    — { isPlatformAdmin: true } (only reachable past the gate)
//   GET /admins                — the ADMIN_EMAILS allowlist joined to user accounts
//   GET /overview              — top-line counts (orgs, users, projects, active-7d)
//   GET /orgs                  — every org + owner + member/project counts
//   GET /users                 — every user
//   GET /projects              — every project + org/creator + cell/word rollup
//   GET /activity              — cross-tenant activity_logs feed (?limit, ?since)
//   GET /credits/orgs          — all orgs with day/week credit spend + caps
//   PATCH /credits/org/:orgId  — update per-org credit config (org_settings.credits)

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { parseAdminEmails, requirePlatformAdmin, requireAdminElevation, adminElevationRequired } from "../middleware/platform-admin"
import { resolveCreditConfig, readSpend } from "../lib/credits"
import { loadPlatformSettings, savePlatformSettings } from "../lib/platform-settings"
import { getAllowedModels } from "../lib/ai-budget"
import { aggregateAbResults } from "../lib/model-ab"
import { sendAdminElevationCodeEmail } from "../services/email"
import { DEFAULT_LLM_MODEL_ID } from "../lib/model-defaults"
import {
  ADMIN_ELEVATION_VERIFY_MAX_FAILURES,
  countRecentEvents,
  recordAuthEvent,
} from "../utils/rate-limit"

const admin = new Hono<AuthHonoEnv>()

/**
 * A 6-digit code drawn uniformly from 000000-999999 via the Web Crypto CSPRNG.
 * Rejection-sampled so the modulo doesn't bias low values (2^32 isn't a
 * multiple of 1_000_000): `Math.random()` was used here previously, which is
 * not cryptographically secure and is unsuitable for a security step-up code.
 */
function randomSixDigitCode(): string {
  const RANGE = 1_000_000
  const MAX_UNBIASED = Math.floor(0x1_0000_0000 / RANGE) * RANGE
  const buf = new Uint32Array(1)
  let n: number
  do {
    crypto.getRandomValues(buf)
    n = buf[0]
  } while (n >= MAX_UNBIASED)
  return String(n % RANGE).padStart(6, "0")
}

// auth first (hydrate user), then the platform-admin gate. Order matters:
// the gate reads c.get("user").
admin.use("*", authMiddleware)
admin.use("*", requirePlatformAdmin)

/**
 * GET /api/v2/admin/me — liveness/identity + elevation status for the SPA.
 * Reaching this means the caller passed the allowlist + domain gate; the SPA
 * uses `elevated` to decide whether to show the console or the step-up prompt.
 * Not behind requireAdminElevation (it's how the SPA learns it must elevate).
 */
admin.get("/me", async (c) => {
  const user = c.get("user")
  const hardened = adminElevationRequired(c.env)
  const row = hardened
    ? await c.env.AQUILLA_PG.prepare(
        `SELECT elevated_until FROM admin_elevations WHERE user_id = ? AND elevated_until > now()`,
      )
        .bind(user.id)
        .first<{ elevated_until: string }>()
    : null
  return c.json({
    isPlatformAdmin: true,
    username: user.username,
    email: user.email,
    hardened,
    // When the console isn't hardened, it's open (no step-up needed).
    elevated: hardened ? Boolean(row) : true,
    elevatedUntil: row?.elevated_until ?? null,
  })
})

// ── Step-up elevation (NOT behind requireAdminElevation — they establish it) ──

/**
 * POST /api/v2/admin/elevation/request — email a fresh 6-digit code to the
 * operator's account email. Rate-limited to 5/hour/user. In non-production
 * environments with no EMAIL binding (local/e2e), the code is returned in the
 * body so the dev flow is testable. Gated on ENVIRONMENT, not just binding
 * presence, so a misconfigured/missing EMAIL binding in prod fails closed
 * (no email sent, no code leaked) instead of silently falling back to the dev
 * behavior.
 */
admin.post("/elevation/request", async (c) => {
  const user = c.get("user")

  const recent = await c.env.AQUILLA_PG.prepare(
    `SELECT COUNT(*) AS n FROM admin_elevation_codes
      WHERE user_id = ? AND created_at >= now() - interval '1 hour'`,
  )
    .bind(user.id)
    .first<{ n: number }>()
  if ((recent?.n ?? 0) >= 5) {
    return c.json(
      { error: "rate_limited", message: "Too many codes requested — try again later." },
      429,
    )
  }

  const code = randomSixDigitCode()
  const ttlMin = Number(c.env.ELEVATION_TTL_MINUTES ?? 10)
  const expiresAt = new Date(Date.now() + ttlMin * 60_000).toISOString()
  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO admin_elevation_codes (user_id, code, expires_at) VALUES (?, ?, ?)`,
  )
    .bind(user.id, code, expiresAt)
    .run()

  const sent = await sendAdminElevationCodeEmail(c.env, user.email, code, ttlMin)
  const body: { ok: true; sent: boolean; devCode?: string } = { ok: true, sent }
  if (c.env.ENVIRONMENT !== "production" && !c.env.EMAIL) body.devCode = code // dev only — never in prod, even if EMAIL is misconfigured
  return c.json(body)
})

/**
 * POST /api/v2/admin/elevation/verify — exchange a valid code for a ~6h
 * elevated session. Single-use (all of the user's codes are cleared on
 * success); audited.
 */
const elevationVerifySchema = z.object({ code: z.string().min(4).max(12) })

admin.post("/elevation/verify", zValidator("json", elevationVerifySchema), async (c) => {
  const user = c.get("user")
  const { code } = c.req.valid("json")

  // [Pen test] Auth & session mgmt (2026-07-27): this endpoint had no attempt
  // limiting — a caller already holding a valid (e.g. stolen) non-elevated
  // admin JWT could brute-force the 6-digit code with unlimited guesses
  // inside its ~10-minute window. Scoped per-user identifier, matching the
  // pattern used for POST /auth/token.
  const identifier = `user:${user.id}`
  const recentFailures = await countRecentEvents(
    c.env.AQUILLA_PG,
    "admin_elevation_verify",
    identifier,
    { onlyFailures: true },
  )
  if (recentFailures >= ADMIN_ELEVATION_VERIFY_MAX_FAILURES) {
    return c.json(
      { error: "rate_limited", message: "Too many attempts. Please try again later." },
      429,
    )
  }

  const match = await c.env.AQUILLA_PG.prepare(
    `SELECT id FROM admin_elevation_codes
      WHERE user_id = ? AND code = ? AND expires_at > now()
      ORDER BY id DESC LIMIT 1`,
  )
    .bind(user.id, code)
    .first<{ id: number }>()
  if (!match) {
    await recordAuthEvent(c.env.AQUILLA_PG, "admin_elevation_verify", identifier, false)
    return c.json(
      { error: "invalid_code", message: "That code is invalid or has expired." },
      400,
    )
  }

  // Single-use: clear every outstanding code for this user.
  await c.env.AQUILLA_PG.prepare(`DELETE FROM admin_elevation_codes WHERE user_id = ?`)
    .bind(user.id)
    .run()

  const hours = Number(c.env.ELEVATION_SESSION_HOURS ?? 6)
  const until = new Date(Date.now() + hours * 3_600_000).toISOString()
  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO admin_elevations (user_id, elevated_until, updated_at) VALUES (?, ?, now())
     ON CONFLICT (user_id) DO UPDATE SET elevated_until = EXCLUDED.elevated_until, updated_at = now()`,
  )
    .bind(user.id, until)
    .run()
  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO admin_audit_log (user_id, action, detail) VALUES (?, 'elevation.grant', ?)`,
  )
    .bind(user.id, JSON.stringify({ until }))
    .run()

  return c.json({ elevated: true, elevatedUntil: until })
})

// Everything below requires an active elevated session (no-op when the console
// is not hardened — see requireAdminElevation).
admin.use("*", requireAdminElevation)

/**
 * GET /api/v2/admin/admins — the ADMIN_EMAILS allowlist, joined to user
 * accounts by email. Allowlist entries without a matching users row are still
 * returned (hasAccount: false) so a typo'd or not-yet-registered email in
 * wrangler.toml is visible from the dashboard instead of silently inert.
 */
admin.get("/admins", async (c) => {
  const allowlist = Array.from(parseAdminEmails(c.env)).sort((a, b) =>
    a.localeCompare(b),
  )
  if (allowlist.length === 0) return c.json({ admins: [] })

  const placeholders = allowlist.map(() => "?").join(", ")
  const { results } = await c.env.AQUILLA_PG.prepare(
    `SELECT u.id, u.username, u.email, u.display_name, u.created_at,
            (SELECT MAX(last_active_at) FROM org_members m WHERE m.user_id = u.id) AS last_active_at
       FROM users u
      WHERE LOWER(u.email) IN (${placeholders})`,
  )
    .bind(...allowlist)
    .all<{
      id: number
      username: string
      email: string
      display_name: string | null
      created_at: string
      last_active_at: string | null
    }>()

  const byEmail = new Map(results.map((r) => [r.email.toLowerCase(), r]))
  return c.json({
    admins: allowlist.map((email) => {
      const u = byEmail.get(email)
      return u
        ? {
            email,
            hasAccount: true,
            userId: u.id,
            username: u.username,
            displayName: u.display_name,
            createdAt: u.created_at,
            lastActiveAt: u.last_active_at,
          }
        : { email, hasAccount: false }
    }),
  })
})

/** GET /api/v2/admin/overview — top-line platform rollup. */
admin.get("/overview", async (c) => {
  const db = c.env.AQUILLA_PG
  // One round-trip per scalar; we issue one statement per round-trip, but these are
  // cheap COUNT(*)s. active7d = users with org activity in the last 7 days.
  const [orgs, teams, users, projects, archived, active7d] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM organizations").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM groups").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NOT NULL").first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(DISTINCT user_id) AS n FROM org_members WHERE last_active_at IS NOT NULL AND last_active_at >= now() - interval '7 days'",
      )
      .first<{ n: number }>(),
  ])
  return c.json({
    orgs: orgs?.n ?? 0,
    teams: teams?.n ?? 0,
    users: users?.n ?? 0,
    activeProjects: projects?.n ?? 0,
    archivedProjects: archived?.n ?? 0,
    activeUsers7d: active7d?.n ?? 0,
  })
})

/** GET /api/v2/admin/orgs — every org with owner + member/project counts. */
admin.get("/orgs", async (c) => {
  const { results } = await c.env.AQUILLA_PG.prepare(
    `SELECT o.id, o.name, o.created_at,
            u.username AS owner_username,
            (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS member_count,
            (SELECT COUNT(*) FROM projects p WHERE p.org_id = o.id AND p.archived_at IS NULL) AS project_count
       FROM organizations o
       LEFT JOIN users u ON u.id = o.owner_user_id
      ORDER BY o.created_at DESC`,
  ).all<{
    id: number
    name: string | null
    created_at: string
    owner_username: string | null
    member_count: number
    project_count: number
  }>()
  return c.json({
    orgs: results.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      ownerUsername: r.owner_username,
      memberCount: r.member_count,
      projectCount: r.project_count,
    })),
  })
})

/** GET /api/v2/admin/teams — every group ("team") with org + member/grant counts. */
admin.get("/teams", async (c) => {
  const { results } = await c.env.AQUILLA_PG.prepare(
    `SELECT g.id, g.name, g.created_at, g.org_id,
            o.name AS org_name,
            (SELECT u.username
               FROM group_members gm
               JOIN users u ON u.id = gm.user_id
               JOIN org_members om ON om.org_id = g.org_id AND om.user_id = gm.user_id
              WHERE gm.group_id = g.id AND om.role_level = 500
              ORDER BY LOWER(u.username)
              LIMIT 1) AS project_lead_username,
            ou.username AS owner_username,
            (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
            (SELECT COUNT(*) FROM group_project_grants gp WHERE gp.group_id = g.id) AS project_count
       FROM groups g
       LEFT JOIN organizations o ON o.id = g.org_id
       LEFT JOIN users ou ON ou.id = o.owner_user_id
      ORDER BY o.name, g.name`,
  ).all<{
    id: number
    name: string
    created_at: string
    org_id: number
    org_name: string | null
    project_lead_username: string | null
    owner_username: string | null
    member_count: number
    project_count: number
  }>()
  return c.json({
    teams: results.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      orgId: r.org_id,
      orgName: r.org_name,
      projectLeadUsername: r.project_lead_username,
      ownerUsername: r.owner_username,
      memberCount: r.member_count,
      projectCount: r.project_count,
    })),
  })
})

/** GET /api/v2/admin/users — every user (no password hashes). */
admin.get("/users", async (c) => {
  const { results } = await c.env.AQUILLA_PG.prepare(
    `SELECT u.id, u.username, u.email, u.display_name, u.created_at,
            (SELECT COUNT(*) FROM org_members m WHERE m.user_id = u.id) AS org_count,
            (SELECT MAX(last_active_at) FROM org_members m WHERE m.user_id = u.id) AS last_active_at
       FROM users u
      ORDER BY u.created_at DESC`,
  ).all<{
    id: number
    username: string
    email: string
    display_name: string | null
    created_at: string
    org_count: number
    last_active_at: string | null
  }>()
  return c.json({
    users: results.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      displayName: r.display_name,
      createdAt: r.created_at,
      orgCount: r.org_count,
      lastActiveAt: r.last_active_at,
    })),
  })
})

/** GET /api/v2/admin/projects — every project with org/creator + rollup. */
admin.get("/projects", async (c) => {
  const { results } = await c.env.AQUILLA_PG.prepare(
    `SELECT p.id, p.name, p.org_id, p.archived_at, p.created_at, p.deadline_at,
            o.name AS org_name,
            u.username AS creator_username,
            COALESCE(SUM(f.cell_count), 0) AS total_cells,
            COALESCE(SUM(f.approved_count), 0) AS validated_cells,
            COALESCE(SUM(f.word_count), 0) AS word_count,
            MAX(f.last_edit_at) AS last_edit_at
       FROM projects p
       LEFT JOIN organizations o ON o.id = p.org_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN files f ON f.project_id = p.id
      GROUP BY p.id, o.name, u.username
      ORDER BY p.created_at DESC`,
  ).all<{
    id: string
    name: string
    org_id: number | null
    org_name: string | null
    archived_at: string | null
    created_at: string
    deadline_at: string | null
    creator_username: string | null
    total_cells: number
    validated_cells: number
    word_count: number
    last_edit_at: number | null
  }>()
  return c.json({
    projects: results.map((r) => ({
      id: r.id,
      name: r.name,
      orgId: r.org_id,
      orgName: r.org_name,
      archived: r.archived_at != null,
      createdAt: r.created_at,
      deadlineAt: r.deadline_at,
      creatorUsername: r.creator_username,
      totalCells: r.total_cells,
      validatedCells: r.validated_cells,
      wordCount: r.word_count,
      lastEditAt: r.last_edit_at,
    })),
  })
})

/**
 * GET /api/v2/admin/activity — cross-tenant activity feed. `limit` defaults
 * to 100 and is capped at 500; `since` is an optional ISO timestamp lower
 * bound. Newest first.
 */
admin.get("/activity", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100
  const since = c.req.query("since")

  const where = since ? "WHERE a.timestamp >= ?" : ""
  const stmt = c.env.AQUILLA_PG.prepare(
    `SELECT a.id, a.user_id, a.activity_type, a.description, a.timestamp,
            u.username
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
      ORDER BY a.timestamp DESC, a.id DESC
      LIMIT ?`,
  )
  const bound = since ? stmt.bind(since, limit) : stmt.bind(limit)
  const { results } = await bound.all<{
    id: number
    user_id: number
    activity_type: string | null
    description: string | null
    timestamp: string
    username: string | null
  }>()
  return c.json({
    activity: results.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      type: r.activity_type,
      description: r.description,
      timestamp: r.timestamp,
    })),
  })
})

// ── Credit config endpoints ───────────────────────────────────────────────────
// All gated by the requirePlatformAdmin middleware above — no per-route re-check
// is needed.

/**
 * GET /api/v2/admin/credits/orgs
 *
 * List all orgs with their current day + week credit spend, caps, enforce flag,
 * and showToOrg flag. Ordered by total week spend descending (most active first).
 *
 * Graceful-degrade: if org_credit_usage_daily doesn't exist yet, all spend
 * fields are 0. Config is always returned from org_settings.
 */
admin.get("/credits/orgs", async (c) => {
  const db = c.env.AQUILLA_PG

  // Fetch all orgs.
  const { results: orgs } = await db
    .prepare("SELECT id, name FROM organizations ORDER BY id")
    .all<{ id: number; name: string | null }>()

  const rows = await Promise.all(
    (orgs ?? []).map(async (org) => {
      const cfg = await resolveCreditConfig(c.env, db, org.id)
      const spend = await readSpend(db, org.id, cfg)
      return {
        orgId: org.id,
        orgName: org.name,
        config: {
          markup: cfg.markup,
          agentMarkup: cfg.agentMarkup,
          dailyCap: cfg.dailyCap,
          weeklyCap: cfg.weeklyCap,
          agentDailyCap: cfg.agentDailyCap,
          agentWeeklyCap: cfg.agentWeeklyCap,
          enforce: cfg.enforce,
          showToOrg: cfg.showToOrg,
        },
        day: {
          totalCredits: spend.dayCredits,
          agentCredits: spend.agentDayCredits,
          byRail: spend.byRailDay,
        },
        week: {
          totalCredits: spend.weekCredits,
          agentCredits: spend.agentWeekCredits,
          byRail: spend.byRailWeek,
        },
      }
    }),
  )

  // Sort: most week spend first.
  rows.sort((a, b) => b.week.totalCredits - a.week.totalCredits)

  return c.json({ orgs: rows })
})

const creditConfigPatchSchema = z.object({
  markup:         z.number().positive().optional(),
  agentMarkup:    z.number().positive().optional(),
  dailyCap:       z.number().nonnegative().optional(),
  weeklyCap:      z.number().nonnegative().optional(),
  agentDailyCap:  z.number().nonnegative().optional(),
  agentWeeklyCap: z.number().nonnegative().optional(),
  enforce:        z.boolean().optional(),
  showToOrg:      z.boolean().optional(),
})

/**
 * PATCH /api/v2/admin/credits/org/:orgId
 *
 * Partially update per-org credit config stored in org_settings.credits.
 * Missing fields are left unchanged (deep-merge with current credits blob).
 * Upserts the org_settings row if it doesn't exist (version = 0).
 *
 * Body: Partial<CreditConfig> (any subset of the fields above).
 * Response: { orgId, credits } — the updated credits config.
 */
admin.patch(
  "/credits/org/:orgId",
  zValidator("json", creditConfigPatchSchema),
  async (c) => {
    const orgId = parseInt(c.req.param("orgId"), 10)
    if (!Number.isFinite(orgId)) return c.json({ error: "invalid orgId" }, 400)

    const patch = c.req.valid("json")
    const db = c.env.AQUILLA_PG
    const user = c.get("user")

    // Load existing org_settings (may not exist).
    const existing = await db
      .prepare("SELECT settings, version FROM org_settings WHERE org_id = ?")
      .bind(orgId)
      .first<{ settings: string; version: number }>()

    let settings: Record<string, unknown> = {}
    let version = 0
    if (existing) {
      try { settings = JSON.parse(existing.settings) as Record<string, unknown> } catch { /* ignore */ }
      version = existing.version
    }

    // Deep-merge patch into settings.credits.
    const currentCredits = (settings.credits as Record<string, unknown> | undefined) ?? {}
    const nextCredits: Record<string, unknown> = { ...currentCredits }
    if (patch.markup !== undefined)         nextCredits.markup = patch.markup
    if (patch.agentMarkup !== undefined)    nextCredits.agentMarkup = patch.agentMarkup
    if (patch.dailyCap !== undefined)       nextCredits.dailyCap = patch.dailyCap
    if (patch.weeklyCap !== undefined)      nextCredits.weeklyCap = patch.weeklyCap
    if (patch.agentDailyCap !== undefined)  nextCredits.agentDailyCap = patch.agentDailyCap
    if (patch.agentWeeklyCap !== undefined) nextCredits.agentWeeklyCap = patch.agentWeeklyCap
    if (patch.enforce !== undefined)        nextCredits.enforce = patch.enforce
    if (patch.showToOrg !== undefined)      nextCredits.showToOrg = patch.showToOrg

    settings.credits = nextCredits
    const settingsJson = JSON.stringify(settings)

    // Look up the admin user id (for updated_by).
    const adminRow = await db
      .prepare("SELECT id FROM users WHERE username = ?")
      .bind(user.username)
      .first<{ id: number }>()
    const adminId = adminRow?.id ?? 0

    if (existing) {
      await db
        .prepare(
          `UPDATE org_settings
              SET settings = ?, version = ?, updated_at = now(), updated_by = ?
            WHERE org_id = ?`,
        )
        .bind(settingsJson, version + 1, adminId, orgId)
        .run()
    } else {
      await db
        .prepare(
          `INSERT INTO org_settings (org_id, settings, version, updated_by)
           VALUES (?, ?, 1, ?)`,
        )
        .bind(orgId, settingsJson, adminId)
        .run()
    }

    return c.json({ orgId, credits: nextCredits })
  },
)

// ── Global platform settings (LLM models, allowed models, AI budgets) ─────────
// Stored in platform_settings; read on the chat/agent hot path with env-var
// fallbacks. Both routes are behind requireAdminElevation (mounted above).

/**
 * GET /api/v2/admin/settings — the stored settings + version, plus the
 * `effective` values actually in force (store value OR env fallback) and the
 * allowed-model menu so the UI can render dropdowns instead of free text.
 */
admin.get("/settings", async (c) => {
  const rec = await loadPlatformSettings(c.env)
  const allowedMenu = [...getAllowedModels(c.env, rec.settings)].filter(
    (m) => m !== "default" && m !== "free-tier",
  )
  return c.json({
    settings: rec.settings,
    version: rec.version,
    updatedAt: rec.updatedAt,
    updatedBy: rec.updatedBy,
    effective: {
      defaultLlmModel:
        rec.settings.defaultLlmModel || c.env.DEFAULT_LLM_MODEL || DEFAULT_LLM_MODEL_ID,
      agentModel:
        rec.settings.agentModel || c.env.AGENT_MODEL_DEFAULT || DEFAULT_LLM_MODEL_ID,
      allowedModels: allowedMenu,
    },
  })
})

const platformSettingsPatchSchema = z.object({
  defaultLlmModel:    z.string().min(1).optional(),
  agentModel:         z.string().min(1).optional(),
  allowedModels:      z.array(z.string().min(1)).optional(),
  aiUserDailyLimit:   z.number().int().nonnegative().optional(),
  aiGlobalDailyLimit: z.number().int().nonnegative().optional(),
  aiBudgetEnforce:    z.boolean().optional(),
  abTest: z
    .object({
      enabled: z.boolean(),
      challengerModel: z.string(),
      trafficPct: z.number().int().min(0).max(100),
    })
    .optional(),
  ifMatchVersion:     z.number().int().nonnegative(),
})

/**
 * PATCH /api/v2/admin/settings — partial update under an optimistic-version
 * guard. Rejects (400) any stored model that wouldn't be in the post-merge
 * allowed-models set, so we can never persist a model the AI guard would then
 * reject platform-wide. 409 on a version mismatch. Audited.
 */
admin.patch("/settings", zValidator("json", platformSettingsPatchSchema), async (c) => {
  const user = c.get("user")
  const { ifMatchVersion, ...patch } = c.req.valid("json")

  // Validate the effective (post-merge) chat/agent model against the effective
  // (post-merge) allowlist — catches both "set a model not in the list" and
  // "shrink the list below the current model".
  const current = await loadPlatformSettings(c.env)
  const merged = { ...current.settings, ...patch }
  const mergedAllowed = getAllowedModels(c.env, merged)
  for (const field of ["defaultLlmModel", "agentModel"] as const) {
    const value = merged[field]
    if (value !== undefined && !mergedAllowed.has(value)) {
      return c.json(
        {
          error: "model_not_allowed",
          message: `${field} "${value}" is not in the allowed-models list. Add it to allowedModels first, or choose one of: ${[...mergedAllowed].filter((m) => m !== "default" && m !== "free-tier").join(", ")}.`,
        },
        400,
      )
    }
  }

  // An enabled A/B experiment needs a real, allowlisted challenger that isn't
  // just the champion — otherwise the roll is meaningless or would serve a
  // model the AI guard rejects on every challenger request.
  const mergedAb = merged.abTest
  if (mergedAb?.enabled) {
    const challenger = mergedAb.challengerModel.trim()
    const champion =
      merged.defaultLlmModel || c.env.DEFAULT_LLM_MODEL || DEFAULT_LLM_MODEL_ID
    if (!challenger || !mergedAllowed.has(challenger)) {
      return c.json(
        {
          error: "model_not_allowed",
          message: `abTest.challengerModel "${challenger}" is not in the allowed-models list.`,
        },
        400,
      )
    }
    if (challenger === champion) {
      return c.json(
        {
          error: "ab_challenger_is_champion",
          message: "The challenger model must differ from the default chat model.",
        },
        400,
      )
    }
  }

  const result = await savePlatformSettings(c.env, patch, ifMatchVersion, user.id)
  if (!result.ok) {
    return c.json({ error: "version_mismatch", current: result.conflict }, 409)
  }

  await c.env.AQUILLA_PG.prepare(
    `INSERT INTO admin_audit_log (user_id, action, detail) VALUES (?, 'settings.update', ?)`,
  )
    .bind(user.id, JSON.stringify(patch))
    .run()

  return c.json({ settings: result.record.settings, version: result.record.version })
})

/**
 * GET /api/v2/admin/ab-results?days=30 — per-model/arm aggregates from
 * model_ab_events: request volume, error count, and the user gestures the SPA
 * reported (accepted / edited / rejected). Rows only exist while an experiment
 * is enabled, so both arms always cover the same window. Behind the elevation
 * gate like the rest of the console.
 */
admin.get("/ab-results", async (c) => {
  const daysRaw = Number(c.req.query("days") ?? 30)
  const days = Number.isFinite(daysRaw) ? Math.min(365, Math.max(1, Math.floor(daysRaw))) : 30
  const results = await aggregateAbResults(c.env.AQUILLA_PG, days)
  return c.json({ days, results })
})

export default admin
