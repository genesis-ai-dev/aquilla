/**
 * AQU-1352 attack suite — URL guessing (ticket "try to break it" #1) and
 * inspector / People & access scoping (#6).
 *
 * Why: the redesign moves every "who can see what" answer onto one resolver
 * and one viewer filter. If either fails open, a user can read another
 * project's name or roster just by typing its id. These attacks run under
 * ACCESS_GRANTS_RESOLVER off AND on, so flipping the flag cannot open a hole.
 * Denial is not enough: the 403/404 body must not echo names either.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { FIXTURE_USERS, seedAccessFixture } from "./helpers/access-fixture"
import { RESOLVER_MODES, TEAM_LEAD, req, seedTeamLead } from "./helpers/attack"

const PROJECT_NAMES: Record<string, string> = {
  p1: "Alpha",
  p2: "Beta",
  p3: "Gamma",
  p_archived: "Delta (archived)",
  p_personal: "Personal",
  ghost: "",
}
const ALL_PROJECTS = Object.keys(PROJECT_NAMES)
const OTHER_USERNAMES = ["maintainer", "direct_below", "direct_above", "creator", "external", "tim", "personal"]
const HIDDEN_TEAMS = ["fixture/leads", "fixture/translators"]

// Attacker → projects they legitimately open (everything else must be denied).
const ATTACKERS: Array<{ name: string; allowed: string[] }> = [
  { name: "org_contrib", allowed: [] },
  { name: TEAM_LEAD.name, allowed: ["p1"] },
]

function probes(pid: string): Array<{ label: string; method: string; path: string; body?: unknown }> {
  return [
    { label: "project GET", method: "GET", path: `/api/v2/projects/${pid}` },
    { label: "settings GET", method: "GET", path: `/api/v2/projects/${pid}/settings` },
    { label: "members GET", method: "GET", path: `/api/v2/projects/${pid}/members` },
    { label: "invites GET", method: "GET", path: `/api/v2/projects/${pid}/invites` },
    {
      label: "inspector",
      method: "GET",
      path: `/api/v2/users/${FIXTURE_USERS.owner}/access?from=project:${pid}`,
    },
    { label: "rename PATCH", method: "PATCH", path: `/api/v2/projects/${pid}`, body: { name: "pwned" } },
    {
      label: "settings PATCH",
      method: "PATCH",
      path: `/api/v2/projects/${pid}/settings`,
      body: { settings: { pwned: true }, ifMatchVersion: 0 },
    },
    { label: "archive POST", method: "POST", path: `/api/v2/projects/${pid}/archive` },
    { label: "members POST", method: "POST", path: `/api/v2/projects/${pid}/members`, body: { username: "tim", role: 300 } },
    { label: "invite POST", method: "POST", path: `/api/v2/projects/${pid}/invites`, body: { role: 300 } },
  ]
}

function assertNoLeak(text: string, attacker: string, pid: string): void {
  for (const [id, name] of Object.entries(PROJECT_NAMES)) {
    if (!name) continue
    expect(text, `${attacker} ${pid}: leaked project name of ${id}`).not.toContain(name)
  }
  for (const u of OTHER_USERNAMES) expect(text, `${attacker} ${pid}: leaked username ${u}`).not.toContain(`"${u}"`)
  for (const t of HIDDEN_TEAMS) expect(text, `${attacker} ${pid}: leaked team ${t}`).not.toContain(t)
  expect(text).not.toContain("Fixture Org")
}

beforeEach(async () => {
  await seedAccessFixture()
  await seedTeamLead()
})

describe.each(RESOLVER_MODES)("AQU-1352 attack #1 URL guessing (resolver %s)", (mode) => {
  for (const { name: attacker, allowed } of ATTACKERS) {
    const denied = ALL_PROJECTS.filter((p) => !allowed.includes(p))
    it(`${attacker} is denied on every project they cannot open, with no names in the body`, async () => {
      for (const pid of denied) {
        for (const p of probes(pid)) {
          const res = await req(mode, attacker, p.path, { method: p.method, body: p.body })
          expect([403, 404], `${attacker} ${p.label} ${pid} → ${res.status} ${res.text}`).toContain(res.status)
          assertNoLeak(res.text, attacker, pid)
        }
      }
    })
  }

  it("the denied writes changed nothing (names, settings, archive flags intact)", async () => {
    for (const pid of ["p2", "p3", "p_personal"]) {
      for (const p of probes(pid)) await req(mode, "org_contrib", p.path, { method: p.method, body: p.body })
    }
    const rows = await env.AQUILLA_PG.prepare(
      "SELECT id, name, archived_at FROM projects ORDER BY id",
    ).all<{ id: string; name: string; archived_at: string | null }>()
    const byId = Object.fromEntries((rows.results ?? []).map((r) => [r.id, r]))
    expect(byId.p2.name).toBe("Beta")
    expect(byId.p3.name).toBe("Gamma")
    expect(byId.p2.archived_at).toBeNull()
  })

  it("team_lead on its own project p1 still cannot read the owner's grants outside p1", async () => {
    const res = await req(mode, TEAM_LEAD.name, `/api/v2/users/${FIXTURE_USERS.owner}/access?from=project:p1`)
    if (res.status === 200) {
      for (const n of ["Beta", "Gamma", "Delta (archived)", ...HIDDEN_TEAMS]) expect(res.text).not.toContain(n)
      expect(res.text).not.toContain('"p2"')
      expect(res.text).not.toContain('"p3"')
    } else {
      expect(res.status).toBe(403)
    }
  })

  it("GET /orgs/1/access as org_contrib (no project) exposes no project or team", async () => {
    const res = await req(mode, "org_contrib", `/api/v2/orgs/1/access`)
    expect([200, 403], `org_contrib → ${res.status}`).toContain(res.status)
    for (const n of ["Alpha", "Beta", "Gamma", "Delta (archived)", ...HIDDEN_TEAMS]) {
      expect(res.text, `org_contrib org access leaked ${n}`).not.toContain(n)
    }
  })

  it("GET /orgs/1/access as team_lead exposes no project it cannot open", async () => {
    const res = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/access`)
    expect(res.status).toBe(200)
    for (const n of ["Beta", "Gamma", "Delta (archived)", "fixture/leads"]) expect(res.text).not.toContain(n)
  })

  // AQU-1352 finding: People & access ships the NAME of a team the viewer
  // cannot see. team_lead (org 300, below the roster floor) gets no team
  // structure in `tree`, but people[].grants[].scopePath / origin.from carry
  // {type:"team", name:"fixture/translators"} for other p1 members. The
  // inspector (users/:id/access) marks the same ref hidden:true, name:"" —
  // §3.9 rule 4 is enforced on one surface and not the other.
  it.fails("GET /orgs/1/access as team_lead does not name a team it is not on (rule 4)", async () => {
    const res = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/1/access`)
    expect(res.status).toBe(200)
    expect(res.text).not.toContain("fixture/translators")
  })

  it("GET /orgs/2/access (someone else's personal org) is denied without names", async () => {
    const res = await req(mode, TEAM_LEAD.name, `/api/v2/orgs/2/access`)
    expect([403, 404]).toContain(res.status)
    expect(res.text).not.toContain("Personal")
    expect(res.text).not.toContain("personal")
  })
})

// ── #6 inspector scoping: Project Lead in p1 inspects an org Owner and a guest ──
describe.each(RESOLVER_MODES)("AQU-1352 attack #6 inspector scoping (resolver %s)", (mode) => {
  interface Ref { type: string; id: string; name: string; hidden?: true }
  interface Entry { scopePath: Ref[]; origin: { from?: Ref[] } }
  interface Payload { effectiveHere: { chain: Entry[] }; elsewhere: Entry[] }
  const refs = (p: Payload): Ref[] =>
    [...p.effectiveHere.chain, ...p.elsewhere].flatMap((e) => [...e.scopePath, ...(e.origin.from ?? [])])

  for (const subject of ["owner", "external"] as const) {
    it(`team_lead inspecting ${subject} from p1 sees only p1-scoped grants on the wire`, async () => {
      const res = await req(
        mode,
        TEAM_LEAD.name,
        `/api/v2/users/${FIXTURE_USERS[subject]}/access?from=project:p1`,
      )
      if (res.status !== 200) {
        expect(res.status).toBe(403)
        return
      }
      const body = res.json as Payload
      for (const r of refs(body)) {
        if (r.type === "project") expect(r.id, "a project other than p1 shipped").toBe("p1")
        else if (r.hidden) expect(r.name).toBe("")
      }
      for (const n of ["Beta", "Gamma", "Personal", ...HIDDEN_TEAMS, "Fixture Org"]) {
        expect(res.text, `${subject} payload leaked ${n}`).not.toContain(n)
      }
      // external's only grant is on p2 — the lead of p1 must not learn it exists.
      if (subject === "external") expect(body.elsewhere).toEqual([])
    })
  }
})
