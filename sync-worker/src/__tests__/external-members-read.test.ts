// AQU-2403 — the MCP membership surface: the `list_members` roster read and the
// three connector operations (prepare_invite_member / prepare_set_role /
// prepare_remove_member) that let a membership change be staged from an OAuth
// connection at all.
//
// The roster is the half that needed real tests. Its whole value is that an
// agent does not have to probe a GOVERNANCE surface to discover its state, so
// the properties asserted here are:
//
//   1. It agrees with the gate. Every row's `role` must equal what
//      resolveProjectRoleShared — the function commands-membership.ts's caps
//      are evaluated against — resolves for that user. A roster that disagreed
//      would hand an agent a plan the gate then refuses.
//   2. It is floored at MAINTAINER, the same floor as changing membership, and
//      a caller below it gets permission_denied rather than an empty list.
//   3. `direct` tells InviteMember from SetRole, including for the people who
//      hold the project with no direct row at all (org / team / creator).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// mcp-handlers reaches the commit path, which loads broadcast.ts → partyserver
// (cloudflare:*). Same stub the other external suites use.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { handleExternalMcpRequest } from '../external/mcp-route'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { callChatGptTool } from '../external/mcp-chatgpt'
import { UNKNOWN_TOOL } from '../external/mcp-handlers'
import { validateApiCredentialRequest } from '../../../db/shared/api-credentials'
import { handleExternalReadRequest } from '../external/read-routes'
import { listProjectMembers, MEMBERS_MAX_ROWS, MEMBERS_READ_FLOOR } from '../external/members-read'
import { MEMBERSHIP_FLOOR } from '../external/commands-membership'
import { MCP_TOOLS } from '../external/mcp-tools'
import { CHATGPT_TOOLS } from '../external/mcp-chatgpt-tools'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { resolveProjectRoleShared } from '../../../db/shared/project-roles'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-members'
const CRED = '00000000-0000-0000-0000-0000000000aa'

const ROLE = {
  VIEWER: 100,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
}

// One user per grant path, so the roster is exercised on all four at once.
const CREATOR = { id: 1, name: 'cora' }        // owner via the creator path, no row
const CALLER = { id: 2, name: 'mack' }         // direct MAINTAINER — the agent's user
const DIRECT = { id: 3, name: 'ana' }          // direct CONTRIBUTOR
const ORG_MAINT = { id: 4, name: 'olga' }      // org MAINTAINER, no project row
const ORG_LOW = { id: 5, name: 'lenny' }       // org VIEWER and nothing else
const TEAM = { id: 6, name: 'tess' }           // PROJECT_LEAD through a team grant

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

let tdb: TestDb
afterEach(async () => { await tdb?.close() })

beforeEach(async () => {
  tdb = await makeTestDb({})
  for (const u of [CREATOR, CALLER, DIRECT, ORG_MAINT, ORG_LOW, TEAM]) {
    await tdb.pg.query(
      `INSERT INTO users (id, username, email, password_hash) VALUES ($1, $2, $3, 'h')`,
      [u.id, u.name, `${u.name}@x.com`],
    )
  }
  await tdb.pg.query(
    `INSERT INTO organizations (id, name, owner_user_id) VALUES (7, 'Org', $1)`,
    [CREATOR.id],
  )
  await tdb.pg.query(
    `INSERT INTO projects (id, name, created_by, org_id) VALUES ($1, 'P', $2, 7)`,
    [PROJECT, CREATOR.id],
  )
  await tdb.pg.query(
    `INSERT INTO project_members (project_id, user_id, role_level) VALUES ($1, $2, $3), ($1, $4, $5)`,
    [PROJECT, CALLER.id, ROLE.MAINTAINER, DIRECT.id, ROLE.CONTRIBUTOR],
  )
  await tdb.pg.query(
    `INSERT INTO org_members (org_id, user_id, role_level) VALUES (7, $1, $2), (7, $3, $4)`,
    [ORG_MAINT.id, ROLE.MAINTAINER, ORG_LOW.id, ROLE.VIEWER],
  )
  await tdb.pg.query(
    `INSERT INTO groups (id, org_id, name, created_by) VALUES (8, 7, 'Team', $1)`,
    [CREATOR.id],
  )
  await tdb.pg.query(`INSERT INTO group_members (group_id, user_id) VALUES (8, $1)`, [TEAM.id])
  await tdb.pg.query(
    `INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (8, $1, $2)`,
    [PROJECT, ROLE.PROJECT_LEAD],
  )
})

/** Mint a PAT for one seeded user. */
async function credToken(userId: number, mode: 'ask' | 'act' = 'act'): Promise<string> {
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, $2, 'test', $3, $4, $5, NULL, $6)`,
    [CRED, String(userId), tokenPrefix, tokenHash, mode, PROJECT],
  )
  return token
}

async function restMembers(token: string): Promise<{ status: number; body: any }> {
  const res = await handleExternalReadRequest(
    new Request(`https://w/api/v1/external/projects/${PROJECT}/members`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    makeEnv(tdb.db),
  )
  return { status: res!.status, body: await res!.json() }
}

async function callTool(token: string, name: string, args: unknown): Promise<any> {
  const res = await handleExternalMcpRequest(
    new Request('https://w/api/v1/external/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    makeEnv(tdb.db),
  )
  const body = (await res!.json()) as any
  return {
    payload: JSON.parse(body.result.content[0].text),
    isError: body.result.isError === true,
  }
}

describe('list_members roster', () => {
  it('lists every grant path with its effective role, source and direct flag', async () => {
    const token = await credToken(CALLER.id)
    const { status, body } = await restMembers(token)
    expect(status).toBe(200)
    expect(body.nextCursor).toBeNull()
    expect(body.total).toBe(5)
    expect(body.truncated).toBe(false)
    expect(body.data).toEqual([
      // Highest role first, then username.
      { userId: String(CREATOR.id), username: 'cora', role: 700, roleName: 'owner', roleSource: 'creator', direct: false },
      { userId: String(CALLER.id), username: 'mack', role: 600, roleName: 'maintainer', roleSource: 'override', direct: true },
      { userId: String(ORG_MAINT.id), username: 'olga', role: 600, roleName: 'maintainer', roleSource: 'org', direct: false },
      { userId: String(TEAM.id), username: 'tess', role: 500, roleName: 'project_lead', roleSource: 'group', direct: false },
      { userId: String(DIRECT.id), username: 'ana', role: 400, roleName: 'contributor', roleSource: 'override', direct: true },
    ])
  })

  it('omits a sub-maintainer org member with no other path into the project', async () => {
    // AQU-435: an org role below MAINTAINER opens no project on its own, so
    // lenny is not a member here. The roster must not imply he is.
    const token = await credToken(CALLER.id)
    const { body } = await restMembers(token)
    expect(body.data.map((m: { username: string }) => m.username)).not.toContain('lenny')
  })

  it('agrees with the role the membership gate will resolve for the same user', async () => {
    // The drift pin. commands-membership.ts judges its caps with
    // resolveProjectRoleShared; the roster resolves the view twin. If the two
    // ever diverge, a maintainer reading the roster would build plans the gate
    // refuses (or, worse, believe a target is below them when it is not).
    const roster = (await listProjectMembers(tdb.db, PROJECT))?.members
    expect(roster).toBeDefined()
    for (const row of roster!) {
      const gate = await resolveProjectRoleShared(tdb.db, { id: row.userId }, PROJECT)
      expect(gate?.level, `level for ${row.username}`).toBe(row.role)
      expect(gate?.source, `source for ${row.username}`).toBe(row.roleSource)
    }
    // And nobody the gate grants a role to is missing from the roster.
    for (const u of [CREATOR, CALLER, DIRECT, ORG_MAINT, ORG_LOW, TEAM]) {
      const gate = await resolveProjectRoleShared(tdb.db, { id: String(u.id) }, PROJECT)
      const listed = roster!.some((r) => r.userId === String(u.id))
      expect(listed, `${u.name} listed`).toBe(gate !== null)
    }
  })

  it('refuses a caller below the maintainer floor with permission_denied, not an empty list', async () => {
    const token = await credToken(DIRECT.id) // contributor
    const { status, body } = await restMembers(token)
    expect(status).toBe(403)
    expect(body.error.code).toBe('permission_denied')
    expect(body.error.details).toEqual({ requiredRole: MEMBERS_READ_FLOOR })
  })

  it('is floored exactly where changing membership is floored', () => {
    expect(MEMBERS_READ_FLOOR).toBe(MEMBERSHIP_FLOOR)
  })

  it('serves the same roster through the MCP list_members tool', async () => {
    const token = await credToken(CALLER.id)
    const { payload, isError } = await callTool(token, 'list_members', { projectId: PROJECT })
    expect(isError).toBe(false)
    expect((payload as any).data.map((m: { username: string }) => m.username)).toEqual([
      'cora', 'mack', 'olga', 'tess', 'ana',
    ])
  })

  it('propagates the floor refusal through MCP as a tool error', async () => {
    const token = await credToken(DIRECT.id)
    const { payload, isError } = await callTool(token, 'list_members', { projectId: PROJECT })
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('permission_denied')
  })

  it('declares list_members as a read-only tool', () => {
    const tool = MCP_TOOLS.find((t) => t.name === 'list_members')
    expect(tool).toBeDefined()
    expect(tool!.annotations.readOnlyHint).toBe(true)
    expect(tool!.annotations.destructiveHint).toBe(false)
  })
})

describe('membership operations on the OAuth connector', () => {
  it('declares one tool per membership command', () => {
    const names = CHATGPT_TOOLS.map((t) => t.name)
    expect(names).toContain('list_members')
    expect(names).toContain('prepare_invite_member')
    expect(names).toContain('prepare_set_role')
    expect(names).toContain('prepare_remove_member')
  })

  it('does not let the connector schema carry a kind field', () => {
    for (const name of ['prepare_invite_member', 'prepare_set_role', 'prepare_remove_member']) {
      const tool = CHATGPT_TOOLS.find((t) => t.name === name)!
      const item = (tool.inputSchema.properties.updates as { items: { properties: Record<string, unknown> } }).items
      expect(Object.keys(item.properties)).not.toContain('kind')
      expect(Object.keys(item.properties)).toContain('username')
    }
  })

  it('stages an invite through the connector dispatch itself, not just the catalog', async () => {
    // The gap was on the OAuth connector, where prepare_translations does not
    // accept `commands` at all — the only way in is a per-operation tool. So
    // drive callChatGptTool, the connector's own dispatch, end to end.
    const token = await credToken(CALLER.id, 'act')
    const env = makeEnv(tdb.db)
    const req = new Request('https://w/api/v1/external/mcp', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const cred = await validateApiCredentialRequest(tdb.db, req)
    expect(cred).not.toBeNull()

    const res = await callChatGptTool(
      'prepare_invite_member',
      { projectId: PROJECT, updates: [{ projectId: PROJECT, username: 'lenny', role: ROLE.CONTRIBUTOR }] },
      env,
      cred!,
      token,
    )
    expect(res).not.toBe(UNKNOWN_TOOL)
    const payload = JSON.parse((res as { content: { text: string }[] }).content[0].text)
    expect(payload.error).toBeUndefined()
    expect(payload.mode).toBe('ask')
    expect(payload.approvalUrl).toBeTruthy()
    expect(payload.summary.membershipChanges).toEqual([
      `Add lenny to ${PROJECT} as contributor (400)`,
    ])

    // And the connector will accept a confirm for it — the kind is declared,
    // so isReviewedCommand does not treat it as an undeclared operation.
    const confirm = await callChatGptTool(
      'confirm_changeset',
      { projectId: PROJECT, changesetId: payload.changesetId, digest: payload.digest },
      env,
      cred!,
      token,
    )
    const confirmPayload = JSON.parse((confirm as { content: { text: string }[] }).content[0].text)
    // Ask-mode governance: it must stop at the human approval, NOT at
    // "unavailable on this connection".
    expect(confirmPayload.error?.code).toBe('confirmation_required')
  })

  it('stages InviteMember from prepare_translations in ask mode even on an act credential', async () => {
    // Governance: prepareMembership forces ask-mode, so the approvalUrl is
    // present and the plan cannot be committed straight from the connection.
    const token = await credToken(CALLER.id, 'act')
    const { payload, isError } = await callTool(token, 'prepare_translations', {
      projectId: PROJECT,
      commands: [{ kind: 'InviteMember', projectId: PROJECT, username: 'lenny', role: ROLE.CONTRIBUTOR }],
    })
    expect(isError).toBe(false)
    expect((payload as any).mode).toBe('ask')
    expect((payload as any).approvalUrl).toBeTruthy()
    expect((payload as any).summary.membershipChanges).toEqual([
      `Add lenny to ${PROJECT} as contributor (400)`,
    ])
  })

  it('refuses a grant above the caller, so the roster cannot be used to escalate', async () => {
    const token = await credToken(CALLER.id)
    const { payload, isError } = await callTool(token, 'prepare_translations', {
      projectId: PROJECT,
      commands: [{ kind: 'InviteMember', projectId: PROJECT, username: 'lenny', role: ROLE.OWNER }],
    })
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('permission_denied')
  })

  it('rejects SetRole on somebody the roster reports as direct: false', async () => {
    // olga holds the project through the org — `direct: false` in the roster,
    // and the engine's `not_a_direct_member` conflict here. The roster exists
    // so an agent picks InviteMember without discovering this the hard way.
    const token = await credToken(CREATOR.id) // owner: no target cap in the way
    const { payload, isError } = await callTool(token, 'prepare_translations', {
      projectId: PROJECT,
      commands: [{ kind: 'SetRole', projectId: PROJECT, username: 'olga', role: ROLE.VIEWER }],
    })
    expect(isError).toBe(true)
    expect((payload as any).error.code).toBe('conflict')
    expect((payload as any).error.details).toMatchObject({ code: 'not_a_direct_member' })
  })
})

describe('discovery drift guards', () => {
  it('publishes the roster route and the three membership kinds in the REST API map', async () => {
    // The gap AQU-2403 was filed for was discoverability, so the map that an
    // agent cold-starts from has to name both halves or the feature is still
    // only reachable by somebody who read the source.
    const res = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))!
    const text = JSON.stringify(await res.json())
    expect(text).toContain('/api/v1/external/projects/:projectId/members')
    for (const kind of ['InviteMember', 'SetRole', 'RemoveMember']) {
      expect(text, `${kind} in the command-kinds list`).toContain(kind)
    }
  })

  it('declares list_members in get_capabilities, with the membership contract', async () => {
    const token = await credToken(CALLER.id)
    const { payload } = await callTool(token, 'get_capabilities', {})
    const membership = (payload as any).membership
    expect(membership.readTool).toBe('list_members')
    expect(membership.commandKinds).toEqual(['InviteMember', 'SetRole', 'RemoveMember'])
    expect(membership.note).toContain('MAINTAINER')
    expect(membership.note).toContain('ask-mode')
  })
})

describe('roster size cap', () => {
  it('reports total and truncated instead of silently returning a short list', async () => {
    // An org whose members all reach the project through the org path is the
    // shape that makes an uncapped roster unbounded. The cap must announce
    // itself, and must keep the TOP of the ladder — a membership command can
    // only be aimed at somebody at or below the caller, so cutting the
    // high-role rows would cut exactly the rows that matter.
    const extra = MEMBERS_MAX_ROWS + 10
    const values: string[] = []
    const params: unknown[] = []
    for (let i = 0; i < extra; i++) {
      params.push(1000 + i, `bulk${String(i).padStart(4, '0')}`, `bulk${i}@x.com`)
      values.push(`($${params.length - 2}, $${params.length - 1}, $${params.length}, 'h')`)
    }
    await tdb.pg.query(
      `INSERT INTO users (id, username, email, password_hash) VALUES ${values.join(', ')}`,
      params,
    )
    // Org MAINTAINER, so every one of them resolves to 600 on this project.
    await tdb.pg.query(
      `INSERT INTO org_members (org_id, user_id, role_level)
       SELECT 7, id, $1 FROM users WHERE id >= 1000`,
      [ROLE.MAINTAINER],
    )

    const token = await credToken(CALLER.id)
    const { status, body } = await restMembers(token)
    expect(status).toBe(200)
    expect(body.truncated).toBe(true)
    expect(body.total).toBe(5 + extra)
    expect(body.data).toHaveLength(MEMBERS_MAX_ROWS)
    // cora (owner, 700) survives the cut; ana (contributor, 400) does not.
    expect(body.data[0].username).toBe('cora')
    expect(body.data.every((m: { role: number }) => m.role >= ROLE.MAINTAINER)).toBe(true)
  })
})
