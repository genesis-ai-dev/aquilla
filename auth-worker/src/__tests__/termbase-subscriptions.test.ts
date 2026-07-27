import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// Org 1: wendi=owner(700), anna=maintainer(600), tom=contributor(400).
// Projects in org 1: "tb" (the termbase source) and "consumer" (subscriber).
// Project "other" lives in org 2 (cross-org) created by wendi.
// stranger has no org membership.
async function seed() {
  await seedUser(1, "wendi")
  await seedUser(2, "anna")
  await seedUser(3, "tom")
  await seedUser(4, "stranger")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1), (2, 'Other', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
      (1, 1, 700, 1), (1, 2, 600, 1), (1, 3, 400, 1)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by) VALUES
      ('tb', 'Termbase', 1, 1),
      ('consumer', 'Consumer', 1, 1),
      ('other', 'CrossOrg', 2, 1)`,
  ).run()
  // AQU-435: tom's org contributor (400) role no longer grants project
  // access by itself — his reads on `consumer` need a direct grant now.
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('consumer', 3, 400, 1)",
  ).run()
}

const req = async (
  method: string,
  path: string,
  username: string,
  body?: Record<string, unknown>,
) =>
  app.request(
    path,
    {
      method,
      headers: authHeader(await jwtFor(username)),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  )

describe("termbase publish", () => {
  it("maintainer can publish an org-owned project's termbase", async () => {
    await seed()
    const res = await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projectId: "tb", published: true })
  })

  it("contributor (below maintainer) gets 403", async () => {
    await seed()
    const res = await req("POST", "/api/v2/projects/tb/termbase/publish", "tom")
    expect(res.status).toBe(403)
  })

  it("non-member gets 403", async () => {
    await seed()
    const res = await req("POST", "/api/v2/projects/tb/termbase/publish", "stranger")
    expect(res.status).toBe(403)
  })

  it("unpublish flips the flag back", async () => {
    await seed()
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    const res = await req("DELETE", "/api/v2/projects/tb/termbase/publish", "anna")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projectId: "tb", published: false })
  })
})

describe("GET /orgs/:orgId/published-termbases", () => {
  it("lists published termbases for an org member; hides unpublished", async () => {
    await seed()
    let res = await req("GET", "/api/v2/orgs/1/published-termbases", "tom")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { termbases: unknown[] }).termbases).toHaveLength(0)

    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    res = await req("GET", "/api/v2/orgs/1/published-termbases", "tom")
    const body = (await res.json()) as { termbases: Array<{ projectId: string; name: string }> }
    expect(body.termbases).toEqual([{ projectId: "tb", name: "Termbase", createdBy: 1 }])
  })

  it("non-member gets 403", async () => {
    await seed()
    const res = await req("GET", "/api/v2/orgs/1/published-termbases", "stranger")
    expect(res.status).toBe(403)
  })
})

describe("termbase subscriptions", () => {
  it("maintainer can subscribe to a published same-org termbase", async () => {
    await seed()
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    const res = await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", {
      termbaseProjectId: "tb",
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { subscription: { termbaseProjectId: string; priority: number } }
    expect(body.subscription.termbaseProjectId).toBe("tb")
    expect(body.subscription.priority).toBe(0)
  })

  it("subscribing to an unpublished termbase returns 409", async () => {
    await seed()
    const res = await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", {
      termbaseProjectId: "tb",
    })
    expect(res.status).toBe(409)
  })

  it("subscribing to a cross-org termbase returns 409 even if published", async () => {
    await seed()
    // Publish 'other' in org 2 directly (wendi owns it).
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET org_published_termbase = TRUE WHERE id = 'other'",
    ).run()
    const res = await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", {
      termbaseProjectId: "other",
    })
    expect(res.status).toBe(409)
  })

  it("cannot subscribe a project to its own termbase", async () => {
    await seed()
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    const res = await req("POST", "/api/v2/projects/tb/termbase/subscriptions", "anna", {
      termbaseProjectId: "tb",
    })
    expect(res.status).toBe(400)
  })

  it("contributor cannot subscribe (403)", async () => {
    await seed()
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    const res = await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "tom", {
      termbaseProjectId: "tb",
    })
    expect(res.status).toBe(403)
  })

  it("list returns subscriptions ordered by priority; viewer can read", async () => {
    await seed()
    // Publish two termbases and subscribe to both.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('tb2', 'Termbase2', 1, 1)",
    ).run()
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/tb2/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb" })
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb2" })

    const res = await req("GET", "/api/v2/projects/consumer/termbase/subscriptions", "tom")
    expect(res.status).toBe(200)
    const body = (await res.json()) as { subscriptions: Array<{ termbaseProjectId: string; priority: number }> }
    expect(body.subscriptions.map((s) => s.termbaseProjectId)).toEqual(["tb", "tb2"])
    expect(body.subscriptions.map((s) => s.priority)).toEqual([0, 1])
  })

  it("PATCH reorders priority by the given order array", async () => {
    await seed()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('tb2', 'Termbase2', 1, 1)",
    ).run()
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/tb2/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb" })
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb2" })

    const res = await req("PATCH", "/api/v2/projects/consumer/termbase/subscriptions", "anna", {
      order: ["tb2", "tb"],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { subscriptions: Array<{ termbaseProjectId: string }> }
    expect(body.subscriptions.map((s) => s.termbaseProjectId)).toEqual(["tb2", "tb"])
  })

  it("DELETE unsubscribes", async () => {
    await seed()
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb" })
    const del = await req("DELETE", "/api/v2/projects/consumer/termbase/subscriptions/tb", "anna")
    expect(del.status).toBe(200)
    const res = await req("GET", "/api/v2/projects/consumer/termbase/subscriptions", "anna")
    expect(((await res.json()) as { subscriptions: unknown[] }).subscriptions).toHaveLength(0)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects/:termbaseProjectId/termbase/concepts (Q19 implicit grant)
// ──────────────────────────────────────────────────────────────────────────

// Seed the upstream termbase project's terminology into project_settings so the
// concept-read endpoint has real data to return. One active + one draft concept
// proves the active-only filter.
async function seedUpstreamConcepts(projectId: string) {
  const settings = JSON.stringify({
    terminology: [
      {
        id: "c-active",
        sourceTerm: "grace",
        renderings: [{ rendering: "gracia", status: "preferred" }],
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "c-draft",
        sourceTerm: "mercy",
        renderings: [{ rendering: "misericordia", status: "preferred" }],
        status: "draft",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  })
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_settings (project_id, settings, version, updated_by) VALUES (?, ?, 1, 1)",
  )
    .bind(projectId, settings)
    .run()
}

describe("GET /projects/:termbaseProjectId/termbase/concepts", () => {
  it("returns the upstream's ACTIVE concepts for a valid subscriber member", async () => {
    await seed()
    await seedUpstreamConcepts("tb")
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb" })

    // tom is a contributor on the subscriber project (via org membership) —
    // any subscriber-project role suffices for the implicit grant.
    const res = await req(
      "GET",
      "/api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer",
      "tom",
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { concepts: Array<{ id: string }> }
    // Only the active concept is returned; the draft is filtered out.
    expect(body.concepts.map((c) => c.id)).toEqual(["c-active"])
  })

  it("400 when subscriberProjectId is missing", async () => {
    await seed()
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    const res = await req("GET", "/api/v2/projects/tb/termbase/concepts", "anna")
    expect(res.status).toBe(400)
  })

  it("403 when there is no subscription row (subscribe never happened)", async () => {
    await seed()
    await seedUpstreamConcepts("tb")
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    // No subscription created.
    const res = await req(
      "GET",
      "/api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer",
      "anna",
    )
    expect(res.status).toBe(403)
  })

  it("403 when the upstream is unpublished even with an existing subscription", async () => {
    await seed()
    await seedUpstreamConcepts("tb")
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb" })
    // Unpublish — the dangling subscription must become inert.
    await req("DELETE", "/api/v2/projects/tb/termbase/publish", "anna")
    const res = await req(
      "GET",
      "/api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer",
      "anna",
    )
    expect(res.status).toBe(403)
  })

  it("403 when the requester is not a member of the subscriber project", async () => {
    await seed()
    await seedUpstreamConcepts("tb")
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb" })
    // stranger has no membership anywhere.
    const res = await req(
      "GET",
      "/api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer",
      "stranger",
    )
    expect(res.status).toBe(403)
  })

  it("403 for a cross-org subscription pointing at a published upstream", async () => {
    await seed()
    await seedUpstreamConcepts("other")
    // 'other' lives in org 2; publish it directly and forge a cross-org
    // subscription row so we exercise the same-org gate in canReadTermbase.
    await env.AQUILLA_PG.prepare(
      "UPDATE projects SET org_published_termbase = TRUE WHERE id = 'other'",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_termbase_subscriptions (project_id, termbase_project_id, priority) VALUES ('consumer', 'other', 0)",
    ).run()
    const res = await req(
      "GET",
      "/api/v2/projects/other/termbase/concepts?subscriberProjectId=consumer",
      "anna",
    )
    expect(res.status).toBe(403)
  })

  it("returns empty concepts when upstream has no terminology settings", async () => {
    await seed()
    // No seedUpstreamConcepts — upstream has no project_settings row.
    await req("POST", "/api/v2/projects/tb/termbase/publish", "anna")
    await req("POST", "/api/v2/projects/consumer/termbase/subscriptions", "anna", { termbaseProjectId: "tb" })
    const res = await req(
      "GET",
      "/api/v2/projects/tb/termbase/concepts?subscriberProjectId=consumer",
      "anna",
    )
    expect(res.status).toBe(200)
    expect(((await res.json()) as { concepts: unknown[] }).concepts).toHaveLength(0)
  })
})
