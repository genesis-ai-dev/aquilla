// Auth permission matrix gate (auth-worker half).
//
// Why this exists (docs/RELEASE-RISK-GATES.md "Gates"): a PR that touches the
// auth area is held off the hourly release line until a person signs it off.
// This suite is what lets a green PR skip that person. It sends one request
// per (principal × route) through the worker's fetch handler against the
// shared PGlite access fixture (helpers/access-fixture.ts: one org with every
// membership shape, a second personal org, a platform admin, a removed
// member, an anonymous caller) and compares every observed status to the
// committed golden (auth-worker/permission-matrix/golden.json).
//
// A failure here is not a flake and not a fixture to update by reflex: it
// says the candidate build answers an authorization question differently
// from production. If that is the point of the PR, regenerate the golden
// (UPDATE_AUTH_MATRIX=1 pnpm test permission-matrix) and let the golden diff
// be reviewed; the gate workflow keeps the hold on while golden.json changes.
//
// The forbidden outcome this protects: one org or user seeing or changing
// another's data. Every cross-org cell (the `personal` user on org-1 projects,
// org-1 users on `p_personal`, every non-admin on /admin/*) is in the table.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { env } from "cloudflare:test"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor, seedUser } from "./helpers/db"
import { FIXTURE_USERS, seedAccessFixture, type FixtureUser } from "./helpers/access-fixture"
import type { Env } from "../types"

const UPDATE = process.env.UPDATE_AUTH_MATRIX === "1"
const GOLDEN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../permission-matrix/golden.json",
)

// ── principals ──────────────────────────────────────────────────────────────

/** Extra fixture users beyond helpers/access-fixture.ts. */
const PLATFORM_ADMIN = { id: 20, name: "root" } as const // root@example.com = env.ADMIN_EMAILS
const REMOVED = { id: 13, name: "removed" } as const

type Principal = "anonymous" | FixtureUser | "platform_admin" | "removed_member"

const PRINCIPALS: Principal[] = [
  "anonymous",
  ...(Object.keys(FIXTURE_USERS) as FixtureUser[]),
  "platform_admin",
  "removed_member",
]

async function seedPrincipals(): Promise<void> {
  await seedAccessFixture()
  await seedUser(PLATFORM_ADMIN.id, PLATFORM_ADMIN.name)
  // A member who was granted p1 directly and then removed: the row is gone,
  // the sub-Maintainer org role (300) opens nothing on its own (AQU-435).
  await seedUser(REMOVED.id, REMOVED.name)
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, ?, 300, 1)",
  ).bind(REMOVED.id).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p1', ?, 400, 1)",
  ).bind(REMOVED.id).run()
  await env.AQUILLA_PG.prepare("DELETE FROM project_members WHERE project_id = 'p1' AND user_id = ?")
    .bind(REMOVED.id)
    .run()
}

async function headersFor(principal: Principal): Promise<Record<string, string>> {
  if (principal === "anonymous") return { "Content-Type": "application/json" }
  const username =
    principal === "platform_admin" ? PLATFORM_ADMIN.name : principal === "removed_member" ? REMOVED.name : principal
  return authHeader(await jwtFor(username))
}

// ── routes ──────────────────────────────────────────────────────────────────

interface Probe {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  body?: unknown
  /** Distinguishes probes that share method+path but differ in body. */
  label?: string
  /** Reduce a 200 body to the part that says WHOSE data came back. */
  digest?: (json: unknown) => string
}

/** p1: org 1, owner-created. p3: org 1, created by `creator`, team "leads" at
 *  700. p_personal: org 2 (the cross-org target). */
const PROJECTS = ["p1", "p3", "p_personal"] as const
const ORGS = [1, 2] as const

const projectIds = (json: unknown): string =>
  `ids=${((json as { projects?: { id: string }[] })?.projects ?? []).map((p) => p.id).sort().join(",")}`

function probes(): Probe[] {
  const list: Probe[] = [
    { method: "GET", path: "/api/v2/me/create-targets" },
    { method: "GET", path: "/api/v2/users/1/access?from=org:1" },
    { method: "GET", path: "/api/v2/credentials" },
    { method: "GET", path: "/api/v2/admin/overview" },
    { method: "GET", path: "/api/v2/admin/orgs" },
    { method: "GET", path: "/api/v2/admin/users" },
    { method: "GET", path: "/api/v2/admin/projects" },
  ]
  for (const org of ORGS) {
    list.push({ method: "GET", path: `/api/v2/projects?orgId=${org}`, digest: projectIds })
    list.push({ method: "GET", path: `/api/v2/orgs/${org}/access` })
  }
  for (const p of PROJECTS) {
    list.push({ method: "GET", path: `/api/v2/projects/${p}` })
    list.push({ method: "GET", path: `/api/v2/projects/${p}/settings` })
    list.push({ method: "GET", path: `/api/v2/projects/${p}/members` })
    list.push({ method: "GET", path: `/api/v2/projects/${p}/invites` })
    list.push({ method: "GET", path: `/api/v2/projects/${p}/members/me/scopes` })
    list.push({ method: "POST", path: "/api/v2/sync-token", label: p, body: { projectId: p, fileId: "f1" } })
    list.push({ method: "POST", path: "/api/v2/credentials", label: p, body: { name: `t-${p}`, mode: "ask", projectId: p } })
  }
  // Writes last, so a successful one cannot change an earlier read's answer.
  // Each targets a row no other probe depends on: the rename is idempotent for
  // the reads above, `org_contrib` (user 4) holds no project row anywhere, and
  // `direct_below` (user 6) is only read through p1's member list, which ran.
  for (const p of PROJECTS) {
    list.push({ method: "PATCH", path: `/api/v2/projects/${p}`, body: { name: "Renamed" } })
    list.push({ method: "POST", path: `/api/v2/projects/${p}/invites`, body: { role: 300 } })
    list.push({ method: "POST", path: `/api/v2/projects/${p}/members`, body: { username: "org_contrib", role: 300 } })
    list.push({ method: "DELETE", path: `/api/v2/projects/${p}/members/6` })
  }
  return list
}

const PROBES = probes()

const rowKey = (principal: Principal, probe: Probe): string =>
  `${principal} ${probe.method} ${probe.path}${probe.label ? ` [${probe.label}]` : ""}`

// ── golden ──────────────────────────────────────────────────────────────────

type Golden = Record<string, string>

function readGolden(): Golden {
  if (!existsSync(GOLDEN_PATH)) {
    if (UPDATE) return {}
    throw new Error(`${GOLDEN_PATH} missing; run UPDATE_AUTH_MATRIX=1 to create it`)
  }
  return JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Golden
}

const golden = readGolden()
const observed: Golden = {}

const testCtx = {
  waitUntil: (p: Promise<unknown>) => void p.catch(() => {}),
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext

async function send(principal: Principal, probe: Probe): Promise<string> {
  const res = await app.request(
    probe.path,
    {
      method: probe.method,
      headers: await headersFor(principal),
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
    },
    env as unknown as Env,
    testCtx,
  )
  if (res.status === 200 && probe.digest) {
    const text = await res.text()
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      /* digest of a non-JSON 200 is just the status */
    }
    return `200 ${probe.digest(json)}`
  }
  return String(res.status)
}

beforeEach(async () => {
  await seedPrincipals()
})

describe("auth permission matrix gate (auth-worker)", () => {
  it("probes every guarded route family, so the gate can never pass vacuously", () => {
    const keys = PROBES.map((p) => rowKey("owner", p))
    expect(new Set(keys).size, "every probe has its own golden row").toBe(keys.length)
    const families = ["/admin/", "/members", "/invites", "/sync-token", "/credentials", "/access", "/settings"]
    for (const f of families) expect(PROBES.some((p) => p.path.includes(f)), f).toBe(true)
    expect(PRINCIPALS).toContain("anonymous")
    expect(PRINCIPALS).toContain("platform_admin")
    expect(PRINCIPALS).toContain("removed_member")
    expect(PRINCIPALS).toContain("personal") // the cross-org principal
  })

  // The sanity rows a reader checks first. They are also in the golden; this
  // names the invariants in words so a golden regenerated over a regression
  // still fails review.
  it("pins the invariants the forbidden outcome is about", async () => {
    expect(await send("anonymous", { method: "GET", path: "/api/v2/projects/p1" })).toBe("401")
    expect(await send("personal", { method: "GET", path: "/api/v2/projects/p1/members" })).toBe("403")
    expect(await send("owner", { method: "GET", path: "/api/v2/projects/p_personal/members" })).toBe("403")
    expect(await send("owner", { method: "GET", path: "/api/v2/admin/orgs" })).toBe("403")
    expect(await send("removed_member", { method: "POST", path: "/api/v2/sync-token", body: { projectId: "p1", fileId: "f1" } })).toBe("403")
    expect(await send("platform_admin", { method: "GET", path: "/api/v2/admin/orgs" })).toBe("200")
  })

  it.each(PRINCIPALS)("%s: every route answers as the golden says", async (principal) => {
    const diffs: string[] = []
    for (const probe of PROBES) {
      const key = rowKey(principal, probe)
      const value = await send(principal, probe)
      observed[key] = value
      if (UPDATE) continue
      if (!(key in golden)) diffs.push(`${key}: not in golden (observed ${value})`)
      else if (golden[key] !== value) diffs.push(`${key}: golden ${golden[key]} → observed ${value}`)
    }
    if (diffs.length) {
      throw new Error(
        `${diffs.length} permission answer(s) differ from permission-matrix/golden.json\n  ${diffs.join("\n  ")}\n` +
          "If the change is intended, run UPDATE_AUTH_MATRIX=1 and have the golden diff reviewed.",
      )
    }
  })

  it("has no golden row the matrix no longer produces", () => {
    if (UPDATE) return
    const stale = Object.keys(golden).filter((k) => !(k in observed))
    expect(stale).toEqual([])
  })
})

afterAll(() => {
  if (!UPDATE) return
  const ordered: Golden = {}
  for (const key of Object.keys(observed).sort()) ordered[key] = observed[key]
  mkdirSync(path.dirname(GOLDEN_PATH), { recursive: true })
  writeFileSync(GOLDEN_PATH, `${JSON.stringify(ordered, null, 2)}\n`)
})
