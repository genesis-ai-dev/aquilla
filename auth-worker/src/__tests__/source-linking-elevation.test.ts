// OPSEC review 2026-11-02 (OPS-51): the source-linking router's floors are
// satisfied by platform-admin power alone, on every project on the platform.
//
// `resolveProjectRole` contributes { source: "platform", level: 700 } for every
// platform operator, so LINK_MIN_ROLE (500) clears — and so does the OWNER
// floor on `DELETE /:projectId`, because the platform contribution IS 700 and
// `role.level < ROLE.OWNER` is therefore false by definition. An owner-only
// gate in front of an unrecoverable `DELETE FROM projects` was passed by an
// un-elevated admin JWT.
//
// Two things make this worse than "another un-gated write":
//
//   1. routes/projects.ts — the SIBLING router on the same /api/v2/projects
//      mount — requires elevation to remove ONE member or revoke ONE invite
//      (AQU-1322, via projectElevationDenial). Destroying the whole project
//      asked for nothing. routes/merge-sibling.ts already wrote down the rule
//      that decides this: "destroying a donor project outranks [adding one
//      member]" (OPS-44).
//   2. `POST /:projectId/link-source` has an explicit cross-tenant check,
//      added by an earlier pen test with the exploit spelled out in a comment
//      — link your own project to ANY project id on the platform and mirror
//      its source cells. Platform power satisfies that check for free on both
//      sides, which is that same IDOR restored for one principal and made
//      PERSISTENT: a live link is a standing data flow the mirror keeps
//      replaying long after any elevation would have lapsed, so an elevation
//      check at use time can never reach it.
//      (src/__tests__/source-linking-idor.test.ts is the original.)
//
// The rule under test: on this router's six WRITES, platform power is stripped
// unless the session is elevated, then the route's own floor is re-applied to
// what remains. The READS are deliberately left open — AQU-2003 priced
// un-elevated platform access as read-only on our own content, not refused.
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

/** A project plus one direct grant, the shape source-linking-idor.test.ts uses. */
async function seedProject(
  id: string,
  name: string,
  createdBy: number,
  grants: ReadonlyArray<[number, number]> = [],
): Promise<void> {
  await sql("INSERT INTO projects (id, name, created_by) VALUES (?, ?, ?)", id, name, createdBy)
  for (const [userId, level] of grants) {
    await sql(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)",
      id,
      userId,
      level,
    )
  }
}

beforeEach(async () => {
  env.ADMIN_REQUIRE_ELEVATION = "true"

  await seedUser(1, "tenant-lead")
  await seedUser(2, "other-tenant-lead")
  await seedUser(ROOT_ID, "root")

  // Two projects in two tenancies root reaches ONLY through platform power.
  await seedProject("proj-t", "Tenant's Bible", 1, [[1, 700]])
  await seedProject("proj-u", "Another Tenant's Bible", 2, [[2, 700]])
  // A project root GENUINELY owns — the control that must not regress.
  await seedProject("proj-r", "Root's Own", ROOT_ID, [[ROOT_ID, 700]])
  // ... and one of those, trashed: deleting out of Trash is the operator
  // action most likely to be broken by a careless de-escalation, because
  // resolveGenuineProjectRole answers null for an archived project unless
  // asked otherwise.
  await seedProject("proj-r-trash", "Root's Trashed", ROOT_ID, [[ROOT_ID, 700]])
  await sql("UPDATE projects SET archived_at = now() WHERE id = 'proj-r-trash'")
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

const projectExists = async (id: string): Promise<boolean> => {
  const row = await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM projects WHERE id = ?")
    .bind(id)
    .first<{ ok: number }>()
  return row != null
}

const sourceOf = async (id: string): Promise<string | null> => {
  const row = await env.AQUILLA_PG.prepare("SELECT source_project_id FROM projects WHERE id = ?")
    .bind(id)
    .first<{ source_project_id: string | null }>()
  return row?.source_project_id ?? null
}

describe("DELETE /:projectId — the owner floor is not satisfied by un-elevated admin power (OPS-51)", () => {
  it("refuses an un-elevated platform admin, and the project survives", async () => {
    const res = await call("root", "DELETE", "/api/v2/projects/proj-t")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: "elevation required to delete a project with platform-admin access",
    })
    expect(await projectExists("proj-t")).toBe(true)
  })

  it("allows it once the session is elevated", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call("root", "DELETE", "/api/v2/projects/proj-t", undefined, jwt)
    expect(res.status).toBe(200)
    expect(await projectExists("proj-t")).toBe(false)
  })

  it("leaves an ordinary owner alone", async () => {
    const res = await call("tenant-lead", "DELETE", "/api/v2/projects/proj-t")
    expect(res.status).toBe(200)
    expect(await projectExists("proj-t")).toBe(false)
  })

  it("does not lock an operator out of a project they genuinely own", async () => {
    const res = await call("root", "DELETE", "/api/v2/projects/proj-r")
    expect(res.status).toBe(200)
    expect(await projectExists("proj-r")).toBe(false)
  })

  it("does not lock an operator out of their own TRASHED project", async () => {
    const res = await call("root", "DELETE", "/api/v2/projects/proj-r-trash")
    expect(res.status).toBe(200)
    expect(await projectExists("proj-r-trash")).toBe(false)
  })

  it("still refuses a member below the floor, with the pre-OPS-51 wording", async () => {
    // Not `tenant-lead`: they are proj-t's `created_by`, which contributes
    // creator:700 on its own, so demoting their membership row changes nothing.
    await sql(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-t', 2, 500, 1)",
    )
    const res = await call("other-tenant-lead", "DELETE", "/api/v2/projects/proj-t")
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "only owners can delete a project" })
    expect(await projectExists("proj-t")).toBe(true)
  })
})

describe("POST /:projectId/link-source — the cross-tenant IDOR check is not satisfied by admin power (OPS-51)", () => {
  it("refuses an un-elevated platform admin linking one tenant to another, and records no link", async () => {
    const res = await call("root", "POST", "/api/v2/projects/proj-t/link-source", {
      sourceProjectId: "proj-u",
      mode: "clone",
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: "elevation required to link a project's source with platform-admin access",
    })
    expect(await sourceOf("proj-t")).toBeNull()
  })

  it("refuses when only the UPSTREAM side rests on admin power", async () => {
    // root genuinely owns the downstream, so the first check passes on a real
    // grant; the upstream is another tenant's and must still be refused.
    const res = await call("root", "POST", "/api/v2/projects/proj-r/link-source", {
      sourceProjectId: "proj-u",
      mode: "clone",
    })
    expect(res.status).toBe(403)
    expect(await sourceOf("proj-r")).toBeNull()
  })

  it("allows it once the session is elevated", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call(
      "root",
      "POST",
      "/api/v2/projects/proj-t/link-source",
      { sourceProjectId: "proj-u", mode: "clone" },
      jwt,
    )
    expect(res.status).toBe(200)
    expect(await sourceOf("proj-t")).toBe("proj-u")
  })

  it("leaves a lead with genuine access to both sides alone", async () => {
    await sql(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-u', 1, 500, 1)",
    )
    const res = await call("tenant-lead", "POST", "/api/v2/projects/proj-t/link-source", {
      sourceProjectId: "proj-u",
      mode: "clone",
    })
    expect(res.status).toBe(200)
    expect(await sourceOf("proj-t")).toBe("proj-u")
  })
})

describe("the rest of the write surface narrows too (OPS-51)", () => {
  it.each([
    ["POST", "/api/v2/projects/proj-t/detach-source", undefined,
      "elevation required to detach a project's source with platform-admin access"],
    ["POST", "/api/v2/projects/proj-t/link-source/files", { fileIds: ["f1"] },
      "elevation required to change a link's files with platform-admin access"],
    ["POST", "/api/v2/projects/proj-t/link-source/files/stop", { fileIds: ["f1"] },
      "elevation required to change a link's files with platform-admin access"],
  ])("%s %s refuses an un-elevated platform admin", async (method, path, body, error) => {
    const res = await call("root", method, path, body)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error })
  })

  it("detach-source still works for an operator's own project", async () => {
    await sql(
      "UPDATE projects SET source_project_id = 'proj-t', source_link_mode = 'clone' WHERE id = 'proj-r'",
    )
    const res = await call("root", "POST", "/api/v2/projects/proj-r/detach-source")
    expect(res.status).toBe(200)
    expect(await sourceOf("proj-r")).toBeNull()
  })
})

describe("the reads stay open to an un-elevated platform admin (AQU-2003)", () => {
  it("GET /:projectId/downstreams answers", async () => {
    await sql("UPDATE projects SET source_project_id = 'proj-t' WHERE id = 'proj-u'")
    const res = await call("root", "GET", "/api/v2/projects/proj-t/downstreams")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projectId: "proj-t", downstreams: ["proj-u"] })
  })

  it("GET /:projectId/link-source/files gets past the guard", async () => {
    // 409 "not linked" is the answer for an unlinked project: reaching it
    // proves the guard did not refuse. A 403 here would be the regression.
    const res = await call("root", "GET", "/api/v2/projects/proj-t/link-source/files")
    expect(res.status).toBe(409)
  })

  it("POST /:projectId/link-source/match gets past the guard", async () => {
    const res = await call("root", "POST", "/api/v2/projects/proj-t/link-source/match", {
      sourceProjectId: "proj-u",
      files: [{ upstreamFileId: "f1", fileId: "f2" }],
    })
    expect(res.status).not.toBe(403)
  })
})
