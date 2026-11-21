// AQU-2662 — the ORG membership roster: REST `GET /orgs/:orgId/members` and its
// MCP mirror `list_org_members`.
//
// AQU-1235 shipped AddOrgMember / SetOrgRole / RemoveOrgMember with no way to
// READ who holds an org role, so an agent had to probe a governance surface by
// staging a command and reading the refusal back. The properties asserted here
// are the ones that make the roster safe to plan from:
//
//   1. It AGREES WITH THE GATE. Every row's `role` is the same number
//      `resolveOrgMemberLevel` gives the write half, and the read floor is
//      pinned equal to the write floor rather than merely similar to it.
//   2. It is OWNER-floored, and a caller below the floor gets permission_denied
//      rather than an empty list (an empty list would read as "nobody is in
//      this org", which is a different and wrong answer).
//   3. `direct` tells AddOrgMember from SetOrgRole, and `orgOwner` marks the
//      organizations.owner_user_id seat the last-owner guard will not let any
//      of the three commands touch — including a seat held with no
//      `org_members` row at all.
//   4. Scope only ever narrows: a project-scoped credential cannot reach org
//      governance at all, and an org-scoped one cannot name a sibling org.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// mcp-handlers pulls in the commit path (changesets-route → commit.ts →
// events/route → broadcast.ts → partyserver, which imports `cloudflare:*`).
// Same stub every external suite uses; nothing here commits.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalReadRequest } from '../external/read-routes'
import { callTool, type McpToolResult } from '../external/mcp-handlers'
import { MCP_TOOLS } from '../external/mcp-tools'
import {
  listOrgMembers,
  ORG_MEMBERS_MAX_ROWS,
  ORG_MEMBERS_READ_FLOOR,
  resolveOrgMemberLevel,
} from '../external/org-members-read'
import { ORG_MEMBERSHIP_FLOOR } from '../external/org-members-engine'
import { mintApiToken, validateApiCredential } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'
import type { ExternalEnv } from '../external/types'

const SECRET = 'test-secret'

// Users. OWNER_SEAT owns ALPHA through organizations.owner_user_id AND holds a
// 700 row; SEATLESS owns BETA with NO org_members row at all, which is the case
// orgs-list.ts models and a roster built from org_members alone would miss.
const OWNER_SEAT = 1 // 'ada'   — ALPHA's owner seat + a 700 row
const CO_OWNER = 2 // 'bo'     — ALPHA 700 by row only (re-roleable)
const MAINT = 3 // 'cleo'      — ALPHA 600; the partner lead from the ticket
const VIEWER = 4 // 'dev'      — ALPHA 100
const GHOST = 5 // deleted after seeding — a dangling org_members row
const SEATLESS = 6 // 'fin'    — BETA's owner seat, no org_members row
const OUTSIDER = 7 // 'gus'    — in no org

const ALPHA = 10
const BETA = 11

let credSeq = 0

async function seedCredential(
  tdb: TestDb,
  opts: { userId: number; orgId?: number | null; projectId?: string | null },
): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  credSeq += 1
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, 'act', $5, $6)`,
    [
      `00000000-0000-0000-0000-${String(credSeq).padStart(12, '0')}`,
      String(opts.userId),
      tokenPrefix,
      tokenHash,
      opts.orgId != null ? String(opts.orgId) : null,
      opts.projectId ?? null,
    ],
  )
  return token
}

function env(tdb: TestDb) {
  return { AQUILLA_PG: tdb.db, SYNC_SECRET_KEY: SECRET }
}

async function get(tdb: TestDb, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {}
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  const res = await handleExternalReadRequest(new Request(`https://worker${path}`, { headers }), env(tdb))
  if (!res) throw new Error(`no external route matched ${path}`)
  return res
}

interface RosterRow {
  userId: string
  username: string
  role: number
  roleName: string
  roleSource: string
  direct: boolean
  orgOwner: boolean
}

interface RosterBody {
  data?: RosterRow[]
  total?: number
  truncated?: boolean
  nextCursor?: null
  error?: { code: string; message: string; details?: { requiredRole?: number } }
}

async function body(res: Response): Promise<RosterBody> {
  return (await res.json()) as RosterBody
}

/** Run an MCP tool with a real credential resolved from the token. */
async function tool(
  tdb: TestDb,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<RosterBody> {
  const cred = await validateApiCredential(tdb.db, token)
  if (!cred) throw new Error('credential did not validate')
  const result = (await callTool(name, args, env(tdb) as unknown as ExternalEnv, cred, token)) as McpToolResult
  return JSON.parse(result.content[0].text) as RosterBody
}

let tdb: TestDb
afterEach(async () => {
  await tdb?.close()
})

beforeEach(async () => {
  tdb = await makeTestDb({})
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES
       ($1, 'ada', 'ada@x.com', 'h'),
       ($2, 'bo', 'bo@x.com', 'h'),
       ($3, 'cleo', 'cleo@x.com', 'h'),
       ($4, 'dev', 'dev@x.com', 'h'),
       ($5, 'ghost', 'ghost@x.com', 'h'),
       ($6, 'fin', 'fin@x.com', 'h'),
       ($7, 'gus', 'gus@x.com', 'h')`,
    [OWNER_SEAT, CO_OWNER, MAINT, VIEWER, GHOST, SEATLESS, OUTSIDER],
  )
  await tdb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES ($1, 'Alpha', $3), ($2, 'Beta', $4)`,
    [ALPHA, BETA, OWNER_SEAT, SEATLESS],
  )
  await tdb.pg.query(
    `INSERT INTO org_members (org_id, user_id, role_level) VALUES
       ($1, $2, 700), ($1, $3, 700), ($1, $4, 600), ($1, $5, 100), ($1, $6, 400)`,
    [ALPHA, OWNER_SEAT, CO_OWNER, MAINT, VIEWER, GHOST],
  )
  // GHOST's user row goes away but their org_members row stays: a dangling
  // grant, not a member. Nothing on this surface could name them.
  await tdb.pg.query(`DELETE FROM users WHERE id = $1`, [GHOST])
})

describe('AQU-2662 org roster — the floor', () => {
  it('pins the read floor equal to the org-membership write floor', () => {
    expect(ORG_MEMBERS_READ_FLOOR).toBe(ORG_MEMBERSHIP_FLOOR)
  })

  it('an OWNER reads the roster', async () => {
    const token = await seedCredential(tdb, { userId: OWNER_SEAT, orgId: ALPHA })
    const res = await get(tdb, `/api/v1/external/orgs/${ALPHA}/members`, token)
    expect(res.status).toBe(200)
    const b = await body(res)
    expect(b.data?.map((r) => r.username)).toEqual(['ada', 'bo', 'cleo', 'dev'])
    expect(b.total).toBe(4)
    expect(b.truncated).toBe(false)
    expect(b.nextCursor).toBeNull()
  })

  it('a MAINTAINER is refused with permission_denied, never an empty list', async () => {
    const token = await seedCredential(tdb, { userId: MAINT, orgId: ALPHA })
    const res = await get(tdb, `/api/v1/external/orgs/${ALPHA}/members`, token)
    expect(res.status).toBe(403)
    const b = await body(res)
    expect(b.error?.code).toBe('permission_denied')
    expect(b.error?.details?.requiredRole).toBe(ORG_MEMBERS_READ_FLOOR)
    expect(b.data).toBeUndefined()
  })

  it('a non-member of the org is refused the same way', async () => {
    const token = await seedCredential(tdb, { userId: OUTSIDER })
    const res = await get(tdb, `/api/v1/external/orgs/${ALPHA}/members`, token)
    expect(res.status).toBe(403)
    expect((await body(res)).error?.code).toBe('permission_denied')
  })

  it('refuses an unauthenticated request', async () => {
    const res = await get(tdb, `/api/v1/external/orgs/${ALPHA}/members`)
    expect(res.status).toBe(401)
  })
})

describe('AQU-2662 org roster — agreement with the gate', () => {
  it('every row’s role is what resolveOrgMemberLevel gives the write half', async () => {
    const roster = await listOrgMembers(tdb.db, ALPHA)
    expect(roster).not.toBeNull()
    expect(roster!.members.length).toBeGreaterThan(0)
    for (const row of roster!.members) {
      const gateLevel = await resolveOrgMemberLevel(tdb.db, ALPHA, row.userId)
      if (row.direct) {
        // A direct member: the roster reports exactly the row the gate reads.
        expect(row.role).toBe(gateLevel)
      } else {
        // The owner seat held without a row: no row for the gate to find, which
        // is precisely what `direct: false` is telling the caller.
        expect(gateLevel).toBeNull()
      }
    }
  })

  it('reports the org_members level, not a max-wins blend', async () => {
    // ada holds BOTH the owner seat and a 700 row. The seat must not inflate or
    // replace the row — the gate only ever reads the row.
    const roster = await listOrgMembers(tdb.db, ALPHA)
    const ada = roster!.members.find((r) => r.username === 'ada')!
    expect(ada.role).toBe(700)
    expect(ada.roleSource).toBe('member')
    expect(ada.direct).toBe(true)
    expect(ada.orgOwner).toBe(true)
  })
})

describe('AQU-2662 org roster — which command a row permits', () => {
  it('direct members carry roleSource "member" and are re-roleable', async () => {
    const roster = await listOrgMembers(tdb.db, ALPHA)
    const cleo = roster!.members.find((r) => r.username === 'cleo')!
    expect(cleo).toMatchObject({
      role: 600,
      roleName: 'maintainer',
      roleSource: 'member',
      direct: true,
      orgOwner: false,
    })
  })

  it('an owner seat held with NO org_members row is still on the roster', async () => {
    const roster = await listOrgMembers(tdb.db, BETA)
    expect(roster!.total).toBe(1)
    expect(roster!.members[0]).toMatchObject({
      username: 'fin',
      role: 700,
      roleName: 'owner',
      roleSource: 'owner',
      direct: false,
      orgOwner: true,
    })
  })

  it('marks exactly one orgOwner, and it is not every owner', async () => {
    const roster = await listOrgMembers(tdb.db, ALPHA)
    const owners = roster!.members.filter((r) => r.role === 700)
    expect(owners.map((r) => r.username)).toEqual(['ada', 'bo'])
    expect(owners.filter((r) => r.orgOwner).map((r) => r.username)).toEqual(['ada'])
  })

  it('drops a dangling grant whose user was deleted', async () => {
    const roster = await listOrgMembers(tdb.db, ALPHA)
    expect(roster!.members.some((r) => r.userId === String(GHOST))).toBe(false)
    // `total` counts people the roster can name, so it agrees with data.length.
    expect(roster!.total).toBe(roster!.members.length)
  })

  it('orders highest role first, then by username', async () => {
    const roster = await listOrgMembers(tdb.db, ALPHA)
    expect(roster!.members.map((r) => [r.username, r.role])).toEqual([
      ['ada', 700],
      ['bo', 700],
      ['cleo', 600],
      ['dev', 100],
    ])
  })

  it('returns no email addresses', async () => {
    const token = await seedCredential(tdb, { userId: OWNER_SEAT, orgId: ALPHA })
    const res = await get(tdb, `/api/v1/external/orgs/${ALPHA}/members`, token)
    expect(await res.clone().text()).not.toContain('@x.com')
  })

  it('caps the roster at ORG_MEMBERS_MAX_ROWS and says so', async () => {
    // Cheaper than seeding 501 users: assert the invariant the cap rests on,
    // then that an uncapped roster reports truncated: false.
    expect(ORG_MEMBERS_MAX_ROWS).toBe(500)
    const roster = await listOrgMembers(tdb.db, ALPHA)
    expect(roster!.members.length).toBeLessThanOrEqual(ORG_MEMBERS_MAX_ROWS)
    expect(roster!.truncated).toBe(false)
  })
})

describe('AQU-2662 org roster — scope', () => {
  it('an org-scoped credential cannot name a sibling org', async () => {
    // fin owns BETA, so the floor would pass there; the credential is pinned to
    // BETA and ALPHA is somebody else's.
    const token = await seedCredential(tdb, { userId: SEATLESS, orgId: BETA })
    const res = await get(tdb, `/api/v1/external/orgs/${ALPHA}/members`, token)
    expect(res.status).toBe(403)
    expect((await body(res)).error?.code).toBe('scope_denied')
  })

  it('a project-scoped credential cannot reach org governance at all', async () => {
    await tdb.pg.query(`INSERT INTO projects (id, name, created_by, org_id) VALUES ($1, 'P', $2, $3)`, [
      'p-alpha',
      String(OWNER_SEAT),
      ALPHA,
    ])
    // Its own org, and its user is an owner — refused anyway, exactly as
    // resolveOrgMemberGate refuses the write half.
    const token = await seedCredential(tdb, { userId: OWNER_SEAT, projectId: 'p-alpha' })
    const res = await get(tdb, `/api/v1/external/orgs/${ALPHA}/members`, token)
    expect(res.status).toBe(403)
    expect((await body(res)).error?.code).toBe('scope_denied')
  })

  it('an unknown org id is refused by the floor, not answered with an empty roster', async () => {
    // The floor is resolved before the roster, so an org nobody is an owner of
    // — including one that does not exist — is permission_denied. That is the
    // deliberate order: it refuses to confirm whether org 9999 exists.
    const token = await seedCredential(tdb, { userId: OWNER_SEAT })
    const res = await get(tdb, `/api/v1/external/orgs/9999/members`, token)
    expect(res.status).toBe(403)
    expect((await body(res)).error?.code).toBe('permission_denied')
  })

  it('a non-numeric org id is validation_failed', async () => {
    const token = await seedCredential(tdb, { userId: OWNER_SEAT })
    const bad = await get(tdb, `/api/v1/external/orgs/not-a-number/members`, token)
    expect(bad.status).toBe(400)
    expect((await body(bad)).error?.code).toBe('validation_failed')
  })

  it('listOrgMembers returns null for an org that does not exist', async () => {
    expect(await listOrgMembers(tdb.db, 9999)).toBeNull()
  })
})

describe('AQU-2662 org roster — the MCP surface', () => {
  it('publishes list_org_members as a read tool', () => {
    const t = MCP_TOOLS.find((x) => x.name === 'list_org_members')
    expect(t).toBeDefined()
    expect((t!.inputSchema as { required?: string[] }).required).toEqual(['orgId'])
    // The roster is the read an agent must do BEFORE staging, so the tool has
    // to say which fields pick the command.
    for (const field of ['direct', 'orgOwner', 'RemoveOrgMember', 'InviteMember']) {
      expect(t!.description).toContain(field)
    }
  })

  it('returns the same roster through the MCP tool as through REST', async () => {
    const token = await seedCredential(tdb, { userId: OWNER_SEAT, orgId: ALPHA })
    const viaMcp = await tool(tdb, token, 'list_org_members', { orgId: String(ALPHA) })
    const viaRest = await body(await get(tdb, `/api/v1/external/orgs/${ALPHA}/members`, token))
    expect(viaMcp.data).toEqual(viaRest.data)
    expect(viaMcp.total).toBe(viaRest.total)
    expect(viaMcp.truncated).toBe(viaRest.truncated)
  })

  it('refuses a MAINTAINER through MCP with the REST envelope', async () => {
    const token = await seedCredential(tdb, { userId: MAINT, orgId: ALPHA })
    const b = await tool(tdb, token, 'list_org_members', { orgId: String(ALPHA) })
    expect(b.error?.code).toBe('permission_denied')
    expect(b.error?.details?.requiredRole).toBe(ORG_MEMBERS_READ_FLOOR)
    expect(b.data).toBeUndefined()
  })

  it('requires orgId', async () => {
    const token = await seedCredential(tdb, { userId: OWNER_SEAT, orgId: ALPHA })
    const b = await tool(tdb, token, 'list_org_members', {})
    expect(b.error?.code).toBe('validation_failed')
  })

  it('advertises the org-membership surface in get_capabilities', async () => {
    const token = await seedCredential(tdb, { userId: OWNER_SEAT, orgId: ALPHA })
    const caps = await tool(tdb, token, 'get_capabilities')
    const org = (caps as unknown as Record<string, Record<string, unknown>>).orgMembership
    expect(org).toBeDefined()
    expect(org.readTool).toBe('list_org_members')
    expect(org.commandKinds).toEqual(['AddOrgMember', 'SetOrgRole', 'RemoveOrgMember'])
    // The ticket's acceptance criterion: the docs have to carry the
    // "confine an org maintainer to N projects" recipe where an agent will read it.
    expect(String(org.note)).toContain('RemoveOrgMember once')
    expect(String(org.note)).toContain('InviteMember')
  })

  it('lists the org command kinds in the agent-reachable catalog index', async () => {
    const token = await seedCredential(tdb, { userId: OWNER_SEAT, orgId: ALPHA })
    const caps = await tool(tdb, token, 'get_capabilities')
    const commands = (caps as unknown as { commands: { index: { kind: string }[] } }).commands
    const kinds = commands.index.map((c) => c.kind)
    for (const kind of ['AddOrgMember', 'SetOrgRole', 'RemoveOrgMember']) {
      expect(kinds).toContain(kind)
    }
  })
})
