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
  commands?: unknown[]
}

const DEFAULT_DIGEST = "sha256:deadbeef"

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

/** A one-cell translation plan: floor CONTRIBUTOR (400) via requiredRoleForCommand. */
const SET_TRANSLATION_PLAN = [
  { kind: "SetTranslation", fileId: "file-1", cellId: "c-a", value: "New draft" },
]

/** A structural plan: floor PROJECT_LEAD (500). */
const PLAN_IMPORT_PLAN = [
  { kind: "PlanImport", fileName: "genesis.usfm", fileType: "usfm", cells: [{ content: "v1" }] },
]

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
     VALUES (?, ?, ?, ?, 'ask', ?, ?::jsonb, '[]'::jsonb, ?::jsonb, ?, ?)`,
  )
    .bind(
      args.id,
      args.projectId,
      String(args.createdByUserId),
      args.credentialId,
      args.status ?? "staged",
      JSON.stringify(args.commands ?? []),
      JSON.stringify({ translationsAdded: 3, translationsModified: 1, warnings: [] }),
      args.digest ?? DEFAULT_DIGEST,
      expiresAt.toISOString(),
    )
    .run()
}

async function seedFile(projectId: string, fileId: string, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO files (id, project_id, name, event_id) VALUES (?, ?, ?, ?)",
  )
    .bind(fileId, projectId, name, crypto.randomUUID())
    .run()
}

async function seedCell(args: {
  projectId: string
  fileId: string
  cellId: string
  side: "source" | "target"
  value: string
  canonicalRef?: string
  targetLang?: string
}): Promise<void> {
  await env.AQUILLA_PG.prepare(
    `INSERT INTO cells
        (project_id, file_id, cell_id, side, value, canonical_ref, event_id, last_edit_at, target_lang)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      args.projectId,
      args.fileId,
      args.cellId,
      args.side,
      args.value,
      args.canonicalRef ?? null,
      crypto.randomUUID(),
      NOW,
      args.targetLang ?? "",
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

  it("returns per-cell before/after changes for SetTranslation commands", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedFile("proj-1", "file-1", "Genesis")
    // Cell A has an existing target (a modification); cell B has none (new).
    await seedCell({ projectId: "proj-1", fileId: "file-1", cellId: "c-a", side: "source", value: "In the beginning", canonicalRef: "GEN 1:1" })
    await seedCell({ projectId: "proj-1", fileId: "file-1", cellId: "c-a", side: "target", value: "Old draft" })
    await seedCell({ projectId: "proj-1", fileId: "file-1", cellId: "c-b", side: "source", value: "And the earth", canonicalRef: "GEN 1:2" })
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      commands: [
        { kind: "SetTranslation", fileId: "file-1", cellId: "c-a", value: "New draft A" },
        { kind: "SetTranslation", fileId: "file-1", cellId: "c-b", value: "New draft B" },
      ],
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      changes: {
        total: number
        truncated: boolean
        items: {
          fileId: string
          fileName: string | null
          cellId: string
          canonicalRef: string | null
          source: string | null
          before: string | null
          after: string
        }[]
      }
    }
    expect(body.changes.total).toBe(2)
    expect(body.changes.truncated).toBe(false)
    expect(body.changes.items).toEqual([
      {
        fileId: "file-1",
        fileName: "Genesis",
        cellId: "c-a",
        canonicalRef: "GEN 1:1",
        source: "In the beginning",
        before: "Old draft",
        after: "New draft A",
      },
      {
        fileId: "file-1",
        fileName: "Genesis",
        cellId: "c-b",
        canonicalRef: "GEN 1:2",
        source: "And the earth",
        before: null,
        after: "New draft B",
      },
    ])
  })

  it("lane-scopes the before value and reports laneId", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedFile("proj-1", "file-1", "Genesis")
    await seedCell({ projectId: "proj-1", fileId: "file-1", cellId: "c-a", side: "source", value: "Source" })
    await seedCell({ projectId: "proj-1", fileId: "file-1", cellId: "c-a", side: "target", value: "Default-lane draft" })
    await seedCell({ projectId: "proj-1", fileId: "file-1", cellId: "c-a", side: "target", value: "Spanish draft", targetLang: "es" })
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      commands: [{ kind: "SetTranslation", fileId: "file-1", cellId: "c-a", value: "Nuevo", laneId: "es" }],
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      changes: { items: { laneId?: string; before: string | null; after: string }[] }
    }
    expect(body.changes.items[0]).toMatchObject({
      laneId: "es",
      before: "Spanish draft",
      after: "Nuevo",
    })
  })

  it("returns a sample preview for a PlanImport command", async () => {
    await seedUser(1, "alice")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      commands: [
        {
          kind: "PlanImport",
          fileName: "genesis.usfm",
          fileType: "usfm",
          cells: Array.from({ length: 25 }, (_, i) => ({
            content: `Verse ${i + 1}`,
            canonicalRef: `GEN 1:${i + 1}`,
          })),
        },
      ],
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      importPreview: {
        fileName: string
        fileType: string
        totalCells: number
        sampleCells: { canonicalRef: string | null; content: string }[]
      }
    }
    expect(body.importPreview.fileName).toBe("genesis.usfm")
    expect(body.importPreview.fileType).toBe("usfm")
    expect(body.importPreview.totalCells).toBe(25)
    expect(body.importPreview.sampleCells).toHaveLength(10)
    expect(body.importPreview.sampleCells[0]).toEqual({ canonicalRef: "GEN 1:1", content: "Verse 1" })
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

  it("403s a caller with no role on the changeset's project", async () => {
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

  it("403s and hides cell content when the owning user is no longer a project member", async () => {
    // Alice owns/created the project; Mallory staged the changeset from a
    // credential while she still had project access, but has since been
    // removed (no project_members row, no group/org grant, not the project
    // creator). created_by_user_id alone must not resurrect access to the
    // project's cell content.
    await seedUser(1, "alice")
    await seedUser(2, "mallory")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(2)
    await seedFile("proj-1", "file-1", "Genesis")
    await seedCell({ projectId: "proj-1", fileId: "file-1", cellId: "c-a", side: "source", value: "Secret source text" })
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 2,
      credentialId: credId,
      commands: [{ kind: "SetTranslation", fileId: "file-1", cellId: "c-a", value: "Secret translation" }],
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("mallory")) },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("permission_denied")
    expect(JSON.stringify(body)).not.toMatch(/Secret/)
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

  it("403s a caller with no role on the changeset's project", async () => {
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

  it("403s when the owning user is no longer a project member", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "mallory")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(2)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 2, credentialId: credId })

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

    const count = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*)::int AS n FROM changeset_confirmations WHERE changeset_id = ?",
    )
      .bind("cs-1")
      .first<{ n: number }>()
    expect(count?.n).toBe(0)
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

  it("403s when the owning user is no longer a project member", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "mallory")
    await seedProject("proj-1", "Blackfoot", 1)
    const credId = await seedCredential(2)
    await seedChangeset({ id: "cs-1", projectId: "proj-1", createdByUserId: 2, credentialId: credId })

    const res = await app.request(
      "/api/v2/changesets/cs-1/reject",
      { method: "POST", headers: authHeader(await jwtFor("mallory")) },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("permission_denied")

    const row = await env.AQUILLA_PG.prepare("SELECT status FROM changesets WHERE id = ?")
      .bind("cs-1")
      .first<{ status: string }>()
    expect(row?.status).toBe("staged")
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

// ──────────────────────────────────────────────────────────────────────────
// AQU-CMDREG-P1 §2.1 — approval is AUTHORITY, not identity.
//
// The gate is the caller's LIVE project role vs the floor recomputed from the
// changeset's stored commands. The creator is neither privileged nor excluded:
// a colleague who holds the floor may approve, and a creator whose role has
// since dropped may not. An agent still cannot approve anything — every route
// here needs a browser session.
// ──────────────────────────────────────────────────────────────────────────

describe("changeset approval authority (role floor, not creator identity)", () => {
  /** alice (1) creates the project (creator ⇒ 700) and stages the plan;
   *  bob (2), carol (3) and dave (4) get explicit grants; mallory (9) none. */
  async function seedCast(commands: unknown[]): Promise<string> {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    await seedUser(3, "carol")
    await seedUser(4, "dave")
    await seedUser(9, "mallory")
    await seedProject("proj-1", "Blackfoot", 1)
    await grant("proj-1", 2, 400) // contributor
    await grant("proj-1", 3, 300) // reviewer
    await grant("proj-1", 4, 500) // project lead
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      commands,
    })
    return credId
  }

  it("lets a non-creator who holds the floor view the approval", async () => {
    await seedCast(SET_TRANSLATION_PLAN)

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { changesetId: string; assignedToUserId: string | null }
    expect(body.changesetId).toBe("cs-1")
    expect(body.assignedToUserId).toBeNull()
  })

  it("lets a non-creator who holds the floor approve — stamping the approving human", async () => {
    const credId = await seedCast(SET_TRANSLATION_PLAN)

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ digest: DEFAULT_DIGEST }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { confirmationId: string; expiresAt: string }
    expect(body.confirmationId).toBeTruthy()

    // The confirmation records the human who approved (bob), on the
    // changeset's own credential — unchanged minting behaviour.
    const row = await env.AQUILLA_PG.prepare(
      "SELECT user_id, credential_id, digest, consumed_at FROM changeset_confirmations WHERE id = ?",
    )
      .bind(body.confirmationId)
      .first<{ user_id: string; credential_id: string; digest: string; consumed_at: string | null }>()
    expect(row).toMatchObject({
      user_id: "2",
      credential_id: credId,
      digest: DEFAULT_DIGEST,
      consumed_at: null,
    })
  })

  it("still requires the digest from a non-creator approver", async () => {
    await seedCast(SET_TRANSLATION_PLAN)

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ digest: "sha256:wrong" }),
      },
      env,
    )
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details?: { code: string } } }
    expect(body.error.code).toBe("validation_failed")
    expect(body.error.details?.code).toBe("digest_mismatch")

    const count = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*)::int AS n FROM changeset_confirmations WHERE changeset_id = ?",
    )
      .bind("cs-1")
      .first<{ n: number }>()
    expect(count?.n).toBe(0)
  })

  it("lets a non-creator who holds the floor reject", async () => {
    await seedCast(SET_TRANSLATION_PLAN)

    const res = await app.request(
      "/api/v2/changesets/cs-1/reject",
      { method: "POST", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT status FROM changesets WHERE id = ?")
      .bind("cs-1")
      .first<{ status: string }>()
    expect(row?.status).toBe("discarded")
  })

  it("403s a member below the floor on view, approve and reject", async () => {
    await seedCast(SET_TRANSLATION_PLAN) // floor 400; carol is 300

    const jwt = await jwtFor("carol")
    const view = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(jwt) },
      env,
    )
    expect(view.status).toBe(403)
    const viewBody = (await view.json()) as { error: { code: string; details?: { requiredRole: number } } }
    expect(viewBody.error.code).toBe("permission_denied")
    expect(viewBody.error.details?.requiredRole).toBe(400)

    const approve = await app.request(
      "/api/v2/changesets/cs-1/approve",
      { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ digest: DEFAULT_DIGEST }) },
      env,
    )
    expect(approve.status).toBe(403)

    const reject = await app.request(
      "/api/v2/changesets/cs-1/reject",
      { method: "POST", headers: authHeader(jwt) },
      env,
    )
    expect(reject.status).toBe(403)

    const row = await env.AQUILLA_PG.prepare("SELECT status FROM changesets WHERE id = ?")
      .bind("cs-1")
      .first<{ status: string }>()
    expect(row?.status).toBe("staged")
  })

  it("raises the floor for a structural plan — PlanImport needs PROJECT_LEAD", async () => {
    await seedCast(PLAN_IMPORT_PLAN)

    const contributor = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(contributor.status).toBe(403)
    const denied = (await contributor.json()) as { error: { details?: { requiredRole: number } } }
    expect(denied.error.details?.requiredRole).toBe(500)

    const lead = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("dave")) },
      env,
    )
    expect(lead.status).toBe(200)
  })

  it("403s the CREATOR once their live role drops below the floor", async () => {
    // dave (4) owns the project; bob (2) staged the plan and is only a
    // REVIEWER now — the whole reason the check is live rather than stored.
    await seedUser(2, "bob")
    await seedUser(4, "dave")
    await seedProject("proj-1", "Blackfoot", 4)
    await grant("proj-1", 2, 300)
    const credId = await seedCredential(2)
    await seedChangeset({
      id: "cs-1",
      projectId: "proj-1",
      createdByUserId: 2,
      credentialId: credId,
      commands: SET_TRANSLATION_PLAN,
    })

    const res = await app.request(
      "/api/v2/changesets/cs-1/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("bob")),
        body: JSON.stringify({ digest: DEFAULT_DIGEST }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("permission_denied")
  })

  it("403s an OWNER of a different project (cross-tenant regression)", async () => {
    await seedCast(SET_TRANSLATION_PLAN)
    // mallory owns proj-2 outright; that buys her nothing on proj-1's plan.
    await seedProject("proj-2", "Other", 9)

    const res = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("mallory")) },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("permission_denied")
  })

  it("404s an absent changeset without leaking whether one exists elsewhere", async () => {
    await seedCast(SET_TRANSLATION_PLAN)

    const res = await app.request(
      "/api/v2/changesets/cs-nope/approval",
      { method: "GET", headers: authHeader(await jwtFor("bob")) },
      env,
    )
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("not_found")
  })

  it("keeps the creator rule for a project-creation plan (the project does not exist yet)", async () => {
    // A CreateProject changeset is filed under a project id that has no row
    // until commit, so no project role can resolve against it — a floor check
    // alone would deny everyone, including the person who staged it.
    await seedUser(1, "alice")
    await seedUser(9, "mallory")
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-new",
      projectId: "proj-not-yet",
      createdByUserId: 1,
      credentialId: credId,
      commands: [{ kind: "CreateProject", name: "Fresh", projectId: "proj-not-yet" }],
    })

    const creator = await app.request(
      "/api/v2/changesets/cs-new/approval",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(creator.status).toBe(200)
    const body = (await creator.json()) as { projectId: string; projectName: string | null }
    expect(body).toMatchObject({ projectId: "proj-not-yet", projectName: null })

    const stranger = await app.request(
      "/api/v2/changesets/cs-new/approval",
      { method: "GET", headers: authHeader(await jwtFor("mallory")) },
      env,
    )
    expect(stranger.status).toBe(403)
    const denied = (await stranger.json()) as { error: { code: string; message: string } }
    expect(denied.error.code).toBe("permission_denied")
    // AQU-1235 widened this carve-out from project-creation to every org-level
    // plan (org-membership commands join it), so the message names that class.
    expect(denied.error.message).toMatch(/org-level plan/i)
  })

  it("keeps the creator rule for an org-membership plan (AQU-1235)", async () => {
    // An AddOrgMember plan is filed under a project id it has nothing to do
    // with — its real gate is the caller's org role, re-checked at commit. A
    // project-role floor here would be the wrong question entirely, and a
    // stranger holding a role on that project must not inherit approval rights.
    await seedUser(1, "alice")
    await seedUser(9, "mallory")
    await seedProject("proj-1", "P1", 1)
    await grant("proj-1", 9, 700)
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-org",
      projectId: "proj-1",
      createdByUserId: 1,
      credentialId: credId,
      commands: [{ kind: "AddOrgMember", orgId: 5, username: "bob", role: 400 }],
    })

    const creator = await app.request(
      "/api/v2/changesets/cs-org/approval",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(creator.status).toBe(200)

    // mallory is an OWNER on proj-1 — irrelevant to an org-level plan.
    const stranger = await app.request(
      "/api/v2/changesets/cs-org/approval",
      { method: "GET", headers: authHeader(await jwtFor("mallory")) },
      env,
    )
    expect(stranger.status).toBe(403)
    const denied = (await stranger.json()) as { error: { code: string; message: string } }
    expect(denied.error.code).toBe("permission_denied")
    expect(denied.error.message).toMatch(/org-level plan/i)
  })

  it("lets the creator of a project-creation plan approve and mint the confirmation", async () => {
    await seedUser(1, "alice")
    const credId = await seedCredential(1)
    await seedChangeset({
      id: "cs-new",
      projectId: "proj-not-yet",
      createdByUserId: 1,
      credentialId: credId,
      commands: [{ kind: "CreateProject", name: "Fresh", projectId: "proj-not-yet" }],
    })

    const res = await app.request(
      "/api/v2/changesets/cs-new/approve",
      {
        method: "POST",
        headers: authHeader(await jwtFor("alice")),
        body: JSON.stringify({ digest: DEFAULT_DIGEST }),
      },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { confirmationId: string }
    expect(body.confirmationId).toBeTruthy()
  })

  it("fails CLOSED when the stored commands are unreadable — owner only", async () => {
    await seedCast([{ kind: "NotACommandKind" }])
    await grant("proj-1", 9, 600) // mallory: maintainer, still below OWNER

    const maintainer = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("mallory")) },
      env,
    )
    expect(maintainer.status).toBe(403)
    const denied = (await maintainer.json()) as { error: { details?: { requiredRole: number } } }
    expect(denied.error.details?.requiredRole).toBe(700)

    const owner = await app.request(
      "/api/v2/changesets/cs-1/approval",
      { method: "GET", headers: authHeader(await jwtFor("alice")) },
      env,
    )
    expect(owner.status).toBe(200)
  })
})
