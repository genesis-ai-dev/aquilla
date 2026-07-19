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
// attacker could only log in as a user that does not exist in prod Postgres.

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

// Extra projects + collaborators so the org Members matrix has something to
// render locally (AQU-218). All under the dev org, created_by dev. The access
// configs below deliberately exercise each of the four resolution paths:
//   - creator: dev on every project
//   - org:     alice (org maintainer) inherits on every project
//   - override: alice has a direct OWNER row on Genesis that beats her org tier
//   - group:   bob (NOT an org member) reaches Exodus only via the Reviewers group
const GENESIS_PROJECT_ID = "dev-project-genesis"
const GENESIS_PROJECT_NAME = "Genesis"
const EXODUS_PROJECT_ID = "dev-project-exodus"
const EXODUS_PROJECT_NAME = "Exodus"
const LEVITICUS_PROJECT_ID = "dev-project-leviticus"
const LEVITICUS_PROJECT_NAME = "Leviticus"
const NUMBERS_PROJECT_ID = "dev-project-numbers"
const NUMBERS_PROJECT_NAME = "Numbers"
const ALICE_USERNAME = "alice"
const ALICE_EMAIL = "alice@local.test"
const BOB_USERNAME = "bob"
const BOB_EMAIL = "bob@local.test"
const REVIEWERS_GROUP_NAME = "Reviewers"

interface UserIdRow {
  id: number
}
interface OrgIdRow {
  id: number
}
interface GroupIdRow {
  id: number
}

/** ISO date N calendar days from today (UTC) — matches e2e deadline helpers. */
function isoDateOffset(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** UTC ISO timestamp N calendar days from now — for created_at / activity demos. */
function isoTimestampOffset(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString()
}

/** Upsert a user by username (password "dev"), returning its id. */
async function upsertUser(
  db: AquillaDb,
  username: string,
  email: string,
  passwordHash: string,
): Promise<number> {
  await db
    .prepare(
      `INSERT INTO users (username, email, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(username) DO UPDATE SET
         email = excluded.email,
         password_hash = excluded.password_hash,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(username, email, passwordHash)
    .run()
  const row = await db
    .prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first<UserIdRow>()
  if (!row) throw new Error(`user ${username} not found after upsert`)
  return row.id
}

/** Upsert a project under an org, created_by the given user. */
async function upsertProject(
  db: AquillaDb,
  projectId: string,
  name: string,
  orgId: number,
  createdBy: number,
  deadlineAt: string | null = null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO projects (id, name, org_id, created_by, deadline_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         org_id = excluded.org_id,
         deadline_at = excluded.deadline_at,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(projectId, name, orgId, createdBy, deadlineAt)
    .run()
}

async function upsertOrgMember(
  db: AquillaDb,
  orgId: number,
  userId: number,
  roleLevel: number,
  grantedBy: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO org_members (org_id, user_id, role_level, granted_by, granted_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(org_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    )
    .bind(orgId, userId, roleLevel, grantedBy)
    .run()
}

async function upsertProjectMember(
  db: AquillaDb,
  projectId: string,
  userId: number,
  roleLevel: number,
  grantedBy: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by, granted_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role_level = excluded.role_level`,
    )
    .bind(projectId, userId, roleLevel, grantedBy)
    .run()
}

// SWARM-TODO (FRO terminology demo-truth): the Wave-1 QA bug ("seeded concept
// grace→gracia doesn't match Adzera source cells") cannot be fixed here. This
// route seeds ONLY users / orgs / projects / members in Postgres (aquilla-db). It
// seeds NO files, NO cells, and NO concepts:
//   - There is no `concepts` table in any auth-worker migration. Concepts are
//     a client-side (IndexedDB) model per AD-3 thin-client; see
//     src/lib/terminology/types.ts (Concept) — they are derived/compiled on the
//     client, not persisted in Postgres.
//   - The only `grace→gracia` concept in the repo lives in unit-test fixtures
//     (src/lib/terminology/terminology.test.ts, stats.test.ts), not in any seed.
//   - The dev project's source/target cells are not inserted by any route here;
//     the `cells` table belongs to the codex DB and is populated via sync
//     events, not by dev-seed.
// To make terminology demo-true on the dev project, the fix must land where the
// dev project's CELLS and CONCEPTS are actually materialized for a fresh dev
// login (client-side IDB seed / sync-event seed), NOT in this Postgres seed route.
// NEEDED to proceed: (1) confirmation of where dev-project source/target cells
// are seeded for the browser (IDB bootstrap vs sync-worker fixture), and (2) the
// real source language + sample source/target cell text so a managed Concept
// whose sourceTerm actually occurs in the source corpus can be added there.

const devSeed = new Hono<AuthHonoEnv>()

async function seedDev(db: AquillaDb): Promise<{
  userId: number
  orgId: number
  projectId: string
}> {
  const passwordHash = await hashPasswordWerkzeugScrypt(DEV_PASSWORD)

  const userId = await upsertUser(db, DEV_USERNAME, DEV_EMAIL, passwordHash)

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

  await upsertProjectMember(db, DEV_PROJECT_ID, userId, ROLE.OWNER, userId)

  // ── Extra collaborators + projects so the Members matrix is non-trivial ──
  const aliceId = await upsertUser(db, ALICE_USERNAME, ALICE_EMAIL, passwordHash)
  const bobId = await upsertUser(db, BOB_USERNAME, BOB_EMAIL, passwordHash)

  await upsertProject(db, GENESIS_PROJECT_ID, GENESIS_PROJECT_NAME, orgId, userId)
  await upsertProject(db, EXODUS_PROJECT_ID, EXODUS_PROJECT_NAME, orgId, userId)

  // Deadline demos for org portfolio status (overdue / due soon).
  await upsertProject(db, LEVITICUS_PROJECT_ID, LEVITICUS_PROJECT_NAME, orgId, userId, isoDateOffset(-3))
  await upsertProjectMember(db, LEVITICUS_PROJECT_ID, userId, ROLE.OWNER, userId)
  await upsertProject(db, NUMBERS_PROJECT_ID, NUMBERS_PROJECT_NAME, orgId, userId, isoDateOffset(3))
  await upsertProjectMember(db, NUMBERS_PROJECT_ID, userId, ROLE.OWNER, userId)

  // alice is an org maintainer → inherits access to every org project (the
  // "org" path). On Genesis she also has a direct OWNER row, so "override"
  // wins there with "org" demoted to a secondary source.
  await upsertOrgMember(db, orgId, aliceId, ROLE.MAINTAINER, userId)
  await upsertProjectMember(db, GENESIS_PROJECT_ID, aliceId, ROLE.OWNER, userId)

  // bob is NOT an org member. He reaches Exodus (and only Exodus) via the
  // Reviewers group → the "group" path, and has empty cells everywhere else.
  let groupRow = await db
    .prepare("SELECT id FROM groups WHERE org_id = ? AND name = ?")
    .bind(orgId, REVIEWERS_GROUP_NAME)
    .first<GroupIdRow>()
  if (!groupRow) {
    await db
      .prepare(
        `INSERT INTO groups (org_id, name, created_by, created_at, updated_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      )
      .bind(orgId, REVIEWERS_GROUP_NAME, userId)
      .run()
    groupRow = await db
      .prepare("SELECT id FROM groups WHERE org_id = ? AND name = ?")
      .bind(orgId, REVIEWERS_GROUP_NAME)
      .first<GroupIdRow>()
  }
  if (!groupRow) throw new Error("reviewers group not found after insert")
  const groupId = groupRow.id

  await db
    .prepare(
      `INSERT INTO group_members (group_id, user_id, added_by, added_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(group_id, user_id) DO NOTHING`,
    )
    .bind(groupId, bobId, userId)
    .run()

  await db
    .prepare(
      `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by, granted_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(group_id, project_id) DO UPDATE SET role_level = excluded.role_level`,
    )
    .bind(groupId, EXODUS_PROJECT_ID, ROLE.REVIEWER, userId)
    .run()

  await applyDemoTimestamps(db, { userId, aliceId, bobId, orgId })

  return { userId, orgId, projectId: DEV_PROJECT_ID }
}

/** Backdate seeded rows so date formatting shows both recent and >1y labels. */
async function applyDemoTimestamps(
  db: AquillaDb,
  ids: { userId: number; aliceId: number; bobId: number; orgId: number },
): Promise<void> {
  const { userId, aliceId, bobId, orgId } = ids

  // Users — Admin People "Joined": mix of "May 25" vs "Jun 2025" short labels.
  await db
    .prepare("UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?")
    .bind(isoTimestampOffset(-90), isoTimestampOffset(-2), userId)
    .run()
  await db
    .prepare("UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?")
    .bind(isoTimestampOffset(-420), isoTimestampOffset(-420), aliceId)
    .run()
  await db
    .prepare("UPDATE users SET created_at = ?, updated_at = ? WHERE id = ?")
    .bind(isoTimestampOffset(-45), isoTimestampOffset(-45), bobId)
    .run()

  await db
    .prepare("UPDATE organizations SET created_at = ?, updated_at = ? WHERE id = ?")
    .bind(isoTimestampOffset(-480), isoTimestampOffset(-480), orgId)
    .run()

  const projectAges: Array<[string, number]> = [
    [DEV_PROJECT_ID, -380],
    [GENESIS_PROJECT_ID, -70],
    [EXODUS_PROJECT_ID, -25],
    [LEVITICUS_PROJECT_ID, -200],
    [NUMBERS_PROJECT_ID, -14],
  ]
  for (const [projectId, days] of projectAges) {
    const ts = isoTimestampOffset(days)
    await db
      .prepare("UPDATE projects SET created_at = ?, updated_at = ? WHERE id = ?")
      .bind(ts, ts, projectId)
      .run()
  }

  // Org member activity — Admin People "Last active".
  await db
    .prepare(
      "UPDATE org_members SET granted_at = ?, last_active_at = ? WHERE org_id = ? AND user_id = ?",
    )
    .bind(isoTimestampOffset(-400), isoTimestampOffset(-3), orgId, userId)
    .run()
  await db
    .prepare(
      "UPDATE org_members SET granted_at = ?, last_active_at = ? WHERE org_id = ? AND user_id = ?",
    )
    .bind(isoTimestampOffset(-200), isoTimestampOffset(-45), orgId, aliceId)
    .run()
}

devSeed.post("/seed", async (c) => {
  if (c.env.WRANGLER_LOCAL !== "1") {
    return c.json({ error: "Not found" }, 404)
  }
  try {
    const ids = await seedDev(c.env.AQUILLA_PG)
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
    const ids = await seedDev(c.env.AQUILLA_PG)
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
