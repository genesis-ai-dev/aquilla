// Dev-only seed + login bypass for local browser testing & Playwright.
//
// Endpoints (both 404 unless `WRANGLER_LOCAL=1`):
//   POST /__dev__/seed   — idempotent upsert of a known user/org/project.
//   POST /__dev__/login  — runs seed, then mints a JWT for the dev user.
//
// HARD-GATED on `WRANGLER_LOCAL=1` exactly like /__test__/reset. Production
// wrangler.toml does NOT define WRANGLER_LOCAL, so this route surface is
// invisible in prod even if the worker is reachable. The bypass also never
// takes a user identifier from the request — it always resolves to the
// hardcoded `dev` username — so even if the gate ever failed open, an
// attacker could only log in as a user that does not exist in prod D1.

import { Hono } from "hono"
import type { AuthHonoEnv } from "../middleware/auth"
import { JWTService } from "../auth/jwt"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { ROLE } from "../types"

const DEV_USERNAME = "dev"
const DEV_EMAIL = "dev@local.test"
const DEV_PASSWORD = "dev"
const DEV_ORG_NAME = "Dev Org"
const DEV_PROJECT_ID = "dev-project"
const DEV_PROJECT_NAME = "Dev Project"

interface UserIdRow {
  id: number
}
interface OrgIdRow {
  id: number
}

const devSeed = new Hono<AuthHonoEnv>()

async function seedDev(db: D1Database): Promise<{
  userId: number
  orgId: number
  projectId: string
}> {
  const passwordHash = await hashPasswordWerkzeugScrypt(DEV_PASSWORD)

  await db
    .prepare(
      `INSERT INTO users (username, email, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(username) DO UPDATE SET
         email = excluded.email,
         password_hash = excluded.password_hash,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(DEV_USERNAME, DEV_EMAIL, passwordHash)
    .run()

  const userRow = await db
    .prepare("SELECT id FROM users WHERE username = ?")
    .bind(DEV_USERNAME)
    .first<UserIdRow>()
  if (!userRow) throw new Error("dev user not found after upsert")
  const userId = userRow.id

  // organizations has no UNIQUE constraint on name, so do a lookup-or-insert.
  let orgRow = await db
    .prepare("SELECT id FROM organizations WHERE owner_user_id = ? AND name = ?")
    .bind(userId, DEV_ORG_NAME)
    .first<OrgIdRow>()
  if (!orgRow) {
    await db
      .prepare(
        `INSERT INTO organizations (name, owner_user_id, created_at, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(DEV_ORG_NAME, userId)
      .run()
    orgRow = await db
      .prepare("SELECT id FROM organizations WHERE owner_user_id = ? AND name = ?")
      .bind(userId, DEV_ORG_NAME)
      .first<OrgIdRow>()
  }
  if (!orgRow) throw new Error("dev org not found after insert")
  const orgId = orgRow.id

  await db
    .prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by, granted_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(org_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    )
    .bind(orgId, userId, ROLE.OWNER, userId)
    .run()

  await db
    .prepare(
      `INSERT INTO projects (id, name, org_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         org_id = excluded.org_id,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(DEV_PROJECT_ID, DEV_PROJECT_NAME, orgId, userId)
    .run()

  await db
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by, granted_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    )
    .bind(DEV_PROJECT_ID, userId, ROLE.OWNER, userId)
    .run()

  return { userId, orgId, projectId: DEV_PROJECT_ID }
}

devSeed.post("/seed", async (c) => {
  if (c.env.WRANGLER_LOCAL !== "1") {
    return c.json({ error: "Not found" }, 404)
  }
  try {
    const ids = await seedDev(c.env.AQUILLA_DB)
    return c.json({
      ok: true,
      user: { id: ids.userId, username: DEV_USERNAME, email: DEV_EMAIL },
      org: { id: ids.orgId, name: DEV_ORG_NAME },
      project: { id: ids.projectId, name: DEV_PROJECT_NAME },
    })
  } catch (err) {
    console.error("[dev-seed] failed:", err)
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: "seed failed", detail: msg }, 500)
  }
})

devSeed.post("/login", async (c) => {
  if (c.env.WRANGLER_LOCAL !== "1") {
    return c.json({ error: "Not found" }, 404)
  }
  if (!c.env.SECRET_KEY || !c.env.ALGORITHM) {
    return c.json(
      { error: "Authentication is not configured (SECRET_KEY/ALGORITHM)" },
      503,
    )
  }
  try {
    const ids = await seedDev(c.env.AQUILLA_DB)
    const jwt = new JWTService(c.env)
    const accessToken = await jwt.createAccessToken(DEV_USERNAME)
    return c.json({
      access_token: accessToken,
      token_type: "bearer",
      username: DEV_USERNAME,
      user: { id: ids.userId, username: DEV_USERNAME, email: DEV_EMAIL },
      org: { id: ids.orgId, name: DEV_ORG_NAME },
      project: { id: ids.projectId, name: DEV_PROJECT_NAME },
    })
  } catch (err) {
    console.error("[dev-login] failed:", err)
    const msg = err instanceof Error ? err.message : String(err)
    return c.json({ error: "dev login failed", detail: msg }, 500)
  }
})

export default devSeed
