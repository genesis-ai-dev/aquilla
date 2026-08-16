// HTTP surface for the knowledge base (spec:
// docs/superpowers/specs/2026-08-07-knowledge-base-design.md). Covers upload
// floors, read floors (project + inherited org docs), org floors, validation,
// delete-cleans-R2, and reindex.
import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { ROLE } from "../types"

afterEach(() => vi.unstubAllGlobals())

/** Minimal in-memory R2 bucket — the PGlite test env has no R2 binding, so we
 *  inject one per request, same approach as agent-artifacts.test.ts. */
class FakeBucket {
  store = new Map<string, Uint8Array>()
  async put(key: string, value: Uint8Array): Promise<void> {
    this.store.set(key, value)
  }
  async get(key: string): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const bytes = this.store.get(key)
    if (!bytes) return null
    const copy = new Uint8Array(bytes)
    return { arrayBuffer: async () => copy.buffer as ArrayBuffer }
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

async function seedProject(projectId: string, createdBy: number, orgId?: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by, org_id) VALUES (?, ?, ?, ?)")
    .bind(projectId, "KB Project", createdBy, orgId ?? null)
    .run()
}

async function grant(projectId: string, userId: number, role: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(projectId, userId, role, userId)
    .run()
}

async function seedOrg(orgId: number, ownerId: number): Promise<void> {
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (?, ?, ?)")
    .bind(orgId, "KB Org", ownerId)
    .run()
}

async function grantOrg(orgId: number, userId: number, role: number, grantedBy: number): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
  )
    .bind(orgId, userId, role, grantedBy)
    .run()
}

function testEnvWith(bucket?: FakeBucket, extra?: Record<string, unknown>) {
  return { ...env, ...(bucket ? { SNAPSHOTS: bucket } : {}), ...(extra ?? {}) }
}

function stubIndexingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ docSummary: "sum", nodes: [] }) } }],
        }),
      ),
    ),
  )
}

async function uploadDoc(
  projectId: string,
  jwt: string,
  body: BodyInit | undefined,
  docName: string,
  bucket: FakeBucket,
  extra?: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    `/api/v2/projects/${projectId}/knowledge`,
    { method: "POST", headers: { ...authHeader(jwt), "x-doc-name": docName }, body },
    testEnvWith(bucket, extra),
  )
}

async function uploadOrgDoc(
  orgId: number,
  jwt: string,
  body: BodyInit | undefined,
  docName: string,
  bucket: FakeBucket,
  extra?: Record<string, unknown>,
): Promise<Response> {
  return app.request(
    `/api/v2/orgs/${orgId}/knowledge`,
    { method: "POST", headers: { ...authHeader(jwt), "x-doc-name": docName }, body },
    testEnvWith(bucket, extra),
  )
}

const PROJECT = "proj-kb"

describe("knowledge routes — project upload floor", () => {
  it("CONTRIBUTOR is rejected with 403", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contrib")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.CONTRIBUTOR)
    const jwt = await jwtFor("contrib")
    stubIndexingFetch()

    const res = await uploadDoc(
      PROJECT,
      jwt,
      new TextEncoder().encode("# Guide\nhello"),
      "guide.md",
      new FakeBucket(),
    )
    expect(res.status).toBe(403)
    const bodyJson = (await res.json()) as { error: { code: string } }
    expect(bodyJson.error.code).toBe("permission_denied")
  })

  it("PROJECT_LEAD uploads .md → 201, pending, row + R2 object exist", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.PROJECT_LEAD)
    const jwt = await jwtFor("lead")
    stubIndexingFetch()
    const bucket = new FakeBucket()

    const res = await uploadDoc(
      PROJECT,
      jwt,
      new TextEncoder().encode("# Guide\nhello world"),
      "guide.md",
      bucket,
      { OPENROUTER_API_KEY: "k" },
    )
    expect(res.status).toBe(201)
    const out = (await res.json()) as { doc: { id: string; indexStatus: string; r2Key: string } }
    expect(out.doc.indexStatus).toBe("pending")

    const row = await env.AQUILLA_PG.prepare("SELECT id, r2_key FROM knowledge_docs WHERE id = ?")
      .bind(out.doc.id)
      .first<{ id: string; r2_key: string }>()
    expect(row).not.toBeNull()
    expect(row!.r2_key).toBe(out.doc.r2Key)
    expect(bucket.store.has(out.doc.r2Key)).toBe(true)
  })

  it("ignores a spoofed Content-Type header; stored/served type derives from the extension", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.PROJECT_LEAD)
    const jwt = await jwtFor("lead")
    stubIndexingFetch()
    const bucket = new FakeBucket()

    const res = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge`,
      {
        method: "POST",
        headers: { ...authHeader(jwt), "x-doc-name": "guide.md", "content-type": "text/html" },
        body: new TextEncoder().encode("# Guide\nhello"),
      },
      testEnvWith(bucket, { OPENROUTER_API_KEY: "k" }),
    )
    expect(res.status).toBe(201)
    const out = (await res.json()) as { doc: { id: string; contentType: string | null } }
    expect(out.doc.contentType).toBe("text/markdown")

    const row = await env.AQUILLA_PG.prepare("SELECT content_type FROM knowledge_docs WHERE id = ?")
      .bind(out.doc.id)
      .first<{ content_type: string | null }>()
    expect(row!.content_type).toBe("text/markdown")

    const originalRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/${out.doc.id}/original`,
      { headers: authHeader(jwt) },
      testEnvWith(bucket),
    )
    expect(originalRes.status).toBe(200)
    expect(originalRes.headers.get("content-type")).toContain("text/markdown")
  })
})

describe("knowledge routes — viewer reads", () => {
  it("VIEWER can list/get/content/original/search; non-member gets 403 on all", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "lead")
    await seedUser(3, "viewer")
    await seedUser(4, "stranger")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.PROJECT_LEAD)
    await grant(PROJECT, 3, ROLE.VIEWER)
    const leadJwt = await jwtFor("lead")
    stubIndexingFetch()
    const bucket = new FakeBucket()

    const uploadRes = await uploadDoc(
      PROJECT,
      leadJwt,
      new TextEncoder().encode("# Guide\nfindable snippet text here"),
      "guide.md",
      bucket,
    )
    const { doc } = (await uploadRes.json()) as { doc: { id: string } }

    const viewerJwt = await jwtFor("viewer")
    const listRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge`,
      { headers: authHeader(viewerJwt) },
      testEnvWith(bucket),
    )
    expect(listRes.status).toBe(200)
    const listBody = (await listRes.json()) as { docs: { id: string }[] }
    expect(listBody.docs.some((d) => d.id === doc.id)).toBe(true)

    const getRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}`,
      { headers: authHeader(viewerJwt) },
      testEnvWith(bucket),
    )
    expect(getRes.status).toBe(200)
    const getBody = (await getRes.json()) as { doc: { id: string } }
    expect(getBody.doc.id).toBe(doc.id)

    const contentRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}/content`,
      { headers: authHeader(viewerJwt) },
      testEnvWith(bucket),
    )
    expect(contentRes.status).toBe(200)
    const contentBody = (await contentRes.json()) as { text: string }
    expect(contentBody.text).toContain("findable snippet text here")

    const originalRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}/original`,
      { headers: authHeader(viewerJwt) },
      testEnvWith(bucket),
    )
    expect(originalRes.status).toBe(200)
    const originalBytes = new Uint8Array(await originalRes.arrayBuffer())
    expect(new TextDecoder().decode(originalBytes)).toBe("# Guide\nfindable snippet text here")

    const searchRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/search?q=findable`,
      { headers: authHeader(viewerJwt) },
      testEnvWith(bucket),
    )
    expect(searchRes.status).toBe(200)
    const searchBody = (await searchRes.json()) as { snippets: { docId: string }[] }
    expect(searchBody.snippets.some((s) => s.docId === doc.id)).toBe(true)

    const strangerJwt = await jwtFor("stranger")
    for (const path of [
      `/api/v2/projects/${PROJECT}/knowledge`,
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}`,
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}/content`,
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}/original`,
      `/api/v2/projects/${PROJECT}/knowledge/search?q=findable`,
    ]) {
      const res = await app.request(path, { headers: authHeader(strangerJwt) }, testEnvWith(bucket))
      expect(res.status).toBe(403)
    }
  })
})

describe("knowledge routes — org inheritance", () => {
  it("org doc appears in project list as scope org; project viewer reads it; project lead delete → 403", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "maintainer")
    await seedUser(3, "lead")
    await seedOrg(10, 1)
    await grantOrg(10, 1, ROLE.OWNER, 1)
    await grantOrg(10, 2, ROLE.MAINTAINER, 1)
    await grantOrg(10, 3, ROLE.VIEWER, 1)
    await seedProject(PROJECT, 1, 10)
    await grant(PROJECT, 3, ROLE.PROJECT_LEAD)

    const maintainerJwt = await jwtFor("maintainer")
    stubIndexingFetch()
    const bucket = new FakeBucket()
    const uploadRes = await uploadOrgDoc(
      10,
      maintainerJwt,
      new TextEncoder().encode("# Org doc\norg-level content"),
      "org-guide.md",
      bucket,
    )
    expect(uploadRes.status).toBe(201)
    const { doc } = (await uploadRes.json()) as { doc: { id: string; scope: string } }
    expect(doc.scope).toBe("org")

    const leadJwt = await jwtFor("lead")
    const listRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge`,
      { headers: authHeader(leadJwt) },
      testEnvWith(bucket),
    )
    const listBody = (await listRes.json()) as { docs: { id: string; scope: string }[] }
    const found = listBody.docs.find((d) => d.id === doc.id)
    expect(found?.scope).toBe("org")

    const contentRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}/content`,
      { headers: authHeader(leadJwt) },
      testEnvWith(bucket),
    )
    expect(contentRes.status).toBe(200)
    const contentBody = (await contentRes.json()) as { text: string }
    expect(contentBody.text).toContain("org-level content")

    const deleteRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}`,
      { method: "DELETE", headers: authHeader(leadJwt) },
      testEnvWith(bucket),
    )
    expect(deleteRes.status).toBe(403)
    const deleteBody = (await deleteRes.json()) as { error: { code: string; message: string } }
    expect(deleteBody.error.code).toBe("permission_denied")
    expect(deleteBody.error.message).toBe("org documents are managed at the org level")
  })
})

describe("knowledge routes — org floors", () => {
  it("member below MAINTAINER → 403 on POST/DELETE; MAINTAINER → 201/200; non-member GET → 403", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "contributor")
    await seedUser(3, "maintainer")
    await seedUser(4, "stranger")
    await seedOrg(11, 1)
    await grantOrg(11, 1, ROLE.OWNER, 1)
    await grantOrg(11, 2, ROLE.CONTRIBUTOR, 1)
    await grantOrg(11, 3, ROLE.MAINTAINER, 1)
    stubIndexingFetch()
    const bucket = new FakeBucket()

    const contribJwt = await jwtFor("contributor")
    const forbiddenPost = await uploadOrgDoc(
      11,
      contribJwt,
      new TextEncoder().encode("x"),
      "f.md",
      bucket,
    )
    expect(forbiddenPost.status).toBe(403)

    const maintainerJwt = await jwtFor("maintainer")
    const okPost = await uploadOrgDoc(
      11,
      maintainerJwt,
      new TextEncoder().encode("x"),
      "f.md",
      bucket,
    )
    expect(okPost.status).toBe(201)
    const { doc } = (await okPost.json()) as { doc: { id: string } }

    const forbiddenDelete = await app.request(
      `/api/v2/orgs/11/knowledge/${doc.id}`,
      { method: "DELETE", headers: authHeader(contribJwt) },
      testEnvWith(bucket),
    )
    expect(forbiddenDelete.status).toBe(403)

    const okDelete = await app.request(
      `/api/v2/orgs/11/knowledge/${doc.id}`,
      { method: "DELETE", headers: authHeader(maintainerJwt) },
      testEnvWith(bucket),
    )
    expect(okDelete.status).toBe(200)

    const strangerJwt = await jwtFor("stranger")
    const nonMemberGet = await app.request(
      `/api/v2/orgs/11/knowledge`,
      { headers: authHeader(strangerJwt) },
      testEnvWith(bucket),
    )
    expect(nonMemberGet.status).toBe(403)
  })
})

describe("knowledge routes — validation", () => {
  async function setup() {
    await seedUser(1, "owner")
    await seedUser(2, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.PROJECT_LEAD)
    return await jwtFor("lead")
  }

  it("missing x-doc-name → 400", async () => {
    const jwt = await setup()
    stubIndexingFetch()
    const res = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge`,
      { method: "POST", headers: authHeader(jwt), body: new TextEncoder().encode("x") },
      testEnvWith(new FakeBucket()),
    )
    expect(res.status).toBe(400)
  })

  it("unsupported extension → 400", async () => {
    const jwt = await setup()
    stubIndexingFetch()
    const res = await uploadDoc(PROJECT, jwt, new TextEncoder().encode("x"), "a.exe", new FakeBucket())
    expect(res.status).toBe(400)
  })

  it("empty body → 400", async () => {
    const jwt = await setup()
    stubIndexingFetch()
    const res = await uploadDoc(PROJECT, jwt, undefined, "a.md", new FakeBucket())
    expect(res.status).toBe(400)
  })

  it(".docx body over 2 MB → 400", async () => {
    const jwt = await setup()
    stubIndexingFetch()
    const big = new Uint8Array(2_000_001)
    const res = await uploadDoc(PROJECT, jwt, big, "big.docx", new FakeBucket())
    expect(res.status).toBe(400)
  })

  it("extraction yielding empty text (garbage .docx bytes) → 422", async () => {
    const jwt = await setup()
    stubIndexingFetch()
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const res = await uploadDoc(PROJECT, jwt, garbage, "bad.docx", new FakeBucket())
    expect(res.status).toBe(422)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe("validation_failed")
  })
})

describe("knowledge routes — delete cleans R2", () => {
  it("DELETE → 200, row gone, R2 object gone", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.PROJECT_LEAD)
    const jwt = await jwtFor("lead")
    stubIndexingFetch()
    const bucket = new FakeBucket()

    const uploadRes = await uploadDoc(PROJECT, jwt, new TextEncoder().encode("# x\ny"), "a.md", bucket)
    const { doc } = (await uploadRes.json()) as { doc: { id: string; r2Key: string } }

    const deleteRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}`,
      { method: "DELETE", headers: authHeader(jwt) },
      testEnvWith(bucket),
    )
    expect(deleteRes.status).toBe(200)

    const row = await env.AQUILLA_PG.prepare("SELECT id FROM knowledge_docs WHERE id = ?")
      .bind(doc.id)
      .first()
    expect(row).toBeNull()
    expect(await bucket.get(doc.r2Key)).toBeNull()
  })
})

describe("knowledge routes — reindex", () => {
  it("POST reindex → 202, index_status returns to ready after the stubbed fetch resolves", async () => {
    await seedUser(1, "owner")
    await seedUser(2, "lead")
    await seedProject(PROJECT, 1)
    await grant(PROJECT, 2, ROLE.PROJECT_LEAD)
    const jwt = await jwtFor("lead")
    stubIndexingFetch()
    const bucket = new FakeBucket()

    const uploadRes = await uploadDoc(
      PROJECT,
      jwt,
      new TextEncoder().encode("# x\ny"),
      "a.md",
      bucket,
      { OPENROUTER_API_KEY: "k" },
    )
    const { doc } = (await uploadRes.json()) as { doc: { id: string } }

    const reindexRes = await app.request(
      `/api/v2/projects/${PROJECT}/knowledge/${doc.id}/reindex`,
      { method: "POST", headers: authHeader(jwt) },
      testEnvWith(bucket, { OPENROUTER_API_KEY: "k" }),
    )
    expect(reindexRes.status).toBe(202)

    await vi.waitFor(async () => {
      const row = await env.AQUILLA_PG.prepare("SELECT index_status FROM knowledge_docs WHERE id = ?")
        .bind(doc.id)
        .first<{ index_status: string }>()
      expect(row?.index_status).toBe("ready")
    })
  })
})
