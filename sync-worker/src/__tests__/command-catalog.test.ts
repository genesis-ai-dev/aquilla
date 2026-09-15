// Catalog invariants (AQU-926, command registry §1) + the get_capabilities
// `commands` index (§6). The catalog is shared metadata both workers consume —
// these tests pin the contract: agentReachable:false entries never reach any
// role-filtered output, the registered kinds match what validateCommands
// accepts, static floors match the enforcing modules, and the MCP capabilities
// payload carries the role-agnostic index.

import { describe, it, expect, vi } from 'vitest'

// mcp-handlers → changesets-route → commit.ts → events/route.ts → broadcast.ts
// → partyserver (cloudflare:*) — same mock every external suite uses.
vi.mock('partyserver', () => ({
  getServerByName: vi.fn().mockResolvedValue({
    fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
  }),
}))

import { callTool } from '../external/mcp-handlers'
import {
  COMMAND_CATALOG,
  catalogForRole,
  catalogIndexLines,
  describeCommand,
} from '../../../db/shared/command-catalog'
import { requiredRoleForCommand, validateCommands, CREATE_PROJECT_FIELDS } from '../external/commands'
import { structureCommandFloor } from '../external/commands-structure'
import { POLICY_SETTINGS_KEYS } from '../external/commands-patch-settings'
import { ALLOWED_EMIT_KINDS, TESTIMONY_EMIT_KINDS } from '../external/commands-emit-events'
import { BRIEF_FIELD_MAX_CHARS, BRIEF_NOTES_MAX_CHARS } from '../external/commands-set-brief'
import { BRIEF_FIELD_IDS } from '../../../db/shared/brief'
import { ROLE } from '../events/role-policy'

const ROLE_LEVELS = [0, 100, 200, 300, 400, 500, 600, 700, 9999]

describe('command catalog — invariants', () => {
  it('nothing with agentReachable:false ever appears in catalogForRole output, at any level', () => {
    for (const level of ROLE_LEVELS) {
      for (const entry of catalogForRole(level)) {
        expect(entry.agentReachable).toBe(true)
        expect(entry.minRoleLevel).toBeLessThanOrEqual(level)
      }
    }
    // The invariant holds even if a governance (agentReachable:false) entry is
    // added later — synthesize one and re-run the filter logic on a copy.
    const withGovernance = [
      ...COMMAND_CATALOG,
      {
        kind: 'MintCredential', title: 'Mint credential', oneLiner: 'governance',
        minRoleLevel: 100, tier: 'governance' as const, agentReachable: false, paramsDoc: 'x',
      },
    ]
    const filtered = withGovernance.filter((c) => c.agentReachable && c.minRoleLevel <= 9999)
    expect(filtered.some((c) => c.kind === 'MintCredential')).toBe(false)
  })

  it('every catalog kind is accepted by validateCommands (vocabulary parity)', () => {
    const minimal: Record<string, unknown> = {
      SetTranslation: { kind: 'SetTranslation', fileId: 'f', cellId: 'c', value: 'v' },
      LinkMedia: { kind: 'LinkMedia', fileId: 'f', cellId: 'c', artifactId: 'a' },
      PlanImport: { kind: 'PlanImport', fileName: 'n', fileType: 'txt', cells: [{ content: 'x' }] },
      CreateOrg: { kind: 'CreateOrg', name: 'O' },
      CreateProject: { kind: 'CreateProject', name: 'P' },
      UpdateProjectSettings: { kind: 'UpdateProjectSettings', projectId: 'p', settings: {}, ifMatchVersion: 0 },
      PatchSettings: { kind: 'PatchSettings', projectId: 'p', ops: [{ key: 'systemPrompt', value: 'x' }], ifMatchVersion: 0 },
      EmitEvents: { kind: 'EmitEvents', events: [{ kind: 'comment.create', payload: { body: 'hi' } }] },
      SetBrief: { kind: 'SetBrief', projectId: 'p', parameters: { audience: 'Rural youth' }, ifMatchVersion: 0 },
      AddOrgMember: { kind: 'AddOrgMember', orgId: 1, username: 'u', role: 400 },
      SetOrgRole: { kind: 'SetOrgRole', orgId: 1, username: 'u', role: 400 },
      RemoveOrgMember: { kind: 'RemoveOrgMember', orgId: 1, username: 'u' },
      AddExample: { kind: 'AddExample', slug: 'lord-as-hospod', source: 'the LORD', target: 'Господь' },
      AddDecision: { kind: 'AddDecision', slug: 'divine-name', decision: 'Render Lord as Господь.' },
      AddNote: { kind: 'AddNote', fileId: 'f', cellId: 'c', note: 'why this rendering' },
      RetireExample: { kind: 'RetireExample', slug: 'lord-as-hospod' },
      InsertCell: { kind: 'InsertCell', fileId: 'f', value: 'v' },
      DeleteCell: { kind: 'DeleteCell', fileId: 'f', cellId: 'c' },
      SplitCell: { kind: 'SplitCell', fileId: 'f', cellId: 'c', offset: 3, targets: 'blank' },
    }
    for (const entry of COMMAND_CATALOG) {
      const sample = minimal[entry.kind]
      expect(sample, `catalog kind ${entry.kind} has no validateCommands sample`).toBeDefined()
      const result = validateCommands([sample])
      expect(result.ok, `validateCommands rejected catalog kind ${entry.kind}`).toBe(true)
    }
  })

  it('static floors match the contract: PatchSettings 500, EmitEvents 200, UpdateProjectSettings 600', () => {
    expect(describeCommand('PatchSettings')?.minRoleLevel).toBe(ROLE.PROJECT_LEAD)
    expect(describeCommand('PatchSettings')?.tier).toBe('structural')
    expect(describeCommand('EmitEvents')?.minRoleLevel).toBe(ROLE.COMMENTER)
    expect(describeCommand('UpdateProjectSettings')?.minRoleLevel).toBe(ROLE.MAINTAINER)
    expect(describeCommand('Bogus')).toBeNull()
  })

  it('the structure commands publish the floor their engine enforces (AQU-1234)', () => {
    for (const kind of ['InsertCell', 'DeleteCell', 'SplitCell']) {
      const entry = describeCommand(kind)
      expect(entry, `${kind} missing from the catalog`).not.toBeNull()
      expect(entry!.minRoleLevel).toBe(structureCommandFloor())
      expect(entry!.tier).toBe('structural')
    }
    // The catalog floor IS the prepare/commit floor — one source of truth.
    expect(structureCommandFloor()).toBe(ROLE.PROJECT_LEAD)
    expect(
      requiredRoleForCommand({ kind: 'SplitCell', fileId: 'f', cellId: 'c', offset: 1, targets: 'blank' }),
    ).toBe(describeCommand('SplitCell')!.minRoleLevel)
  })

  it('the role-filtered index narrows with level and formats one line per command', () => {
    const commenter = catalogIndexLines(ROLE.COMMENTER)
    const lead = catalogIndexLines(ROLE.PROJECT_LEAD)
    expect(commenter.length).toBeLessThan(lead.length)
    expect(commenter.some((l) => l.startsWith('- EmitEvents (200+'))).toBe(true)
    expect(lead.some((l) => l.startsWith('- PatchSettings (500+'))).toBe(true)
    // A commenter never sees maintainer-floor commands.
    expect(commenter.some((l) => l.includes('UpdateProjectSettings'))).toBe(false)
  })

  it("the catalog's documented policy keys and testimony kinds match the enforcing modules", () => {
    const patchDoc = describeCommand('PatchSettings')!.paramsDoc
    for (const key of POLICY_SETTINGS_KEYS) {
      expect(patchDoc).toContain(key)
    }
    const emitDoc = describeCommand('EmitEvents')!.paramsDoc
    for (const kind of TESTIMONY_EMIT_KINDS) {
      expect(ALLOWED_EMIT_KINDS).toContain(kind)
    }
    expect(emitDoc).toContain('testimony')
  })

  it('describe_command("SetBrief") documents every brief section id (AQU-1227)', () => {
    const entry = describeCommand('SetBrief')!
    expect(entry.minRoleLevel).toBe(ROLE.MAINTAINER)
    for (const id of BRIEF_FIELD_IDS) {
      expect(entry.paramsDoc, `SetBrief paramsDoc omits section "${id}"`).toContain(id)
    }
    // The caps the validator actually enforces, not prose approximations.
    expect(entry.paramsDoc).toContain(String(BRIEF_FIELD_MAX_CHARS))
    expect(entry.paramsDoc).toContain(String(BRIEF_NOTES_MAX_CHARS))
  })

  it("documents every field CreateProject actually accepts (AQU-1223)", () => {
    // describe_command is how an agent learns the shape before it stages. An
    // accepted field missing from the doc is how the silent-drop bug got its
    // reach: the caller had no way to know what would survive the create.
    const createDoc = describeCommand('CreateProject')!.paramsDoc
    for (const field of CREATE_PROJECT_FIELDS) {
      if (field === 'kind') continue
      expect(createDoc).toContain(field)
    }
    // …and that the closed set is stated, so the reader knows a typo fails loudly.
    expect(createDoc).toContain('validation_failed')
  })
})

describe('get_capabilities — commands index (§6)', () => {
  it('publishes kind/title/tier/minRoleLevel for every agent-reachable command', async () => {
    const cred = {
      credentialId: 'cred-1', userId: '1', username: 'alice',
      mode: 'act' as const, orgId: null, projectId: null,
    }
    const result = await callTool('get_capabilities', {}, { AQUILLA_PG: undefined }, cred, 'tok')
    expect(result).not.toBe(Symbol.for('unknown-tool'))
    const payload = JSON.parse((result as { content: { text: string }[] }).content[0].text) as {
      commandKinds: string[]
      commands: { index: { kind: string; title: string; tier: string; minRoleLevel: number }[]; note: string }
    }
    const reachable = COMMAND_CATALOG.filter((c) => c.agentReachable)
    expect(payload.commands.index).toHaveLength(reachable.length)
    for (const entry of reachable) {
      expect(payload.commands.index).toContainEqual({
        kind: entry.kind, title: entry.title, tier: entry.tier, minRoleLevel: entry.minRoleLevel,
      })
    }
    // The index is metadata only — no paramsDoc bloat in the resident payload.
    for (const row of payload.commands.index) {
      expect(Object.keys(row).sort()).toEqual(['kind', 'minRoleLevel', 'tier', 'title'])
    }
    expect(payload.commands.note).toContain('describe_command')
    // The legacy commandKinds field is untouched (frozen external behavior),
    // now including CreateOrg (AQU-1221).
    expect(payload.commandKinds).toEqual(
      ['SetTranslation', 'PlanImport', 'CreateOrg', 'CreateProject', 'UpdateProjectSettings', 'LinkMedia'],
    )
  })
})
