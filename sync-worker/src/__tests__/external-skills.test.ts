// Agent skills (AQU-1294 §2.3): the project-setup skill and the three surfaces
// that serve it — REST /skills, MCP get_skill (+ get_capabilities.skills), and
// the discovery map's quickstart pointer. The properties worth guarding are
// the ones a later edit could quietly drop: the skill states the five steps
// in order, names the four never-guess fields, refuses markup, restates the
// human gate, and is reachable from every surface a cold-start agent reads.

import { describe, it, expect, beforeEach, vi } from 'vitest'

// mcp-route pulls in the changeset commit path, which reaches partyserver
// (cloudflare:*) — stub it exactly as external-mcp.test.ts does.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { AGENT_SKILLS, getSkill } from '../../../db/shared/agent-skills'
import { handleExternalSkillsRequest } from '../external/skills-route'
import { handleExternalDiscoveryRequest } from '../external/discovery-route'
import { handleExternalMcpRequest } from '../external/mcp-route'
import { mintApiToken } from '../../../db/shared/api-credentials'
import { makeTestDb, type TestDb } from './helpers/pg-test-db'

const SECRET = 'test-secret'
const PROJECT = 'proj-a'
const CRED_1 = '00000000-0000-0000-0000-000000000001'

function makeEnv(db: AquillaDb) {
  return { AQUILLA_PG: db, SYNC_SECRET_KEY: SECRET, BASE_URL: 'https://aquilla.app' }
}

async function credToken(tdb: TestDb): Promise<string> {
  await tdb.pg.query(
    `INSERT INTO users (id, username, email, password_hash) VALUES (1, 'alice', 'alice@x.com', 'h')
     ON CONFLICT (id) DO NOTHING`,
  )
  const { token, tokenHash, tokenPrefix } = await mintApiToken()
  await tdb.pg.query(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id, project_id)
     VALUES ($1, '1', 'test', $2, $3, 'ask', NULL, NULL)`,
    [CRED_1, tokenPrefix, tokenHash],
  )
  return token
}

async function callTool(tdb: TestDb, token: string, name: string, args: Record<string, unknown>) {
  const res = await handleExternalMcpRequest(
    new Request('https://w/api/v1/external/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
    makeEnv(tdb.db),
  )
  const body = (await res!.json()) as { result: { content: { text: string }[]; isError?: boolean } }
  return { payload: JSON.parse(body.result.content[0].text), isError: body.result.isError === true }
}

let tdb: TestDb
beforeEach(async () => {
  tdb = await makeTestDb({
    projects: [{ id: PROJECT, name: 'Project A', created_by: 99, org_id: null }],
    project_members: [{ project_id: PROJECT, user_id: 1, role_level: 400 }],
  })
})

describe('the project-setup skill', () => {
  const skill = getSkill('project-setup')!

  it('exists, is indexed, and is non-trivial prose', () => {
    expect(AGENT_SKILLS.map((s) => s.name)).toEqual(['project-setup'])
    expect(skill.body.startsWith('# Skill:')).toBe(true)
    expect(skill.body.length).toBeGreaterThan(400)
    expect(skill.title.length).toBeGreaterThan(10)
    expect(skill.oneLiner.length).toBeGreaterThan(10)
    expect(getSkill('nope')).toBeNull()
  })

  it('sequences template → never-guess check → artifacts/preview → one ProjectSetup → receipt', () => {
    const order = ['/setup-template', '/setup-template/parse', 'sourceLanguage', 'kind: "ProjectSetup"', 'approvalUrl', 'briefReachesCopilot']
    let cursor = -1
    for (const marker of order) {
      const at = skill.body.indexOf(marker)
      expect(at, marker).toBeGreaterThan(cursor)
      cursor = at
    }
  })

  it('names the four never-guess fields and says to stop, not guess', () => {
    for (const f of ['settings.sourceLanguage', 'settings.targetLanguage', 'brief.parameters.sourceTexts', 'brief.parameters.keyTerms']) {
      expect(skill.body).toContain(f)
    }
    expect(skill.body).toContain('STOP')
    expect(skill.body).toContain('(defaulted)')
  })

  it('refuses markup as a parser problem and never hand-cleans; leaves the book intro alone', () => {
    expect(skill.body).toContain('REFUSE')
    expect(skill.body).toContain('parser problem')
    expect(skill.body).toContain('never hand-clean')
    expect(skill.body).toContain('importExcludeFrontMatter')
    expect(skill.body).toContain('untranslated')
  })

  it('requires an existing project and points at CreateProject for a new one', () => {
    expect(skill.body).toContain('EXISTING project')
    expect(skill.body).toContain('CreateProject')
  })

  it('reports briefReachesCopilot=false loudly and restates the human gate', () => {
    expect(skill.body).toContain('briefReachesCopilot is false')
    expect(skill.body).toContain('THE HUMAN GATE')
    expect(skill.body.toLowerCase()).toMatch(/stage[sd]?\b[\s\S]*applie[sd]/i)
  })
})

describe('GET /api/v1/external/skills', () => {
  it('serves the index and one skill, unauthenticated', async () => {
    const index = handleExternalSkillsRequest(new Request('https://w/api/v1/external/skills'))
    expect(index!.status).toBe(200)
    const indexBody = (await index!.json()) as { data: { name: string; title: string; oneLiner: string }[]; nextCursor: null }
    expect(indexBody.data.map((s) => s.name)).toEqual(['project-setup'])
    expect(indexBody.data[0].title.length).toBeGreaterThan(0)
    expect(indexBody.nextCursor).toBeNull()

    const detail = handleExternalSkillsRequest(new Request('https://w/api/v1/external/skills/project-setup'))
    expect(detail!.status).toBe(200)
    const detailBody = (await detail!.json()) as { name: string; title: string; body: string }
    expect(detailBody.name).toBe('project-setup')
    expect(detailBody.body).toBe(getSkill('project-setup')!.body)
  })

  it('404s an unknown skill naming the valid ones, 405s a non-GET, ignores unrelated paths', async () => {
    const unknown = handleExternalSkillsRequest(new Request('https://w/api/v1/external/skills/nope'))
    expect(unknown!.status).toBe(404)
    const body = (await unknown!.json()) as { error: { code: string; details: { availableSkills: string[] } } }
    expect(body.error.code).toBe('not_found')
    expect(body.error.details.availableSkills).toEqual(['project-setup'])

    const posted = handleExternalSkillsRequest(new Request('https://w/api/v1/external/skills', { method: 'POST' }))
    expect(posted!.status).toBe(405)
    expect(posted!.headers.get('Allow')).toBe('GET')

    expect(handleExternalSkillsRequest(new Request('https://w/api/v1/external/projects'))).toBeNull()
  })
})

describe('discovery map', () => {
  it('lists the skill + template endpoints and opens quickstart with the skill', async () => {
    const res = handleExternalDiscoveryRequest(new Request('https://w/api/v1/external'))
    const body = (await res!.json()) as { endpoints: Record<string, string>; quickstart: string[]; skills: { index: { name: string }[] } }
    for (const key of [
      'GET /api/v1/external/skills',
      'GET /api/v1/external/skills/:name',
      'GET /api/v1/external/setup-template',
      'POST /api/v1/external/setup-template/parse',
    ]) {
      expect(Object.keys(body.endpoints), key).toContain(key)
    }
    expect(body.quickstart[0]).toContain('/skills/project-setup')
    expect(body.quickstart[0]).toContain('ProjectSetup')
    expect(body.skills.index.map((s) => s.name)).toEqual(['project-setup'])
  })
})

describe('MCP get_skill + get_capabilities.skills', () => {
  it('get_capabilities publishes the skill index and quickstart step 0 points at it', async () => {
    const token = await credToken(tdb)
    const { payload, isError } = await callTool(tdb, token, 'get_capabilities', {})
    expect(isError).toBe(false)
    expect(payload.skills.tool).toBe('get_skill')
    expect(payload.skills.index).toEqual(
      AGENT_SKILLS.map((s) => ({ name: s.name, title: s.title, oneLiner: s.oneLiner })),
    )
    expect(payload.quickstart[0]).toContain('get_skill')
    expect(payload.quickstart[0]).toContain('project-setup')
  })

  it('get_skill returns the body; omitting name returns the index; unknown is not_found', async () => {
    const token = await credToken(tdb)
    const one = await callTool(tdb, token, 'get_skill', { name: 'project-setup' })
    expect(one.isError).toBe(false)
    expect(one.payload.body).toBe(getSkill('project-setup')!.body)

    const index = await callTool(tdb, token, 'get_skill', {})
    expect(index.isError).toBe(false)
    expect(index.payload.skills.map((s: { name: string }) => s.name)).toEqual(['project-setup'])

    const nope = await callTool(tdb, token, 'get_skill', { name: 'nope' })
    expect(nope.isError).toBe(true)
    expect(nope.payload.error.code).toBe('not_found')
    expect(nope.payload.error.details.availableSkills).toEqual(['project-setup'])
  })
})
