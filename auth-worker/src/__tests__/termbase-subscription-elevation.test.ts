// OPSEC review 2026-11-09 (OPS-53): the org-termbase publish/subscribe
// router's MAINTAINER floor is satisfied by platform-admin power alone, on
// every project in every org on the platform.
//
// `resolveProjectRole` contributes { source: "platform", level: 700 } for
// every platform operator and ROLE.MAINTAINER is 600, so
// `role.level < ROLE.MAINTAINER` is false by definition for an un-elevated
// admin JWT. All five writes on this router passed.
//
// Why this router is worse than "five more un-gated writes", and why the
// elevation rule (AQU-1322 / OPS-44 / OPS-51) reaches it:
//
//   1. `org_published_termbase` is not a setting — it IS the org's consent
//      token. `canReadTermbase` (services/org-permissions.ts) derives a read
//      grant from it, and the subscribe route uses it as the upstream's
//      permission to be subscribed to. An operator who can flip that flag
//      forges the only consent in the design, for a project they hold no
//      grant on.
//   2. A subscription row is a STANDING cross-project read, not one write.
//      The Q19 implicit grant is derived from the row at resolve time, so
//      every viewer (100) of the subscriber project reads the whole upstream
//      termbase — source terms, every rendering, every note — for as long as
//      the row lives. This is the shape OPS-44 named for a PAT, OPS-49 for an
//      integration link and OPS-51 for a source link, a fourth time: the
//      artefact outlives the authority that created it, so an elevation check
//      at use time can never reach it.
//   3. Chained, the two are one exploit: publish tenant project A (write 1),
//      subscribe tenant project B to it (write 3), and B's members hold a
//      permanent read of A's terminology. Neither row records an actor.
//
// The rule under test: on this router's five WRITES, platform power is
// stripped unless the session is elevated, then the route's own floor is
// re-applied to what remains. The three READS are deliberately left open —
// AQU-2003 priced un-elevated platform access as read-only on our own
// content, not refused.
//
// OPS-54 is also pinned here: the reorder body's `order` array had no cap and
// became one atomic `batch()` of N statements, which db/shim/postgres.ts runs
// SERIALLY inside a single open transaction.
//
// Base test allowlist is ADMIN_EMAILS=root@example.com (pg-test-env), so the
// seeded "root" user is the platform admin.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const ROOT_ID = 7

const sql = (query: string, ...binds: unknown[]) =>
  env.AQUILLA_PG.prepare(query)
    .bind(...binds)
    .run()

beforeEach(async () => {
  env.ADMIN_REQUIRE_ELEVATION = "true"

  await seedUser(1, "tenant-owner")
  await seedUser(2, "tenant-maintainer")
  await seedUser(3, "tenant-contributor")
  await seedUser(4, "stranger")
  await seedUser(ROOT_ID, "root")

  // Org 1 is the tenant root reaches ONLY through platform power.
  // Org 2 is root's own, where they hold a genuine grant — the control.
  await sql(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Tenant Org', 1), (2, 'Root Org', ?)",
    ROOT_ID,
  )
  await sql(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
       (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)`,
  )
  await sql(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
       ('tb', 'Tenant Termbase', 1, 1),
       ('consumer', 'Tenant Consumer', 1, 1),
       ('root-tb', 'Root Termbase', 2, ?),
       ('root-consumer', 'Root Consumer', 2, ?)`,
    ROOT_ID,
    ROOT_ID,
  )
  // AQU-435: an org contributor needs a direct grant for project access.
  await sql(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('consumer', 3, 400, 1)",
  )
  // root's GENUINE maintainer grant on their own org's projects. Without this
  // the de-escalated answer would be null and the controls below could not
  // tell "narrowed correctly" from "locked the operator out of their own work".
  await sql(
    `INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES
       ('root-tb', ?, 600, ?), ('root-consumer', ?, 600, ?)`,
    ROOT_ID,
    ROOT_ID,
    ROOT_ID,
    ROOT_ID,
  )
})

afterEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = undefined
})

const call = async (as: string, method: string, path: string, body?: unknown, jwt?: string) =>
  app.request(
    path,
    {
      method,
      headers: authHeader(jwt ?? (await jwtFor(as))),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
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

const isPublished = async (projectId: string): Promise<boolean> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT org_published_termbase AS p FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ p: number | boolean | null }>()
  return row?.p === 1 || row?.p === true
}

const subscriptionPriority = async (
  projectId: string,
  termbaseProjectId: string,
): Promise<number | null> => {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT priority FROM project_termbase_subscriptions WHERE project_id = ? AND termbase_project_id = ?",
  )
    .bind(projectId, termbaseProjectId)
    .first<{ priority: number }>()
  return row?.priority ?? null
}

/** Publish `tb` and subscribe `consumer` to it, as the tenant's own owner. */
const tenantSubscribes = async () => {
  let res = await call("tenant-owner", "POST", "/api/v2/projects/tb/termbase/publish")
  expect(res.status).toBe(200)
  res = await call("tenant-owner", "POST", "/api/v2/projects/consumer/termbase/subscriptions", {
    termbaseProjectId: "tb",
  })
  expect(res.status).toBe(200)
}

const ELEVATION_ERRORS = {
  publish: "elevation required to publish a project's termbase to its org with platform-admin access",
  unpublish: "elevation required to unpublish a project's termbase with platform-admin access",
  subscribe: "elevation required to subscribe a project to an org termbase with platform-admin access",
  unsubscribe:
    "elevation required to unsubscribe a project from an org termbase with platform-admin access",
  reorder: "elevation required to reorder a project's termbase subscriptions with platform-admin access",
} as const

// ──────────────────────────────────────────────────────────────────────────
// 1. Publish — forging the org's consent token
// ──────────────────────────────────────────────────────────────────────────

describe("POST /:id/termbase/publish (OPS-53)", () => {
  it("refuses an un-elevated platform admin, and the flag stays down", async () => {
    const res = await call("root", "POST", "/api/v2/projects/tb/termbase/publish")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ELEVATION_ERRORS.publish })
    expect(await isPublished("tb")).toBe(false)
  })

  it("allows it once the session is elevated", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call("root", "POST", "/api/v2/projects/tb/termbase/publish", undefined, jwt)
    expect(res.status).toBe(200)
    expect(await isPublished("tb")).toBe(true)
  })

  it("leaves the tenant's own maintainer alone", async () => {
    const res = await call("tenant-maintainer", "POST", "/api/v2/projects/tb/termbase/publish")
    expect(res.status).toBe(200)
    expect(await isPublished("tb")).toBe(true)
  })

  it("does not lock an operator out of a project they genuinely maintain", async () => {
    const res = await call("root", "POST", "/api/v2/projects/root-tb/termbase/publish")
    expect(res.status).toBe(200)
    expect(await isPublished("root-tb")).toBe(true)
  })

  it("still refuses a contributor with the pre-OPS-53 wording", async () => {
    const res = await call("tenant-contributor", "POST", "/api/v2/projects/consumer/termbase/publish")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "role >= maintainer (600) required" })
  })

  it("still refuses a non-member with the pre-OPS-53 wording", async () => {
    const res = await call("stranger", "POST", "/api/v2/projects/tb/termbase/publish")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "no access to project" })
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 2. Unpublish — revoking an org's termbase sharing from outside it
// ──────────────────────────────────────────────────────────────────────────

describe("DELETE /:id/termbase/publish (OPS-53)", () => {
  it("refuses an un-elevated platform admin, and the termbase stays published", async () => {
    await tenantSubscribes()
    const res = await call("root", "DELETE", "/api/v2/projects/tb/termbase/publish")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ELEVATION_ERRORS.unpublish })
    expect(await isPublished("tb")).toBe(true)
  })

  it("allows it once the session is elevated", async () => {
    await tenantSubscribes()
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call("root", "DELETE", "/api/v2/projects/tb/termbase/publish", undefined, jwt)
    expect(res.status).toBe(200)
    expect(await isPublished("tb")).toBe(false)
  })

  it("leaves the tenant's own maintainer alone", async () => {
    await tenantSubscribes()
    const res = await call("tenant-maintainer", "DELETE", "/api/v2/projects/tb/termbase/publish")
    expect(res.status).toBe(200)
    expect(await isPublished("tb")).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 3. Subscribe — minting the standing Q19 read grant
// ──────────────────────────────────────────────────────────────────────────

describe("POST /:id/termbase/subscriptions (OPS-53)", () => {
  it("refuses an un-elevated platform admin, and no row is written", async () => {
    await call("tenant-owner", "POST", "/api/v2/projects/tb/termbase/publish")
    const res = await call("root", "POST", "/api/v2/projects/consumer/termbase/subscriptions", {
      termbaseProjectId: "tb",
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ELEVATION_ERRORS.subscribe })
    expect(await subscriptionPriority("consumer", "tb")).toBeNull()
  })

  it("so the Q19 implicit read grant it would have minted does not exist", async () => {
    await call("tenant-owner", "POST", "/api/v2/projects/tb/termbase/publish")
    await call("root", "POST", "/api/v2/projects/consumer/termbase/subscriptions", {
      termbaseProjectId: "tb",
    })
    // canReadTermbase needs the row. A `consumer` CONTRIBUTOR — who would have
    // inherited the grant off the back of the refused write — still cannot
    // read the upstream termbase.
    const res = await call(
      "tenant-contributor",
      "GET",
      "/api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer",
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "no termbase read access" })
  })

  it("allows it once the session is elevated", async () => {
    await call("tenant-owner", "POST", "/api/v2/projects/tb/termbase/publish")
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call(
      "root",
      "POST",
      "/api/v2/projects/consumer/termbase/subscriptions",
      { termbaseProjectId: "tb" },
      jwt,
    )
    expect(res.status).toBe(200)
    expect(await subscriptionPriority("consumer", "tb")).toBe(0)
  })

  it("does not lock an operator out of their own org's projects", async () => {
    await call("root", "POST", "/api/v2/projects/root-tb/termbase/publish")
    const res = await call("root", "POST", "/api/v2/projects/root-consumer/termbase/subscriptions", {
      termbaseProjectId: "root-tb",
    })
    expect(res.status).toBe(200)
    expect(await subscriptionPriority("root-consumer", "root-tb")).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// 4 & 5. Unsubscribe and reorder — tampering with a tenant's enforcement
// ──────────────────────────────────────────────────────────────────────────

describe("DELETE /:id/termbase/subscriptions/:termbaseProjectId (OPS-53)", () => {
  it("refuses an un-elevated platform admin, and the row survives", async () => {
    await tenantSubscribes()
    const res = await call(
      "root",
      "DELETE",
      "/api/v2/projects/consumer/termbase/subscriptions/tb",
    )
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ELEVATION_ERRORS.unsubscribe })
    expect(await subscriptionPriority("consumer", "tb")).toBe(0)
  })

  it("leaves the tenant's own maintainer alone", async () => {
    await tenantSubscribes()
    const res = await call(
      "tenant-maintainer",
      "DELETE",
      "/api/v2/projects/consumer/termbase/subscriptions/tb",
    )
    expect(res.status).toBe(200)
    expect(await subscriptionPriority("consumer", "tb")).toBeNull()
  })
})

describe("PATCH /:id/termbase/subscriptions (OPS-53)", () => {
  it("refuses an un-elevated platform admin, and the priorities are unchanged", async () => {
    await tenantSubscribes()
    const res = await call("root", "PATCH", "/api/v2/projects/consumer/termbase/subscriptions", {
      order: ["tb"],
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: ELEVATION_ERRORS.reorder })
    expect(await subscriptionPriority("consumer", "tb")).toBe(0)
  })

  it("leaves the tenant's own maintainer alone", async () => {
    await tenantSubscribes()
    const res = await call(
      "tenant-maintainer",
      "PATCH",
      "/api/v2/projects/consumer/termbase/subscriptions",
      { order: ["tb"] },
    )
    expect(res.status).toBe(200)
    expect(await subscriptionPriority("consumer", "tb")).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// The three reads stay open (AQU-2003)
// ──────────────────────────────────────────────────────────────────────────

describe("the reads stay open to an un-elevated platform admin (AQU-2003)", () => {
  it("GET /orgs/:orgId/published-termbases", async () => {
    await tenantSubscribes()
    const res = await call("root", "GET", "/api/v2/orgs/1/published-termbases")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { termbases: Array<{ projectId: string }> }
    expect(body.termbases.map((t) => t.projectId)).toEqual(["tb"])
  })

  it("GET /:id/termbase/subscriptions", async () => {
    await tenantSubscribes()
    const res = await call("root", "GET", "/api/v2/projects/consumer/termbase/subscriptions")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { subscriptions: Array<{ termbaseProjectId: string }> }
    expect(body.subscriptions.map((s) => s.termbaseProjectId)).toEqual(["tb"])
  })

  it("GET /:termbaseProjectId/termbase/concepts, on a subscription the tenant made itself", async () => {
    await tenantSubscribes()
    const res = await call(
      "root",
      "GET",
      "/api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer",
    )
    expect(res.status).toBe(200)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// OPS-54 — the reorder array is capped
// ──────────────────────────────────────────────────────────────────────────

describe("PATCH /:id/termbase/subscriptions caps its order array (OPS-54)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `tb-${i}`)

  it("rejects an order array past the cap before any statement is batched", async () => {
    await tenantSubscribes()
    const res = await call("tenant-maintainer", "PATCH", "/api/v2/projects/consumer/termbase/subscriptions", {
      order: ids(501),
    })
    expect(res.status).toBe(400)
    // The real subscription is untouched: the body never reached the handler.
    expect(await subscriptionPriority("consumer", "tb")).toBe(0)
  })

  it("accepts an order array at the cap", async () => {
    await tenantSubscribes()
    const res = await call("tenant-maintainer", "PATCH", "/api/v2/projects/consumer/termbase/subscriptions", {
      order: [...ids(499), "tb"],
    })
    expect(res.status).toBe(200)
    expect(await subscriptionPriority("consumer", "tb")).toBe(499)
  })

  it("rejects an over-long id rather than binding it", async () => {
    await tenantSubscribes()
    const res = await call("tenant-maintainer", "PATCH", "/api/v2/projects/consumer/termbase/subscriptions", {
      order: ["x".repeat(257)],
    })
    expect(res.status).toBe(400)
  })
})
