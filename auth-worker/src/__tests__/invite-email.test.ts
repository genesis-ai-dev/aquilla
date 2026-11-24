import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedProject(id: string, name: string) {
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES (?, ?, 1)").bind(id, name).run()
  // AQU-2357: creation writes this Owner row. created_by grants nothing.
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, 1, 700, 1)",
  ).bind(id).run()
}

describe("invite email persistence", () => {
  it("persists the email on create and returns it from preview", async () => {
    await seedUser(1, "wendi")
    await seedProject("pa", "John")
    const created = await app.request(
      "/api/v2/projects/pa/invites",
      { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({ email: "joiner@example.com" }) },
      env,
    )
    expect(created.status).toBe(200)
    const { token } = (await created.json()) as { token: string }

    const row = await env.AQUILLA_PG.prepare("SELECT email FROM project_invites WHERE token = ?").bind(token).first<{ email: string | null }>()
    expect(row?.email).toBe("joiner@example.com")

    const preview = await app.request(`/api/v2/projects/invite-preview/${token}`, {}, env)
    expect(preview.status).toBe(200)
    expect(((await preview.json()) as { email: string | null }).email).toBe("joiner@example.com")
  })

  it("returns null email for an invite created without one", async () => {
    await seedUser(1, "wendi")
    await seedProject("pb", "Mark")
    const created = await app.request(
      "/api/v2/projects/pb/invites",
      { method: "POST", headers: authHeader(await jwtFor("wendi")), body: JSON.stringify({}) },
      env,
    )
    const { token } = (await created.json()) as { token: string }
    const preview = await app.request(`/api/v2/projects/invite-preview/${token}`, {}, env)
    expect(((await preview.json()) as { email: string | null }).email).toBeNull()
  })
})

// AQU-2576: an email-bound invite opened by an account registered under a
// different address used to 403 with "This invite was sent to a different
// email address." and nothing else — not which address it wanted, not which
// account was signed in. Neither the recipient nor the project owner could act
// on that, and two of four Biblica reviewers hit it in one day. The refusal now
// names the invited address with its local part masked: enough for the invited
// person to recognise their own, useless to anyone fishing for one.
describe("email-bound invite rejection names the invited address (AQU-2576)", () => {
  async function mintEmailBoundInvite(project: string, email: string): Promise<string> {
    await seedUser(1, "owner-2576")
    await seedProject(project, "Pattani Malay Bible")
    const created = await app.request(
      `/api/v2/projects/${project}/invites`,
      {
        method: "POST",
        headers: authHeader(await jwtFor("owner-2576")),
        body: JSON.stringify({ email }),
      },
      env,
    )
    expect(created.status).toBe(200)
    return ((await created.json()) as { token: string }).token
  }

  it("masks the invited address in the multi-project accept's 403", async () => {
    const token = await mintEmailBoundInvite("pm1", "naladda@proton.me")
    // seedUser gives this account naladda-other@example.com — a third address,
    // exactly the real case: the invite, the account, and what the owner knew
    // were all different.
    await seedUser(2, "naladda-other")

    const res = await app.request(
      `/api/v2/invites/${token}/accept`,
      { method: "POST", headers: authHeader(await jwtFor("naladda-other")) },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string; code?: string; invitedEmail?: string }
    expect(body.code).toBe("email_mismatch")
    expect(body.invitedEmail).toBe("n…a@proton.me")
    // The unmasked address never leaves the server.
    expect(JSON.stringify(body)).not.toContain("naladda@proton.me")
  })

  it("masks the invited address in the single-project accept's 403 too", async () => {
    const token = await mintEmailBoundInvite("pm2", "manal@biblica.com")
    await seedUser(2, "manalhenry")

    const res = await app.request(
      "/api/v2/projects/accept-invite",
      {
        method: "POST",
        headers: authHeader(await jwtFor("manalhenry")),
        body: JSON.stringify({ token }),
      },
      env,
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code?: string; invitedEmail?: string }
    expect(body.code).toBe("email_mismatch")
    expect(body.invitedEmail).toBe("m…l@biblica.com")
    expect(JSON.stringify(body)).not.toContain("manal@biblica.com")
  })

  it("does not fire for the invited address — the mask is presentation only", async () => {
    const token = await mintEmailBoundInvite("pm3", "joiner@example.com")
    // seedUser mints <username>@example.com, so this account IS the invitee.
    await seedUser(2, "joiner")

    const res = await app.request(
      `/api/v2/invites/${token}/accept`,
      { method: "POST", headers: authHeader(await jwtFor("joiner")) },
      env,
    )
    // The matching account passes the mismatch gate. (It still meets the
    // AQU-1579 verified-email gate after it, which this case does not seed —
    // what matters here is that the comparison still runs on the real
    // address, not the masked one.)
    const body = res.ok ? {} : ((await res.json()) as { code?: string })
    expect(body.code).not.toBe("email_mismatch")
  })
})
