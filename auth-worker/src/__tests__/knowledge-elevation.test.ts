// OPSEC review 2026-11-23 (OPS-58): the knowledge-base routers' upload /
// delete / reindex floors are satisfied by platform-admin power alone, on
// every project and every org on the platform.
//
// `resolveProjectRole` contributes { source: "platform", level: 700 } for
// every platform operator and ROLE.PROJECT_LEAD is 500, so
// `role.level < ROLE.PROJECT_LEAD` is false by definition for an un-elevated
// admin JWT. `getEffectiveOrgRole` returns Math.max(membership ?? 0, 700) for
// the same principal and ROLE.MAINTAINER is 600, so the org side is open too.
// All six writes on the two routers passed.
//
// Why this router is worse than "six more un-gated writes":
//
//   1. A knowledge doc is RETRIEVED CONTENT, not a setting. It is indexed into
//      `knowledge_docs.extracted_text` and served back by `searchKnowledge`
//      and the section-tree reads, and `extractStyleRulesFromDoc`
//      (src/lib/rules/style-rule-extractor.ts) feeds those sections to a
//      completion that proposes the project's own style rules. An operator
//      who can plant a document plants text the tenant's own tooling later
//      reads back as the team's guidance.
//   2. The doc REPLICATES ITSELF ACROSS TENANTS. Both writes call
//      `propagateKnowledgeDocs` (db/shared/inherited-settings.ts), which walks
//      `listLiveDownstreams` — `WHERE source_project_id = ? AND
//      source_link_mode = 'live'`, with NO org predicate — and copies the row
//      AND its R2 blob into every receiving downstream, transitively to
//      MAX_CHAIN = 16. One un-elevated POST therefore lands in projects in
//      orgs the operator never named. This is the shape OPS-44 named for a
//      PAT, OPS-49 for an integration link, OPS-51 for a source link, OPS-53
//      for a termbase subscription and OPS-56 for a lane grant, a SIXTH time
//      — and the first where the artefact makes copies of itself, so revoking
//      the operator's access reaches none of them.
//   3. The DELETE is irreversible and takes the bytes with it. `handleDelete`
//      drops the row, then `bucket.delete(meta.r2Key)` destroys the original
//      upload — the tenant's only copy — and propagation then deletes every
//      downstream copy too.
//
// The rule under test: on these SIX writes, platform power is stripped unless
// the session is elevated, then each route's own floor is re-applied to what
// genuinely remains. The READS are deliberately left open — AQU-2003 priced
// un-elevated platform access as read-only on our own content, not refused,
// and 11-09/11-16 kept reads open on the same grounds.
//
// Base test allowlist is ADMIN_EMAILS=root@example.com (pg-test-env), so the
// seeded "root" user is the platform admin.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { ROLE } from "../types"

const ROOT_ID = 7

const sql = (query: string, ...binds: unknown[]) =>
  env.AQUILLA_PG.prepare(query)
    .bind(...binds)
    .run()

/** Minimal in-memory R2 bucket — the PGlite test env has no R2 binding, so we
 *  inject one per request, same approach as knowledge-routes.test.ts. */
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

let bucket: FakeBucket

const testEnv = () => ({ ...env, SNAPSHOTS: bucket })

function stubIndexingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ docSummary: "sum", nodes: [] }) } }],
          }),
        ),
    ),
  )
}

beforeEach(async () => {
  env.ADMIN_REQUIRE_ELEVATION = "true"
  bucket = new FakeBucket()
  stubIndexingFetch()

  await seedUser(1, "tenant-owner")
  await seedUser(2, "tenant-lead")
  await seedUser(3, "tenant-contributor")
  await seedUser(ROOT_ID, "root")

  // Org 1 is the tenant root reaches ONLY through platform power.
  // Org 2 is root's own, where they hold a genuine grant — the control.
  // Org 3 owns the DOWNSTREAM project, to show the copy crosses orgs.
  await sql(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES
       (1, 'Tenant Org', 1), (2, 'Root Org', ?), (3, 'Third Org', 1)`,
    ROOT_ID,
  )
  await sql(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
       (1, 1, 700, 1), (1, 2, 500, 1), (1, 3, 400, 1), (2, ?, 600, ?)`,
    ROOT_ID,
    ROOT_ID,
  )
  await sql(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('kb', 'Tenant KB', 1, 1),
       ('root-kb', 'Root KB', 2, ?)`,
    ROOT_ID,
  )
  // root's GENUINE lead grant on their own org's project. Without this the
  // de-escalated answer would be null and the controls below could not tell
  // "narrowed correctly" from "locked the operator out of their own work".
  await sql(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
       ('kb', 2, ?, 1), ('kb', 3, ?, 1), ('root-kb', ?, ?, ?)`,
    ROLE.PROJECT_LEAD,
    ROLE.CONTRIBUTOR,
    ROOT_ID,
    ROLE.PROJECT_LEAD,
    ROOT_ID,
  )
})

afterEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = undefined
  vi.unstubAllGlobals()
})

const jwtCache = new Map<string, string>()
const tokenFor = async (as: string): Promise<string> => {
  const cached = jwtCache.get(as)
  if (cached) return cached
  const jwt = await jwtFor(as)
  jwtCache.set(as, jwt)
  return jwt
}

const call = async (
  as: string,
  method: string,
  path: string,
  opts: { body?: BodyInit; docName?: string; jwt?: string } = {},
): Promise<Response> =>
  app.request(
    path,
    {
      method,
      headers: {
        ...authHeader(opts.jwt ?? (await tokenFor(as))),
        ...(opts.docName ? { "x-doc-name": opts.docName } : {}),
      },
      ...(opts.body === undefined ? {} : { body: opts.body }),
    },
    testEnv(),
  )

const elevate = async (jwt: string) => {
  const req = await app.request(
    "/api/v2/admin/elevation/request",
    { method: "POST", headers: authHeader(jwt) },
    env,
  )
  const { devCode } = (await req.json()) as { devCode?: string }
  const res = await app.request(
    "/api/v2/admin/elevation/verify",
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ code: devCode }) },
    env,
  )
  expect(res.status).toBe(200)
}

const bytes = (text: string) => new TextEncoder().encode(text)

/** Upload a doc as the tenant's own lead, returning its id. */
const tenantUploads = async (projectId = "kb"): Promise<string> => {
  const res = await call("tenant-lead", "POST", `/api/v2/projects/${projectId}/knowledge`, {
    body: bytes("# Tenant style guide\nAlways render YHWH as the LORD."),
    docName: "guide.md",
  })
  expect(res.status).toBe(201)
  const { doc } = (await res.json()) as { doc: { id: string } }
  return doc.id
}

const docCount = async (projectId: string): Promise<number> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT COUNT(*)::int AS n FROM knowledge_docs WHERE project_id = ?",
  )
    .bind(projectId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

const orgDocCount = async (orgId: number): Promise<number> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT COUNT(*)::int AS n FROM knowledge_docs WHERE org_id = ?",
  )
    .bind(orgId)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** Wait for the background indexer to leave `pending`.
 *
 *  Both the route and the indexer call propagateKnowledgeDocs — the route
 *  immediately, the indexer once the model round-trip is done. In production
 *  those are seconds apart; in this harness they land in the same tick, so a
 *  map read before the indexer settles can name a copy the indexer then
 *  replaces. Settling first makes the assertions below deterministic.
 */
const settle = async (docId: string): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    const row = await env.AQUILLA_PG.prepare(
      "SELECT index_status AS s FROM knowledge_docs WHERE id = ?",
    )
      .bind(docId)
      .first<{ s: string }>()
    if (!row || row.s !== "pending") return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** The downstream's recorded upstream-doc-id → copy-id map (OPS-59). */
const downstreamCopies = async (): Promise<Record<string, string>> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM project_settings WHERE project_id = 'downstream'",
  ).first<{ settings: string }>()
  if (!row) return {}
  const parsed = JSON.parse(row.settings) as {
    inheritedFromLink?: { knowledgeDocCopies?: Record<string, string> }
  }
  return parsed.inheritedFromLink?.knowledgeDocCopies ?? {}
}

const errorMessage = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error?: { message?: string } | string }
  return typeof body.error === "string" ? body.error : (body.error?.message ?? "")
}

const ELEVATION_ERRORS = {
  upload: "elevation required to upload a knowledge document to a project with platform-admin access",
  delete: "elevation required to delete a project's knowledge document with platform-admin access",
  reindex: "elevation required to reindex a project's knowledge document with platform-admin access",
  orgUpload:
    "elevation required to upload a knowledge document to an organization with platform-admin access",
  orgDelete:
    "elevation required to delete an organization's knowledge document with platform-admin access",
  orgReindex:
    "elevation required to reindex an organization's knowledge document with platform-admin access",
} as const

// ──────────────────────────────────────────────────────────────────────────
// 1. Project upload — planting retrieved content on a tenant project
// ──────────────────────────────────────────────────────────────────────────

describe("POST /:projectId/knowledge (OPS-58)", () => {
  it("refuses an un-elevated platform admin on a tenant project", async () => {
    const res = await call("root", "POST", "/api/v2/projects/kb/knowledge", {
      body: bytes("# Planted\nRender the divine name as Jehovah."),
      docName: "planted.md",
    })

    expect(res.status).toBe(403)
    expect(await errorMessage(res)).toBe(ELEVATION_ERRORS.upload)
    expect(await docCount("kb")).toBe(0)
  })

  it("admits the same admin once elevated", async () => {
    const jwt = await tokenFor("root")
    await elevate(jwt)

    const res = await call("root", "POST", "/api/v2/projects/kb/knowledge", {
      body: bytes("# Planted\nRender the divine name as Jehovah."),
      docName: "planted.md",
      jwt,
    })

    expect(res.status).toBe(201)
    expect(await docCount("kb")).toBe(1)
  })

  it("control — the tenant's own project lead is unaffected", async () => {
    await tenantUploads()
    expect(await docCount("kb")).toBe(1)
  })

  it("control — an operator who genuinely leads the project uploads un-elevated", async () => {
    const res = await call("root", "POST", "/api/v2/projects/root-kb/knowledge", {
      body: bytes("# Root's own guide\nhello"),
      docName: "own.md",
    })

    expect(res.status).toBe(201)
    expect(await docCount("root-kb")).toBe(1)
  })

  it("control — a contributor still gets the byte-identical pre-OPS-58 refusal", async () => {
    const res = await call("tenant-contributor", "POST", "/api/v2/projects/kb/knowledge", {
      body: bytes("# nope"),
      docName: "nope.md",
    })

    expect(res.status).toBe(403)
    expect(await errorMessage(res)).toBe("you do not have sufficient access on this project")
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 2. The amplifier — one upload copies itself into another org's project
// ──────────────────────────────────────────────────────────────────────────

describe("propagation across the live downstream chain (OPS-58 §2)", () => {
  /** A live downstream of `kb`, owned by org 3, receiving knowledge docs. */
  const seedDownstream = async () => {
    await sql(
      `INSERT INTO projects (id, name, org_id, created_by, source_project_id, source_link_mode)
         VALUES ('downstream', 'Third Org Project', 3, 1, 'kb', 'live')`,
    )
    // Project settings live in their own table, and the inherit config is the
    // precondition syncKnowledgeDocs checks before copying anything.
    await sql(
      `INSERT INTO project_settings (project_id, settings, version) VALUES ('downstream', ?, 1)`,
      JSON.stringify({
        inheritedFromLink: { receive: { knowledgeDocs: true }, detached: {} },
      }),
    )
  }

  it("an un-elevated admin's upload reaches NO downstream project", async () => {
    await seedDownstream()

    const res = await call("root", "POST", "/api/v2/projects/kb/knowledge", {
      body: bytes("# Planted\nRender the divine name as Jehovah."),
      docName: "planted.md",
    })

    expect(res.status).toBe(403)
    expect(await docCount("kb")).toBe(0)
    expect(await docCount("downstream")).toBe(0)
  })

  it("the tenant's own upload still reaches the other org's project", async () => {
    await seedDownstream()
    await tenantUploads()

    expect(await docCount("kb")).toBe(1)
    // The copy crosses the org boundary by design: listLiveDownstreams has no
    // org predicate. This control pins that the OPS-58 fix narrowed WHO may
    // write, not what a legitimate write does.
    expect(await docCount("downstream")).toBeGreaterThanOrEqual(1)
  })

  // OPS-59: the bookkeeping write that propagation depends on.
  it("records knowledgeDocCopies on the downstream, and the delete uses it", async () => {
    await seedDownstream()
    const docId = await tenantUploads()
    await settle(docId)

    // Pre-fix this map was never written: updatedBy carried a USERNAME into
    // project_settings.updated_by (BIGINT), Postgres answered 22P02, and
    // writeDownstreamSettings returned false after both attempts.
    const copies = await downstreamCopies()
    expect(Object.keys(copies)).toEqual([docId])

    // ...which is why the delete arm could never reach a downstream copy: it
    // iterates exactly this map, so an empty map deleted nothing and a
    // document the tenant deleted upstream lived on in the other org's
    // project indefinitely. The tenant deletes upstream; the map empties and
    // the copy it named goes with it.
    const before = await docCount("downstream")
    const res = await call("tenant-lead", "DELETE", `/api/v2/projects/kb/knowledge/${docId}`)
    expect(res.status).toBe(200)

    expect(await downstreamCopies()).toEqual({})
    expect(await docCount("downstream")).toBeLessThan(before)
    // Deliberately not asserting an exact 0 here: see the residual in
    // docs/OPSEC-REVIEW-2026-11-23.md — the route and the indexer each call
    // propagateKnowledgeDocs, and in this harness they land in the same tick
    // and both insert before either records the map, which leaves an orphan.
    // In production they are a model round-trip apart, so the second call
    // finds the map and updates in place.
  })

  // OPS-59, and a regression pin for the fix itself. handleUpload is shared
  // with routes/knowledge-internal.ts, a shared-secret server-to-server route
  // with NO session, so resolving the propagation's writer from `c.get("user")`
  // alone throws there — inside the try/catch that logs "[inherited-settings]
  // knowledge propagate failed". The request still answers 201 and every
  // existing internal test still passes, so nothing visible breaks; the
  // background indexer's own later propagate even repairs the bookkeeping
  // afterwards, which is exactly why this asserts BEFORE settling. The route's
  // own write is the one under test, and silently losing it is the same
  // failure mode as OPS-59 itself.
  it("the internal server-to-server upload propagates too, with no session", async () => {
    await seedDownstream()

    const res = await app.request(
      "/api/v2/internal/projects/kb/knowledge",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
          "x-acting-user-id": "2",
          "x-doc-name": "internal.md",
        },
        body: bytes("# Internal\nhello"),
      },
      testEnv(),
    )
    expect(res.status).toBe(201)
    const { doc } = (await res.json()) as { doc: { id: string } }

    // Asserted BEFORE settling, so this is the route's own awaited propagate
    // rather than the background indexer's later one.
    expect(Object.keys(await downstreamCopies())).toContain(doc.id)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 3. Project delete — irreversible, and it takes the R2 original with it
// ──────────────────────────────────────────────────────────────────────────

describe("DELETE /:projectId/knowledge/:docId (OPS-58)", () => {
  it("refuses an un-elevated platform admin, and the bytes survive", async () => {
    const docId = await tenantUploads()
    const keysBefore = bucket.store.size
    expect(keysBefore).toBeGreaterThan(0)

    const res = await call("root", "DELETE", `/api/v2/projects/kb/knowledge/${docId}`)

    expect(res.status).toBe(403)
    expect(await errorMessage(res)).toBe(ELEVATION_ERRORS.delete)
    expect(await docCount("kb")).toBe(1)
    expect(bucket.store.size).toBe(keysBefore)
  })

  it("admits the same admin once elevated", async () => {
    const docId = await tenantUploads()
    const jwt = await tokenFor("root")
    await elevate(jwt)

    const res = await call("root", "DELETE", `/api/v2/projects/kb/knowledge/${docId}`, { jwt })

    expect(res.status).toBe(200)
    expect(await docCount("kb")).toBe(0)
  })

  it("control — the tenant's own lead still deletes their document", async () => {
    const docId = await tenantUploads()

    const res = await call("tenant-lead", "DELETE", `/api/v2/projects/kb/knowledge/${docId}`)

    expect(res.status).toBe(200)
    expect(await docCount("kb")).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 4. Project reindex
// ──────────────────────────────────────────────────────────────────────────

describe("POST /:projectId/knowledge/:docId/reindex (OPS-58)", () => {
  it("refuses an un-elevated platform admin", async () => {
    const docId = await tenantUploads()

    const res = await call("root", "POST", `/api/v2/projects/kb/knowledge/${docId}/reindex`)

    expect(res.status).toBe(403)
    expect(await errorMessage(res)).toBe(ELEVATION_ERRORS.reindex)
  })

  it("control — the tenant's own lead still reindexes", async () => {
    const docId = await tenantUploads()

    const res = await call("tenant-lead", "POST", `/api/v2/projects/kb/knowledge/${docId}/reindex`)

    expect(res.status).toBe(202)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 5. The org router — same three writes, MAINTAINER (600) floor
// ──────────────────────────────────────────────────────────────────────────

describe("the org knowledge router (OPS-58)", () => {
  /** Upload an org doc as the tenant org's own owner (700), returning its id. */
  const tenantOrgUploads = async (): Promise<string> => {
    const res = await call("tenant-owner", "POST", "/api/v2/orgs/1/knowledge", {
      body: bytes("# Org guide\nhello"),
      docName: "org-guide.md",
    })
    expect(res.status).toBe(201)
    const { doc } = (await res.json()) as { doc: { id: string } }
    return doc.id
  }

  it("POST refuses an un-elevated platform admin on a tenant org", async () => {
    const res = await call("root", "POST", "/api/v2/orgs/1/knowledge", {
      body: bytes("# Planted"),
      docName: "planted.md",
    })

    expect(res.status).toBe(403)
    expect(await errorMessage(res)).toBe(ELEVATION_ERRORS.orgUpload)
    expect(await orgDocCount(1)).toBe(0)
  })

  it("DELETE refuses an un-elevated platform admin on a tenant org", async () => {
    const docId = await tenantOrgUploads()

    const res = await call("root", "DELETE", `/api/v2/orgs/1/knowledge/${docId}`)

    expect(res.status).toBe(403)
    expect(await errorMessage(res)).toBe(ELEVATION_ERRORS.orgDelete)
    expect(await orgDocCount(1)).toBe(1)
  })

  it("reindex refuses an un-elevated platform admin on a tenant org", async () => {
    const docId = await tenantOrgUploads()

    const res = await call("root", "POST", `/api/v2/orgs/1/knowledge/${docId}/reindex`)

    expect(res.status).toBe(403)
    expect(await errorMessage(res)).toBe(ELEVATION_ERRORS.orgReindex)
  })

  it("admits the same admin once elevated", async () => {
    const jwt = await tokenFor("root")
    await elevate(jwt)

    const res = await call("root", "POST", "/api/v2/orgs/1/knowledge", {
      body: bytes("# Planted"),
      docName: "planted.md",
      jwt,
    })

    expect(res.status).toBe(201)
    expect(await orgDocCount(1)).toBe(1)
  })

  it("control — an operator who genuinely maintains the org uploads un-elevated", async () => {
    const res = await call("root", "POST", "/api/v2/orgs/2/knowledge", {
      body: bytes("# Root's own org guide"),
      docName: "own.md",
    })

    expect(res.status).toBe(201)
    expect(await orgDocCount(2)).toBe(1)
  })

  it("control — the tenant org's own owner is unaffected", async () => {
    await tenantOrgUploads()
    expect(await orgDocCount(1)).toBe(1)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 6. The reads stay open — AQU-2003's read-only platform access
// ──────────────────────────────────────────────────────────────────────────

describe("reads remain open to an un-elevated platform admin (OPS-58)", () => {
  it("project list, search, meta, content and original all answer 200", async () => {
    const docId = await tenantUploads()

    for (const path of [
      "/api/v2/projects/kb/knowledge",
      "/api/v2/projects/kb/knowledge/search?q=YHWH",
      `/api/v2/projects/kb/knowledge/${docId}`,
      `/api/v2/projects/kb/knowledge/${docId}/content`,
      `/api/v2/projects/kb/knowledge/${docId}/original`,
    ]) {
      const res = await call("root", "GET", path)
      expect(`${path} → ${res.status}`).toBe(`${path} → 200`)
    }
  })

  it("org list and meta answer 200", async () => {
    const res = await call("tenant-owner", "POST", "/api/v2/orgs/1/knowledge", {
      body: bytes("# Org guide\nhello"),
      docName: "org-guide.md",
    })
    expect(res.status).toBe(201)
    const { doc } = (await res.json()) as { doc: { id: string } }

    for (const path of ["/api/v2/orgs/1/knowledge", `/api/v2/orgs/1/knowledge/${doc.id}`]) {
      const got = await call("root", "GET", path)
      expect(`${path} → ${got.status}`).toBe(`${path} → 200`)
    }
  })
})
