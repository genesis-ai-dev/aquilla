// POST /api/v2/changesets/:id/assign — AQU-CMDREG-P1 §2.2.
//
// Assignment is ROUTING: it names who is expected to act, and resolves
// nothing. A staged changeset with an assignee is still `staged`; `null`
// clears it. The caller needs PROJECT_LEAD (500) on the changeset's project,
// and the assignee must be a LIVE member of that same project — PR #406 lists
// the absence of that membership check on its own assign path as a follow-up,
// so it is asserted here rather than left implicit.
import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const DIGEST = "sha256:deadbeef"

async function seedProject(id: string, name: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
  )
    .bind(id, name, createdBy)
    .run()
}

async function grant(projectId: string, userId: number, roleLevel: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, roleLevel, userId)
    .run()
}

async function seedCredential(userId: number): Promise<string> {
  const id = crypto.randomUUID()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode)
     VALUES (?, ?, 'test-cred', 'aqk_test', ?, 'ask')`,
  )
    .bind(id, String(userId), `hash-${id}`)
    .run()
  return id
}

async function seedChangeset(
  id: string,
  projectId: string,
  createdByUserId: number,
  credentialId: string,
  status = "staged",
): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO changesets
        (id, project_id, created_by_user_id, credential_id, autonomy_mode, status,
         commands, preconditions, summary, digest, expires_at)
     VALUES (?, ?, ?, ?, 'ask', ?, ?::jsonb, '[]'::jsonb, '{}'::jsonb, ?, ?)`,
  )
    .bind(
      id,
      projectId,
      String(createdByUserId),
      credentialId,
      status,
      JSON.stringify([{ kind: "SetTranslation", fileId: "f1", cellId: "c1", value: "x" }]),
      DIGEST,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    )
    .run()
}

/** alice (1) owns proj-1 and staged cs-1; dave (4) is a lead, bob (2) a
 *  contributor, carol (3) a reviewer, mallory (9) a stranger. */
async function seedCast(status = "staged"): Promise<void> {
  await seedUser(1, "alice")
  await seedUser(2, "bob")
  await seedUser(3, "carol")
  await seedUser(4, "dave")
  await seedUser(9, "mallory")
  await seedProject("proj-1", "Blackfoot", 1)
  await grant("proj-1", 2, 400)
  await grant("proj-1", 3, 300)
  await grant("proj-1", 4, 500)
  const credId = await seedCredential(1)
  await seedChangeset("cs-1", "proj-1", 1, credId, status)
}

async function configureAssignmentFloor(level: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Test Org', 1)",
  ).run()
  await env.AQUILLA_PG.prepare("UPDATE projects SET org_id = 1 WHERE id = 'proj-1'").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings, version, updated_by) VALUES (1, ?, 0, 1)",
  )
    .bind(JSON.stringify({ assignmentMinRole: level }))
    .run()
}

async function assign(actor: string, userId: string | null, id = "cs-1"): Promise<Response> {
  return app.request(
    `/api/v2/changesets/${id}/assign`,
    {
      method: "POST",
      headers: authHeader(await jwtFor(actor)),
      body: JSON.stringify({ userId }),
    },
    env,
  )
}

async function readRow(id = "cs-1"): Promise<{ status: string; assigned_to_user_id: string | null }> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT status, assigned_to_user_id FROM changesets WHERE id = ?",
  )
    .bind(id)
    .first<{ status: string; assigned_to_user_id: string | null }>()
  return row ?? { status: "", assigned_to_user_id: null }
}

describe("POST /api/v2/changesets/:id/assign", () => {
  it("routes a staged changeset to a project member without touching its status", async () => {
    await seedCast()

    const res = await assign("dave", "2")
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      changesetId: string
      assignedToUserId: string | null
      status: string
    }
    expect(body).toMatchObject({ changesetId: "cs-1", assignedToUserId: "2", status: "staged" })

    expect(await readRow()).toMatchObject({ status: "staged", assigned_to_user_id: "2" })
  })

  it("clears the assignment with null, still without touching the status", async () => {
    await seedCast()
    expect((await assign("dave", "2")).status).toBe(200)

    const res = await assign("dave", null)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assignedToUserId: string | null; status: string }
    expect(body.assignedToUserId).toBeNull()
    expect(body.status).toBe("staged")

    expect(await readRow()).toMatchObject({ status: "staged", assigned_to_user_id: null })
  })

  it("surfaces the assignee on the approval payload", async () => {
    await seedCast()
    expect((await assign("dave", "2")).status).toBe(200)

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("dave")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { assignedToUserId: string | null; status: string }
    expect(body.assignedToUserId).toBe("2")
    expect(body.status).toBe("staged")
  })

  it("rejects an assignee who is not a live member of the project", async () => {
    await seedCast()
    // mallory exists, and even owns another project — but has no grant here.
    await seedProject("proj-2", "Other", 9)

    const res = await assign("dave", "9")
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("validation_failed")
    expect(body.error.message).toMatch(/live member/i)

    expect((await readRow()).assigned_to_user_id).toBeNull()
  })

  it("rejects an assignee id that names no user", async () => {
    await seedCast()

    const res = await assign("dave", "424242")
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation_failed")
    expect((await readRow()).assigned_to_user_id).toBeNull()
  })

  it("403s a caller below PROJECT_LEAD, even one who could approve the plan", async () => {
    await seedCast()
    // bob is a CONTRIBUTOR (400): above the plan's own approval floor, below
    // the routing floor. Assignment is a lead action, not an approver action.
    const res = await assign("bob", "2")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; details?: { requiredRole: number } } }
    expect(body.error.code).toBe("permission_denied")
    expect(body.error.details?.requiredRole).toBe(500)
    expect((await readRow()).assigned_to_user_id).toBeNull()
  })

  it("lets a contributor route an AI changeset when the org lowers the assignment floor", async () => {
    await seedCast()
    await configureAssignmentFloor(400)

    const res = await assign("bob", "3")
    expect(res.status).toBe(200)
    expect(await readRow()).toMatchObject({
      status: "staged",
      assigned_to_user_id: "3",
    })
  })

  it("raises AI-task routing authority when the org raises the assignment floor", async () => {
    await seedCast()
    await configureAssignmentFloor(600)

    const res = await assign("dave", "2")
    expect(res.status).toBe(403)
    const body = (await res.json()) as {
      error: { details?: { requiredRole: number } }
    }
    expect(body.error.details?.requiredRole).toBe(600)
  })

  it("403s a caller with no role on the changeset's project", async () => {
    await seedCast()
    const res = await assign("mallory", "2")
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("permission_denied")
  })

  it("404s an absent changeset", async () => {
    await seedCast()
    const res = await assign("dave", "2", "cs-nope")
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("not_found")
  })

  it("400s a body that is neither a user id nor null", async () => {
    await seedCast()
    const res = await app.request(
      "/api/v2/changesets/cs-1/assign",
      {
        method: "POST",
        headers: authHeader(await jwtFor("dave")),
        body: JSON.stringify({ userId: 2 }),
      },
      env,
    )
    expect(res.status).toBe(400)
  })
})
