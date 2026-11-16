// AQU-2576 — resolving an add-member target by EMAIL.
//
// A project owner staffing a project is handed a reviewer's email address, not
// their Aquilla handle. Before this, Add members accepted a username only, and
// the only way to recover a handle was to walk other projects' rosters until
// the name turned up. The account existed the whole time; only the lookup key
// was missing.
//
// The email branch is an email -> account oracle, so it is scoped to the people
// who can already act on the answer: the `role >= project_lead` floor that
// POST /projects/:id/members enforces. These tests pin both halves — it works
// for a caller who can staff the project, and it is unavailable (not merely
// unhelpful) to everyone else.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const PROJECT = "proj-aqu-2576"

beforeEach(async () => {
  // seedUser gives each account `<username>@example.com`.
  await seedUser(2570, "lead-2576") // project_lead on PROJECT — can add members
  await seedUser(2571, "naladda-2576") // the target, outside the caller's scope
  await seedUser(2572, "bystander-2576") // signed in, no access to PROJECT
  await seedUser(2573, "viewer-2576") // on PROJECT, below the add-member floor
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, ?)",
  )
    .bind(PROJECT, "AQU-2576", 2570)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, 500, ?)",
  )
    .bind(PROJECT, 2570, 2570)
    .run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, 100, ?)",
  )
    .bind(PROJECT, 2573, 2570)
    .run()
})

async function lookup(caller: string, identifier: string, projectId?: string) {
  const scope = projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""
  return app.request(
    `/api/v2/users/lookup?username=${encodeURIComponent(identifier)}${scope}`,
    { method: "GET", headers: authHeader(await jwtFor(caller)) },
    env,
  )
}

describe("GET /api/v2/users/lookup — email resolution (AQU-2576)", () => {
  it("resolves an email to the account, for a caller who can add members there", async () => {
    const res = await lookup("lead-2576", "naladda-2576@example.com", PROJECT)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: number; username: string }
    // The handle is exactly what the owner needs for Add members…
    expect(body.username).toBe("naladda-2576")
    expect(body.id).toBe(2571)
    // …and nothing else about the account comes back with it.
    expect(Object.keys(body).sort()).toEqual(["id", "username"])
  })

  it("matches the email case-insensitively", async () => {
    const res = await lookup("lead-2576", "NALADDA-2576@Example.COM", PROJECT)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { username: string }).username).toBe("naladda-2576")
  })

  it("404s for an email no account uses", async () => {
    const res = await lookup("lead-2576", "nobody@example.com", PROJECT)
    expect(res.status).toBe(404)
  })

  it("still resolves a plain username when scoped to a project", async () => {
    const res = await lookup("lead-2576", "naladda-2576", PROJECT)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { username: string }).username).toBe("naladda-2576")
  })

  it("refuses the email oracle to a caller with no access to the named project", async () => {
    const res = await lookup("bystander-2576", "naladda-2576@example.com", PROJECT)
    expect(res.status).toBe(403)
  })

  it("refuses the email oracle to a project member below the add-member floor", async () => {
    const res = await lookup("viewer-2576", "naladda-2576@example.com", PROJECT)
    expect(res.status).toBe(403)
  })

  it("refuses before looking up, so the denial cannot confirm the address exists", async () => {
    const real = await lookup("bystander-2576", "naladda-2576@example.com", PROJECT)
    const fake = await lookup("bystander-2576", "nobody-at-all@example.com", PROJECT)
    expect(real.status).toBe(403)
    expect(fake.status).toBe(403)
    expect(await real.json()).toEqual(await fake.json())
  })

  it("leaves the unscoped route username-only: an email there is a 400, never a hit", async () => {
    const res = await lookup("bystander-2576", "naladda-2576@example.com")
    expect(res.status).toBe(400)
  })

  it("leaves the unscoped username lookup working exactly as before", async () => {
    const res = await lookup("bystander-2576", "naladda-2576")
    expect(res.status).toBe(200)
    expect(((await res.json()) as { username: string }).username).toBe("naladda-2576")
  })
})
