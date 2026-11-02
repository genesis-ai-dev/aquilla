// Feedback routes: admin CRUD, the matching rules, and the email that goes out
// beside the Discord post. Addresses are example.com stand-ins on purpose.

import { env } from "cloudflare:test"
import { afterEach, describe, it, expect, vi } from "vitest"
import app from "../index"
import type { Env } from "../types"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import {
  collectRecipients,
  selectMatchingRoutes,
  type FeedbackRoute,
} from "../services/feedback-routes"
import { buildFeedbackRouteEmail, isReplyableEmail } from "../services/email"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const route = (over: Partial<FeedbackRoute>): FeedbackRoute => ({
  id: 1,
  orgId: 1,
  projectIds: [],
  emails: ["a@example.com"],
  label: null,
  enabled: true,
  ...over,
})

describe("selectMatchingRoutes", () => {
  const whole = route({ id: 1, orgId: 1 })
  const scoped = route({ id: 2, orgId: 1, projectIds: ["p1", "p2"] })
  const other = route({ id: 3, orgId: 2 })
  const off = route({ id: 4, orgId: 1, enabled: false })
  const all = [whole, scoped, other, off]
  const ids = (r: FeedbackRoute[]) => r.map((x) => x.id)

  it("a project report matches whole-org routes and routes listing that project", () => {
    expect(ids(selectMatchingRoutes(all, { orgId: 1, projectId: "p1", memberOrgIds: [] }))).toEqual([1, 2])
    expect(ids(selectMatchingRoutes(all, { orgId: 1, projectId: "p9", memberOrgIds: [] }))).toEqual([1])
  })

  it("an org page report matches whole-org routes of that org only", () => {
    expect(ids(selectMatchingRoutes(all, { orgId: 1, projectId: null, memberOrgIds: [1, 2] }))).toEqual([1])
  })

  it("a report with no org matches whole-org routes of the reporter's orgs", () => {
    expect(ids(selectMatchingRoutes(all, { orgId: null, projectId: null, memberOrgIds: [1, 2] }))).toEqual([1, 3])
    expect(ids(selectMatchingRoutes(all, { orgId: null, projectId: null, memberOrgIds: [] }))).toEqual([])
  })

  it("dedupes recipients across routes, ignoring case", () => {
    const list = collectRecipients([
      route({ emails: ["A@example.com", "b@example.com"] }),
      route({ emails: ["a@example.com", "c@example.com"] }),
    ])
    expect(list).toEqual(["A@example.com", "b@example.com", "c@example.com"])
  })
})

describe("feedback email copy", () => {
  it("builds the subject and falls back when the user has no email", () => {
    const built = buildFeedbackRouteEmail({
      description: `${"x".repeat(80)}\nsecond line`,
      username: "u",
      userEmail: "",
      orgName: "Org",
      projectName: "Proj",
      route: "/home",
      sentAt: "2026-01-01T00:00:00.000Z",
    })
    expect(built.subject.startsWith("[Aquilla support] Org / Proj: xxx")).toBe(true)
    expect(built.subject.length).toBeLessThan(120)
    expect(built.text).toContain("No email on file. Contact this user through their project manager.")
  })

  it("only real-looking addresses become Reply-To", () => {
    expect(isReplyableEmail("person@church.org")).toBe(true)
    expect(isReplyableEmail("")).toBe(false)
    expect(isReplyableEmail("x@host.invalid")).toBe(false)
    expect(isReplyableEmail("noemail@aquilla.app")).toBe(false)
  })
})

// --- HTTP -------------------------------------------------------------------

const adminReq = (jwt: string, method: string, path: string, body?: unknown) =>
  app.request(
    `/api/v2/admin/feedback-routes${path}`,
    { method, headers: authHeader(jwt), body: body === undefined ? undefined : JSON.stringify(body) },
    env,
  )

async function seedOrg(id: number, name: string, ownerId: number) {
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (?, ?, ?, 'team')",
  )
    .bind(id, name, ownerId)
    .run()
}
async function seedProject(id: string, name: string, orgId: number, createdBy: number) {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, ?, ?)")
    .bind(id, name, orgId, createdBy)
    .run()
}

describe("admin feedback-routes CRUD", () => {
  it("rejects non-admins", async () => {
    await seedUser(801, "fr-plain")
    const res = await adminReq(await jwtFor("fr-plain"), "GET", "")
    expect(res.status).toBe(403)
  })

  it("creates, lists, updates and deletes a route, with audit rows", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    await seedOrg(8101, "Route Org", 7)
    await seedProject("fr-p1", "First", 8101, 7)

    const created = await adminReq(jwt, "POST", "", {
      orgId: 8101,
      projectIds: ["fr-p1"],
      emails: ["One@Example.com", "one@example.com", "two@example.com"],
      label: "Desk",
    })
    expect(created.status).toBe(201)
    const { route: r } = (await created.json()) as {
      route: { id: number; emails: string[]; orgName: string; projects: { id: string; name: string }[] }
    }
    expect(r.emails).toEqual(["one@example.com", "two@example.com"])
    expect(r.orgName).toBe("Route Org")
    expect(r.projects).toEqual([{ id: "fr-p1", name: "First" }])

    const patched = await adminReq(jwt, "PATCH", `/${r.id}`, { enabled: false, projectIds: [] })
    expect(patched.status).toBe(200)
    const list = (await (await adminReq(jwt, "GET", "")).json()) as {
      routes: { id: number; enabled: boolean; projectIds: string[] }[]
    }
    const listed = list.routes.find((x) => x.id === r.id)
    expect(listed?.enabled).toBe(false)
    expect(listed?.projectIds).toEqual([])

    expect((await adminReq(jwt, "DELETE", `/${r.id}`)).status).toBe(200)
    expect((await adminReq(jwt, "DELETE", `/${r.id}`)).status).toBe(404)

    const audit = await env.AQUILLA_PG.prepare(
      "SELECT action FROM admin_audit_log WHERE action LIKE 'feedback_route.%' ORDER BY id",
    ).all<{ action: string }>()
    expect((audit.results ?? []).map((a) => a.action)).toEqual([
      "feedback_route.create",
      "feedback_route.update",
      "feedback_route.delete",
    ])
  })

  it("rejects a project from another org and a bad email", async () => {
    await seedUser(7, "root")
    const jwt = await jwtFor("root")
    await seedOrg(8102, "Org A", 7)
    await seedOrg(8103, "Org B", 7)
    await seedProject("fr-b1", "In B", 8103, 7)

    const stray = await adminReq(jwt, "POST", "", { orgId: 8102, projectIds: ["fr-b1"], emails: ["a@example.com"] })
    expect(stray.status).toBe(400)
    expect(((await stray.json()) as { error: string }).error).toBe("project_not_in_org")

    const bad = await adminReq(jwt, "POST", "", { orgId: 8102, emails: ["not-an-email"] })
    expect(bad.status).toBe(400)
    const none = await adminReq(jwt, "POST", "", { orgId: 8102, emails: [] })
    expect(none.status).toBe(400)
  })
})

// --- POST /feedback sends the mail ------------------------------------------

function sendFeedback(jwt: string, fields: Record<string, string>, overrides: Partial<Env>) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return app.request(
    "/api/v2/feedback",
    { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form },
    { ...env, SNAPSHOTS: undefined, ...overrides },
  )
}

describe("POST /api/v2/feedback with routes", () => {
  it("emails matching routes once and keeps the Discord post", async () => {
    await seedUser(7, "root")
    const adminJwt = await jwtFor("root")
    await seedUser(821, "fr-reporter")
    await seedOrg(8201, "Mail Org", 7)
    await seedProject("fr-m1", "Mail Project", 8201, 821)
    await adminReq(adminJwt, "POST", "", { orgId: 8201, emails: ["desk@example.com", "x@example.com"] })
    await adminReq(adminJwt, "POST", "", { orgId: 8201, projectIds: ["fr-m1"], emails: ["x@example.com", "y@example.com"] })

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetchMock)
    const send = vi.fn(async (_msg: unknown) => ({ messageId: "m1" }))

    const res = await sendFeedback(
      await jwtFor("fr-reporter"),
      { description: "Cannot save my work", projectId: "fr-m1", route: "/project/fr-m1" },
      { EMAIL: { send } as unknown as Env["EMAIL"], DISCORD_FEEDBACK_WEBHOOK_URL: "https://discord.example/hook" },
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as { delivered: boolean; emailedRoutes: number }
    expect(body.delivered).toBe(true)
    expect(body.emailedRoutes).toBe(3)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    const msg = send.mock.calls[0][0] as { to: string[]; subject: string; replyTo: string }
    expect(msg.to).toEqual(["desk@example.com", "x@example.com", "y@example.com"])
    expect(msg.subject).toBe("[Aquilla support] Mail Org / Mail Project: Cannot save my work")
    expect(msg.replyTo).toBe("fr-reporter@example.com")
  })

  it("a user with no project reaches the whole-org route of an org they belong to", async () => {
    await seedUser(7, "root")
    const adminJwt = await jwtFor("root")
    await seedUser(831, "fr-home")
    await seedOrg(8301, "Home Org", 7)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level) VALUES (?, ?, 100)",
    ).bind(8301, 831).run()
    await adminReq(adminJwt, "POST", "", { orgId: 8301, emails: ["home@example.com"] })
    const send = vi.fn(async (_msg: unknown) => ({ messageId: "m" }))

    const res = await sendFeedback(await jwtFor("fr-home"), { description: "Stuck", route: "/" }, {
      EMAIL: { send } as unknown as Env["EMAIL"],
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { emailedRoutes: number }).emailedRoutes).toBe(1)
    expect((send.mock.calls[0][0] as { to: string[] }).to).toEqual(["home@example.com"])
  })

  it("an email failure still returns 201 with Discord delivered", async () => {
    await seedUser(7, "root")
    const adminJwt = await jwtFor("root")
    await seedUser(841, "fr-fail")
    await seedOrg(8401, "Fail Org", 7)
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level) VALUES (?, ?, 100)",
    ).bind(8401, 841).run()
    await adminReq(adminJwt, "POST", "", { orgId: 8401, emails: ["fail@example.com"] })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })))
    vi.spyOn(console, "warn").mockImplementation(() => {})
    const send = vi.fn(async (_msg: unknown) => {
      throw new Error("provider down")
    })

    const res = await sendFeedback(await jwtFor("fr-fail"), { description: "Hello", route: "/" }, {
      EMAIL: { send } as unknown as Env["EMAIL"],
      DISCORD_FEEDBACK_WEBHOOK_URL: "https://discord.example/hook",
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { delivered: boolean; emailedRoutes: number }
    expect(body.delivered).toBe(true)
    expect(body.emailedRoutes).toBe(0)
    expect(send).toHaveBeenCalled()
  })
})
