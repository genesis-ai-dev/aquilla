import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import {
  applyLegacyUserMigration,
  type LegacyMigrationResult,
} from "../services/legacy-user-migration"
import { applyMigratedMemberLaneGrants } from "../services/lane-grants"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { orgLegacyUuidFor, projectIdFor, teamLegacyUuidFor } from "../../../src/lib/migrate/ids"
import type { CanonicalUserAccessPlan } from "../../../src/lib/migrate/user-access"

// AQU-1799: the Codex/GitLab account migration copies org, team and project
// memberships in one transaction and wrote NO lane grants. Under the lane
// read/write wall a member below Maintainer reads and writes a target lane
// only through a project_member_lane_roles row, so every account migrated
// after the AQU-730 backfill — at first sign-in (imported_via 'jit') or by the
// nightly import ('scheduled') — opened its projects with no target lane in
// the switcher and nothing to edit. Reported from the Bemba project on
// 2026-10-08. AQU-1782 closed the same gap for direct add; this closes it for
// migration, through the same writer so the two paths cannot drift.
//
// Both entry points funnel through applyLegacyUserMigration, so the cases
// below drive it directly with the access plan the GitLab planner would have
// produced, and assert the 'jit'/'scheduled' parity explicitly.

const DIRECT_PROJECT = projectIdFor("91", "gitlab")
const TEAM_PROJECT = projectIdFor("92", "gitlab")

/**
 * Users are inserted WITHOUT an explicit id: `users.id` is a sequence, and an
 * explicit id does not advance it, so the migration's own INSERT would then
 * collide on the id this seed took.
 */
async function seedUserRow(username: string): Promise<number> {
  const row = await env.AQUILLA_PG.prepare(
    `INSERT INTO users (username, email, password_hash, preferences)
     VALUES (?, ?, 'scrypt:fake$salt$hash', '{}') RETURNING id`,
  )
    .bind(username, `${username}@example.com`)
    .first<{ id: number }>()
  if (!row) throw new Error(`failed to seed ${username}`)
  return Number(row.id)
}

let ownerId = 0

async function seedOwner(): Promise<number> {
  ownerId = await seedUserRow("owner")
  return ownerId
}

/**
 * Org 10 (legacy uuid), team 11 attached to TEAM_PROJECT at Contributor, two
 * projects each with a source lane and two target lanes. The org role in every
 * plan below stays BELOW Maintainer on purpose: a Maintainer org role is an
 * access path in its own right (AQU-435) and would resolve every project to
 * 600, which writes no grants and would hide the bug.
 */
async function seedAccessTargets(): Promise<void> {
  await seedOwner()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id, legacy_uuid) VALUES (10, 'Org A', ?, ?)",
  )
    .bind(ownerId, orgLegacyUuidFor(10))
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (id, org_id, name, created_by, legacy_uuid) VALUES (11, 10, 'org-a/team-a', ?, ?)",
  )
    .bind(ownerId, teamLegacyUuidFor(11))
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'Direct', 10, ?), (?, 'Via Team', 10, ?)",
  )
    .bind(DIRECT_PROJECT, ownerId, TEAM_PROJECT, ownerId)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (11, ?, 400, ?)",
  )
    .bind(TEAM_PROJECT, ownerId)
    .run()
  for (const projectId of [DIRECT_PROJECT, TEAM_PROJECT]) {
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position) VALUES
         (?, ?, 'source', 'Greek', 'Greek', NULL, 0),
         (?, ?, 'target', 'Bemba', 'Bemba', '', 1),
         (?, ?, 'target', 'Nyanja', 'Nyanja', 'ny', 2)`,
    )
      .bind(
        `s${projectId.slice(-6)}`,
        projectId,
        `b${projectId.slice(-6)}`,
        projectId,
        `n${projectId.slice(-6)}`,
        projectId,
      )
      .run()
  }
}

function sourceRow(passwordHash: string, id = 700) {
  return {
    id,
    username: `Migrant${id}`,
    email: `migrant${id}@example.com`,
    password_hash: passwordHash,
    gitlab_user_id: 70 + id,
    created_at: null,
    updated_at: null,
  }
}

function plan(overrides: Partial<CanonicalUserAccessPlan> = {}): CanonicalUserAccessPlan {
  return {
    orgMemberships: [{ orgUuid: orgLegacyUuidFor(10), roleLevel: 400 }],
    teamUuids: [],
    projectMemberships: [],
    conflicts: [],
    confirmedMembershipCount: 1,
    ...overrides,
  }
}

async function migrate(
  access: CanonicalUserAccessPlan,
  opts: { id?: number; importedVia?: "jit" | "scheduled" } = {},
): Promise<LegacyMigrationResult> {
  const hash = await hashPasswordWerkzeugScrypt("correct-password")
  return applyLegacyUserMigration(
    env.AQUILLA_PG,
    sourceRow(hash, opts.id ?? 700),
    access,
    opts.importedVia ?? "jit",
  )
}

async function grantsFor(
  projectId: string,
  userId: number,
): Promise<Array<{ lane: string; level: number }>> {
  const { results } = await env.AQUILLA_PG.prepare(
    `SELECT lane, role_level FROM project_member_lane_roles
      WHERE project_id = ? AND user_id = ? ORDER BY lane`,
  )
    .bind(projectId, userId)
    .all<{ lane: string; role_level: number }>()
  return (results ?? []).map((row) => ({ lane: row.lane, level: Number(row.role_level) }))
}

describe("Codex/GitLab migration writes lane access (AQU-1799)", () => {
  it("a migrated Developer gets a grant on every target lane of a direct project", async () => {
    await seedAccessTargets()
    const result = await migrate(
      plan({ projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 400 }] }),
    )
    expect(result.created).toBe(true)
    expect(await grantsFor(DIRECT_PROJECT, result.userId)).toEqual([
      { lane: `b${DIRECT_PROJECT.slice(-6)}`, level: 400 },
      { lane: `n${DIRECT_PROJECT.slice(-6)}`, level: 400 },
    ])
    // granted_by stays NULL, like every other row this migration writes.
    const grantedBy = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM project_member_lane_roles WHERE user_id = ? AND granted_by IS NOT NULL",
    )
      .bind(result.userId)
      .first<number>("n")
    expect(grantedBy).toBe(0)
  })

  it("covers a project the person only reaches through a team the migration joins", async () => {
    await seedAccessTargets()
    const result = await migrate(plan({ teamUuids: [teamLegacyUuidFor(11)] }))
    // No project_members row at all — the team attachment is the only path.
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT COUNT(*) AS n FROM project_members WHERE user_id = ?",
      )
        .bind(result.userId)
        .first<number>("n"),
    ).toBe(0)
    expect(await grantsFor(TEAM_PROJECT, result.userId)).toEqual([
      { lane: `b${TEAM_PROJECT.slice(-6)}`, level: 400 },
      { lane: `n${TEAM_PROJECT.slice(-6)}`, level: 400 },
    ])
    // The project it was never given stays untouched.
    expect(await grantsFor(DIRECT_PROJECT, result.userId)).toEqual([])
  })

  it("includes an archived lane, so a lane created later still reaches the person", async () => {
    await seedAccessTargets()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, language, name, legacy_tag, position, archived_at)
       VALUES ('arch0001', ?, 'target', 'Tonga', 'Tonga', 'to', 3, now())`,
    )
      .bind(DIRECT_PROJECT)
      .run()
    const result = await migrate(
      plan({ projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 400 }] }),
    )
    // AQU-1781 grants a newly created lane only to someone who already holds
    // every OTHER target lane, archived ones included, so leaving the archived
    // lane out here would make this person "lane-limited" and silently skip
    // them for every lane created afterwards — the AQU-1783 drift. Invite
    // accept, direct add (AQU-1782), the one-click regrant and the AQU-730
    // backfill all grant the archived lanes for the same reason; the member
    // inspector still lists current lanes only, so it does not show there.
    expect((await grantsFor(DIRECT_PROJECT, result.userId)).map((g) => g.lane)).toEqual([
      "arch0001",
      `b${DIRECT_PROJECT.slice(-6)}`,
      `n${DIRECT_PROJECT.slice(-6)}`,
    ])
  })

  it("writes no rows for a Maintainer — the role already clears the wall", async () => {
    await seedAccessTargets()
    const result = await migrate(
      plan({ projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 600 }] }),
    )
    expect(await grantsFor(DIRECT_PROJECT, result.userId)).toEqual([])
  })

  it("grants a Guest-mapped Viewer read access to the target lanes", async () => {
    await seedAccessTargets()
    const result = await migrate(
      plan({
        orgMemberships: [{ orgUuid: orgLegacyUuidFor(10), roleLevel: 100 }],
        projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 100 }],
      }),
    )
    expect(await grantsFor(DIRECT_PROJECT, result.userId)).toEqual([
      { lane: `b${DIRECT_PROJECT.slice(-6)}`, level: 100 },
      { lane: `n${DIRECT_PROJECT.slice(-6)}`, level: 100 },
    ])
  })

  it("uses the effective max-wins role, not the role the plan asked for", async () => {
    await seedAccessTargets()
    // Developer on the project (400) but Project Lead on the org (500): the org
    // path keeps a team attachment from demoting, but an explicit project row
    // still wins (AQU-1274), so the grants are written at 400.
    const result = await migrate(
      plan({
        orgMemberships: [{ orgUuid: orgLegacyUuidFor(10), roleLevel: 500 }],
        projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 400 }],
      }),
    )
    expect((await grantsFor(DIRECT_PROJECT, result.userId)).map((g) => g.level)).toEqual([400, 400])
  })

  it("the nightly import lands the same account in the same place as sign-in", async () => {
    await seedAccessTargets()
    const access = plan({ projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 400 }] })
    const jit = await migrate(access, { id: 700 })
    const scheduled = await migrate(access, { id: 701, importedVia: "scheduled" })
    expect(await grantsFor(DIRECT_PROJECT, scheduled.userId)).toEqual(
      await grantsFor(DIRECT_PROJECT, jit.userId),
    )
  })

  it("a second run writes nothing new", async () => {
    await seedAccessTargets()
    const access = plan({ projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 400 }] })
    const first = await migrate(access)
    const before = await grantsFor(DIRECT_PROJECT, first.userId)
    const second = await migrate(access)
    expect(second).toMatchObject({ userId: first.userId, created: false })
    expect(await grantsFor(DIRECT_PROJECT, first.userId)).toEqual(before)
  })

  it("a project with no lane rows yet is left alone", async () => {
    await seedOwner()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, legacy_uuid) VALUES (10, 'Org A', ?, ?)",
    )
      .bind(ownerId, orgLegacyUuidFor(10))
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, 'No Lanes', 10, ?)",
    )
      .bind(DIRECT_PROJECT, ownerId)
      .run()
    const result = await migrate(
      plan({ projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 400 }] }),
    )
    expect(await grantsFor(DIRECT_PROJECT, result.userId)).toEqual([])
  })

  it("a failed lane-access write rolls the whole migration back", async () => {
    await seedAccessTargets()
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    // The grant INSERT is the only write this constraint can reject, so it
    // fails exactly the new stage and nothing before it.
    await env.AQUILLA_PG.prepare(
      "ALTER TABLE project_member_lane_roles ADD CONSTRAINT aqu1799_force_failure CHECK (false)",
    ).run()
    try {
      await expect(
        migrate(plan({ projectMemberships: [{ projectId: DIRECT_PROJECT, roleLevel: 400 }] })),
      ).rejects.toMatchObject({ code: "dependency" })
    } finally {
      await env.AQUILLA_PG.prepare(
        "ALTER TABLE project_member_lane_roles DROP CONSTRAINT aqu1799_force_failure",
      ).run()
    }
    expect(errorSpy).toHaveBeenCalledWith(
      "[legacy-user-migration] atomic apply failed",
      expect.objectContaining({ stage: "lane-access" }),
    )
    errorSpy.mockRestore()
    // No half-migrated account: identity, provenance and every membership are gone.
    for (const [table, where] of [
      ["users", "LOWER(username) = 'migrant700'"],
      ["legacy_identity_links", "source_user_id = 700"],
      ["org_members", "user_id NOT IN (SELECT id FROM users)"],
      ["project_members", "user_id NOT IN (SELECT id FROM users)"],
      ["project_member_lane_roles", "user_id NOT IN (SELECT id FROM users)"],
    ] as const) {
      expect(
        await env.AQUILLA_PG.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).first<number>(
          "n",
        ),
      ).toBe(0)
    }
  })
})

describe("applyMigratedMemberLaneGrants (AQU-1799)", () => {
  it("leaves an account that already has explicit lane scopes on exactly those lanes", async () => {
    await seedAccessTargets()
    const userId = await seedUserRow("preseeded")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, 400, ?)",
    )
      .bind(DIRECT_PROJECT, userId, ownerId)
      .run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_member_scopes (project_id, user_id, kind, value, created_by, created_at)
       VALUES (?, ?, 'lane', ?, ?, 0)`,
    )
      .bind(DIRECT_PROJECT, userId, `n${DIRECT_PROJECT.slice(-6)}`, String(ownerId))
      .run()
    await applyMigratedMemberLaneGrants(env.AQUILLA_PG, userId, [DIRECT_PROJECT])
    expect(await grantsFor(DIRECT_PROJECT, userId)).toEqual([
      { lane: `n${DIRECT_PROJECT.slice(-6)}`, level: 400 },
    ])
  })

  it("skips a project the person cannot reach, and an archived one", async () => {
    await seedAccessTargets()
    const userId = await seedUserRow("outsider")
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET archived_at = now() WHERE id = ?",
    )
      .bind(TEAM_PROJECT)
      .run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id, added_by) VALUES (11, ?, ?)",
    )
      .bind(userId, ownerId)
      .run()
    await applyMigratedMemberLaneGrants(env.AQUILLA_PG, userId, [DIRECT_PROJECT, TEAM_PROJECT])
    // DIRECT_PROJECT: no path at all. TEAM_PROJECT: a real path, but archived.
    expect(await grantsFor(DIRECT_PROJECT, userId)).toEqual([])
    expect(await grantsFor(TEAM_PROJECT, userId)).toEqual([])
  })
})
