// Server-to-server knowledge-base upload / list (AQU-1762) — the half of the
// Agent API's knowledge routes that lives here.
//
// What matters at this seam: the shared secret is the ONLY thing that proves the
// caller is sync-worker, `x-acting-user-id` names a person but grants nothing
// (the role is re-resolved live, at the in-app floors), and an upload that gets
// through runs the SAME uploader the in-app route does — so the doc is extracted,
// stored and queued for indexing rather than landing as a second, half-wired
// implementation.
import { env } from "cloudflare:test"
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import app from "../index"
import { seedUser } from "./helpers/db"
import { ROLE } from "../types"

afterEach(() => vi.unstubAllGlobals())

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

const SECRET = "sync-shared-secret"
const PROJECT = "proj-kb-internal"
const LEAD_ID = 8101
const VIEWER_ID = 8102
/** A real user with no grant path at all — not a member, not the creator. */
const OUTSIDER_ID = 8103

let bucket: FakeBucket

function testEnv(extra?: Record<string, unknown>) {
  return { ...env, SNAPSHOTS: bucket, SYNC_SECRET_KEY: SECRET, ...(extra ?? {}) }
}

/** The indexing job fires off the upload and calls OpenRouter; stub it so the
 *  test exercises the upload, not the model. */
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

async function internalPost(
  body: BodyInit | undefined,
  opts: { secret?: string | null; actingUserId?: string | null; docName?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {}
  const secret = opts.secret === undefined ? SECRET : opts.secret
  if (secret !== null) headers.Authorization = `Bearer ${secret}`
  const acting = opts.actingUserId === undefined ? String(LEAD_ID) : opts.actingUserId
  if (acting !== null) headers["x-acting-user-id"] = acting
  const docName = opts.docName === undefined ? "guide.md" : opts.docName
  if (docName !== null) headers["x-doc-name"] = encodeURIComponent(docName)
  return app.request(
    `/api/v2/internal/projects/${PROJECT}/knowledge`,
    { method: "POST", headers, body },
    testEnv(),
  )
}

async function internalList(actingUserId: number | string = LEAD_ID, secret = SECRET): Promise<Response> {
  return app.request(
    `/api/v2/internal/projects/${PROJECT}/knowledge`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}`, "x-acting-user-id": String(actingUserId) },
    },
    testEnv(),
  )
}

beforeEach(async () => {
  bucket = new FakeBucket()
  await seedUser(LEAD_ID, "kb-lead")
  await seedUser(VIEWER_ID, "kb-viewer")
  await seedUser(OUTSIDER_ID, "kb-outsider")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, created_by, org_id) VALUES (?, ?, ?, NULL)",
  )
    .bind(PROJECT, "KB Internal Project", LEAD_ID)
    .run()
  for (const [userId, role] of [
    [LEAD_ID, ROLE.PROJECT_LEAD],
    [VIEWER_ID, ROLE.VIEWER],
  ] as const) {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
    )
      .bind(PROJECT, userId, role, LEAD_ID)
      .run()
  }
})

describe("POST /api/v2/internal/projects/:projectId/knowledge", () => {
  it("refuses a missing or wrong shared secret", async () => {
    stubIndexingFetch()
    expect((await internalPost("# Style guide\n", { secret: null })).status).toBe(401)
    expect((await internalPost("# Style guide\n", { secret: "not-it" })).status).toBe(401)
    expect(bucket.store.size).toBe(0)
  })

  it("requires x-acting-user-id — the secret alone names nobody", async () => {
    stubIndexingFetch()
    const res = await internalPost("# Style guide\n", { actingUserId: null })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("validation_failed")
    expect(bucket.store.size).toBe(0)
  })

  it("refuses an acting user below the in-app PROJECT_LEAD floor", async () => {
    stubIndexingFetch()
    const res = await internalPost("# Style guide\n", { actingUserId: String(VIEWER_ID) })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("permission_denied")
    expect(bucket.store.size).toBe(0)
  })

  it("refuses a non-member even with a valid secret", async () => {
    stubIndexingFetch()
    expect((await internalPost("# Style guide\n", { actingUserId: String(OUTSIDER_ID) })).status).toBe(403)
  })

  it("refuses an archived project (the live role resolver returns null for one)", async () => {
    stubIndexingFetch()
    await env.AQUILLA_PG.prepare("UPDATE projects SET archived_at = now() WHERE id = ?")
      .bind(PROJECT)
      .run()
    expect((await internalPost("# Style guide\n")).status).toBe(403)
    expect(bucket.store.size).toBe(0)
  })

  it("stores the doc under the acting user and makes it listable", async () => {
    stubIndexingFetch()
    const res = await internalPost("# Style guide\n\nPrefer active voice.\n")
    expect(res.status).toBe(201)
    const { doc } = (await res.json()) as {
      doc: { id: string; name: string; createdBy: string; sizeBytes: number; contentType: string }
    }
    expect(doc.name).toBe("guide.md")
    // created_by is the acting user's username, exactly as the in-app upload records it.
    expect(doc.createdBy).toBe("kb-lead")
    expect(doc.contentType).toBe("text/markdown")
    expect(bucket.store.size).toBe(1)

    const text = await env.AQUILLA_PG.prepare(
      "SELECT extracted_text FROM knowledge_docs WHERE id = ?",
    )
      .bind(doc.id)
      .first<{ extracted_text: string }>()
    expect(text?.extracted_text).toContain("Prefer active voice.")
  })

  it("passes the upstream extension refusal through as validation_failed", async () => {
    stubIndexingFetch()
    const res = await internalPost("binary", { docName: "bible.usfm" })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe("validation_failed")
    expect(body.error.message).toContain("unsupported file extension")
  })
})

// The two halves of this feature live in separate worker packages with separate
// runtimes, so no unit test can run sync-worker's bridge against this route for
// real — that composition is only reachable from the e2e stack, and a PR preview
// cannot even do that (a preview sync-worker cannot call a preview auth-worker;
// see docs/DEPLOYMENT-ENVIRONMENTS.md "Preview limitations"). What CAN be pinned
// here is the wire contract itself: the exact request
// sync-worker/src/external/knowledge-bridge.ts builds. If either side renames a
// header or drops the encoding, this fails instead of the feature failing
// silently in production.
describe("the wire contract sync-worker's knowledge bridge sends", () => {
  it("accepts the bridge's exact request and stores the decoded name", async () => {
    stubIndexingFetch()
    // Arabic name — the case that motivated AQU-1762. Headers are ByteString-only,
    // so the bridge percent-encodes; this route must decode it back.
    const name = "فان دايك.txt"
    const res = await app.request(
      `/api/v2/internal/projects/${PROJECT}/knowledge`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SECRET}`,
          "x-acting-user-id": String(LEAD_ID),
          "x-doc-name": encodeURIComponent(name),
          "Content-Type": "application/octet-stream",
        },
        body: new TextEncoder().encode("في البدء خلق الله السماوات والأرض"),
      },
      testEnv(),
    )

    expect(res.status).toBe(201)
    const { doc } = (await res.json()) as { doc: { id: string; name: string; contentType: string } }
    expect(doc.name).toBe(name)
    // Stored content type comes from the validated extension, never from the
    // octet-stream header the bridge sends.
    expect(doc.contentType).toBe("text/plain")

    const row = await env.AQUILLA_PG.prepare("SELECT name FROM knowledge_docs WHERE id = ?")
      .bind(doc.id)
      .first<{ name: string }>()
    expect(row?.name).toBe(name)
  })
})

describe("GET /api/v2/internal/projects/:projectId/knowledge", () => {
  it("refuses a wrong secret", async () => {
    expect((await internalList(LEAD_ID, "not-it")).status).toBe(401)
  })

  it("lists at the VIEWER floor and reports nodeCount so an agent can verify indexing", async () => {
    stubIndexingFetch()
    const uploaded = await internalPost("# A\n\nalpha\n\n# B\n\nbeta\n")
    expect(uploaded.status).toBe(201)

    const res = await internalList(VIEWER_ID)
    expect(res.status).toBe(200)
    const { docs } = (await res.json()) as {
      docs: { name: string; indexStatus: string; nodeCount: number; sizeBytes: number }[]
    }
    expect(docs).toHaveLength(1)
    expect(docs[0].name).toBe("guide.md")
    expect(docs[0].sizeBytes).toBeGreaterThan(0)
    expect(["pending", "ready", "failed"]).toContain(docs[0].indexStatus)
    expect(typeof docs[0].nodeCount).toBe("number")
  })

  it("refuses a non-member", async () => {
    expect((await internalList(OUTSIDER_ID)).status).toBe(403)
  })
})
