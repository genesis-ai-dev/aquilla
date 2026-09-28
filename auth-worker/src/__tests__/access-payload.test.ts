/**
 * AQU-1352 P4 — GET /api/v2/users/:userId/access (spec §3.8).
 *
 * The inspector must explain access without leaking it: rule 4 says a viewer
 * sees only grants inside scopes they can see themselves, an org Owner sees
 * the whole org, and a person always sees their own full picture. Rule 5
 * labels guests (no org row). Runs on the shared characterization fixture so
 * the "effective here" answer is the same one the resolver pins.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor } from "./helpers/db"
import { FIXTURE_USERS, seedAccessFixture, type FixtureUser } from "./helpers/access-fixture"

interface Entry {
  scopePath: { type: string; id: string; name: string }[]
  roleLevel: number | null
  origin: { kind: string; from?: { type: string; name: string }[] }
  grantedBy?: string
}
interface Payload {
  userId: string
  displayName: string
  isGuest: boolean
  effectiveHere: { roleLevel: number | null; chain: Entry[] }
  elsewhere: Entry[]
}

async function access(viewer: FixtureUser, subject: FixtureUser, from: string): Promise<Response> {
  return app.request(
    `/api/v2/users/${FIXTURE_USERS[subject]}/access?from=${from}`,
    { headers: authHeader(await jwtFor(viewer)) },
    env,
  )
}

const inner = (e: Entry) => e.scopePath[e.scopePath.length - 1]
const projectIds = (es: Entry[]) => es.filter((e) => inner(e)?.type === "project").map((e) => inner(e).id).sort()

beforeEach(async () => {
  await seedAccessFixture()
})

describe("AQU-1352 §3.8 member access payload", () => {
  it("self sees their full picture: team_only on p1 is Contributor via the team, org in the chain, p2 elsewhere", async () => {
    const res = await access("team_only", "team_only", "project:p1")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Payload
    // Same answer as the characterization matrix (team 400 beats org 300).
    expect(body.effectiveHere.roleLevel).toBe(400)
    const top = body.effectiveHere.chain[0]
    expect(top.origin.kind).toBe("inherited")
    expect(top.origin.from?.map((r) => r.name)).toEqual(["Fixture Org", "fixture/translators"])
    expect(top.grantedBy).toBe("owner") // named, not a raw user id
    expect(projectIds(body.elsewhere)).toEqual(["p2"])
    // AQU-1274: org 300 contributes here (a team opens p1, no direct row), so it
    // is part of the chain, not "everything else".
    expect(body.effectiveHere.chain.some((e) => inner(e)?.type === "org")).toBe(true)
    expect(body.isGuest).toBe(false)
  })

  it("org owner sees every grant the subject holds in the org", async () => {
    const res = await access("owner", "direct_above", "org:1")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Payload
    expect(body.effectiveHere.roleLevel).toBe(300)
    // direct p1 row + team rows on p1 and p2 — nothing withheld from an Owner.
    expect(projectIds(body.elsewhere)).toEqual(["p1", "p1", "p2"])
  })

  it("a lead in project A cannot see the subject's grants in project B or the org roster", async () => {
    // direct_above is 600 on p1 (passes the roster floor) but only 400 on p2 via the team,
    // and org 300 — below the default roster floor. Rule 4: p2 and org rows must not ship.
    const res = await access("direct_above", "team_only", "project:p1")
    expect(res.status).toBe(200)
    const body = (await res.json()) as Payload
    expect(body.effectiveHere.roleLevel).toBe(400)
    expect(body.elsewhere).toEqual([])
    expect(JSON.stringify(body)).not.toContain('"p2"')
  })

  it("an outsider gets 403 rather than an empty-but-revealing payload", async () => {
    expect((await access("personal", "team_only", "org:1")).status).toBe(403)
    expect((await access("personal", "team_only", "project:p1")).status).toBe(403)
  })

  it("labels a user with no org row as a guest (rule 5) but not an org Guest-role member", async () => {
    const external = (await (await access("owner", "external", "project:p2")).json()) as Payload
    expect(external.isGuest).toBe(true)
    expect(external.effectiveHere.roleLevel).toBe(300)
    const tim = (await (await access("owner", "tim", "project:p3")).json()) as Payload
    expect(tim.isGuest).toBe(false)
  })

  it("rejects a malformed from parameter", async () => {
    expect((await access("owner", "tim", "lane:x")).status).toBe(400)
  })
})
