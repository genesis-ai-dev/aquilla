import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const NOW = Date.now()

interface SeedChangesetArgs {
  id: string
  projectId: string
  createdByUserId: number
  credentialId: string
  status?: "staged" | "committed" | "discarded" | "stale" | "expired"
  digest?: string
  expiresAt?: Date
}

const DEFAULT_DIGEST = "sha256:deadbeef"

async function seedProject(id: string, name: string, createdBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
  )
    .bind(id, name, createdBy)
    .run()
}

/** api_credentials.id is a real UUID column — mint one and return it. */
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

async function seedChangeset(args: SeedChangesetArgs): Promise<void> {
  const expiresAt = args.expiresAt ?? new Date(NOW + 60 * 60 * 1000)
  await env.AQUILLA_PG.prepare(
    `INSERT INTO changesets
        (id, project_id, created_by_user_id, credential_id, autonomy_mode, status,
         commands, preconditions, summary, digest, expires_at)
     VALUES (?, ?, ?, ?, 'ask', ?, '[]'::jsonb, '[]'::jsonb, ?::jsonb, ?, ?)`,
  )
    .bind(
      args.id,
      args.projectId,
      String(args.createdByUserId),
      args.credentialId,
      args.status ?? "staged",
      JSON.stringify({ translationsAdded: 3, translationsModified: 1, warnings: [] }),
      args.digest ?? DEFAULT_DIGEST,
      expiresAt.toISOString(),
    )
    .run()
}

async function seedConfirmation(
  changesetId: string,
  userId: number,
  credentialId: string,
  digest = DEFAULT_DIGEST,
  consumed = false,
): Promise<string> {
  const id = crypto.randomUUID()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO changeset_confirmations
        (id, changeset_id, user_id, credential_id, digest, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      changesetId,
      String(userId),
      credentialId,
      digest,
      new Date(NOW + 15 * 60 * 1000).toISOString(),
      consumed ? new Date(NOW).toISOString() : null,
    )
    .run()
  return id
}

describe("GET /api/v2/changesets/:id/approval", () => {
  it("returns the summary facts for the owning user", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 1, credentialId: credId })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      changesetId: string
      projectId: string
      projectName: string
      status: string
      autonomyMode: string
      digest: string
      summary: { translationsAdded: number }
    }
    expect(body).toMatchObject({
      changesetId: "cs-1",
      projectId: "proj-1",
      projectName: "Blackfoot",
      status: "staged",
      autonomyMode: "ask",
      digest: DEFAULT_DIGEST,
    })
    expect(body.summary.translationsAdded).toBe(3)
  })

  it("404s for an absent changeset", async () => {
    await seedUser(1, "alice")
    const res = await app.request(
      "/api/v2/changesets/nope/approval",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("not_found")
  })

  it("403s for a user who doesn't own the changeset's credential", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "mallory")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 1, credentialId: credId })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("mallory")) },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("permission_denied")
  })
})

describe("POST /api/v2/changesets/:id/approve", () => {
  it("mints a one-time confirmation on the happy path", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 1, credentialId: credId })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ digest: DEFAULT_DIGEST }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { confirmationId: string; expiresAt: string }
    expect(body.confirmationId).toBeTruthy()
    expect(body.expiresAt).toBeTruthy()

    const row = await env.AQUILLA_PG.prepare(
      "SELECT changeset_id, user_id, credential_id, digest, consumed_at FROM changeset_confirmations WHERE id = ?",
    )
      .bind(body.confirmationId)
      .first<{
        changeset_id: string
        user_id: string
        credential_id: string
        digest: string
        consumed_at: string | null
      }>()
    expect(row).toMatchObject({
      changeset_id: "cs-1",
      user_id: "1",
      credential_id: credId,
      digest: DEFAULT_DIGEST,
      consumed_at: null,
    })
  })

  it("403s when the caller isn't the changeset's owning user", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "mallory")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 1, credentialId: credId })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("mallory")),
        body: JSON.stringify({ digest: DEFAULT_DIGEST }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("permission_denied")
  })

  it("409s on digest mismatch", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 1, credentialId: credId })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ digest: "sha256:wrong" }),
      },
      env,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details?: { code: string } } }
    expect(body.error.code).toBe("validation_failed")
    expect(body.error.details?.code).toBe("digest_mismatch")
  })

  it("409s when the changeset is already committed", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      status: "committed",
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ digest: DEFAULT_DIGEST }),
      },
      env,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation_failed")
  })

  it("rejects an expired changeset", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      expiresAt: new Date(NOW - 60 * 1000),
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ digest: DEFAULT_DIGEST }),
      },
      env,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("validation_failed")
    expect(body.error.message).toMatch(/expired/i)
  })

  it("is idempotent — a second approve returns the same unconsumed confirmation", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 1, credentialId: credId })
    const existingId = await seedConfirmation("cs-1", 1, credId)

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ digest: DEFAULT_DIGEST }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { confirmationId: string }
    expect(body.confirmationId).toBe(existingId)

    const count = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*)::int AS n FROM changeset_confirmations WHERE changeset_id = ?",
    )
      .bind("cs-1")
      .first<{ n: number }>()
    expect(count?.n).toBe(1)
  })
})

describe("POST /api/v2/changesets/:id/reject", () => {
  it("flips a staged changeset to discarded", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 1, credentialId: credId })

    const res = await app.request(
      "/api/v2/changesets/cs-1/reject",
      { method: "POST", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe("discarded")

    const row = await env.AQUILLA_PG.prepare("SELECT status FROM changesets WHERE id = ?")
      .bind("cs-1")
      .first<{ status: string }>()
    expect(row?.status).toBe("discarded")
  })

  it("is idempotent when already discarded", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      status: "discarded",
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/reject",
      { method: "POST", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe("discarded")
  })

  it("409s when the changeset is already committed", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      status: "committed",
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/reject",
      { method: "POST", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation_failed")
  })
})
